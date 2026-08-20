#!/usr/bin/env ruby
# frozen_string_literal: true

# summarize-token-usage-week.rb -- per-model summary of one WEEK of
# pa-token-usage rows, plus a day-by-day trend.
#
#   ruby summarize-token-usage-week.rb                # most recent week on file
#   ruby summarize-token-usage-week.rb 2026-W32       # a specific ISO week
#   ruby summarize-token-usage-week.rb 2026-08-05     # the week containing a day
#
# Companion to summarize-token-usage.rb (one day) and
# summarize-token-usage-month.rb (one calendar month). Same host tool, same data
# dir, same columns -- it just folds the seven day files of one ISO-8601 week
# (Monday..Sunday) into one set of groups.
#
# Like its siblings this is a HOST tool and is not baked into the image: it
# lives at the repo root, which no COPY in the Dockerfile touches.

require "csv"
require "date"

DATA_DIR = File.join(
  ENV["PI_CODING_AGENT_DIR"] || File.join(Dir.home, ".pi", "agent"),
  "extensions", "pa-token-usage", "token-usage"
)

if ARGV.any? { |a| %w[-h --help help].include?(a) }
  puts <<~USAGE
    summarize-token-usage-week.rb -- per-model summary of one week of rows.

    Usage:
      ruby summarize-token-usage-week.rb               most recent week on file
      ruby summarize-token-usage-week.rb 2026-W32      a specific ISO week
      ruby summarize-token-usage-week.rb 2026-08-05    week containing that day
      ruby summarize-token-usage-week.rb --help        this message

    Weeks are ISO-8601: Monday through Sunday, numbered by the week that holds
    the year's first Thursday. So 2026-W01 can begin in December 2025.

    Reading from:
      #{DATA_DIR}
      (override with PI_CODING_AGENT_DIR)

    Prints two tables: totals per model for the whole week, and one row per day
    so you can see where the spend actually went.

    Columns:
      reqs      responses logged
      in        raw prompt tokens NOT served from cache. Routinely ~2 on
                anthropic-oauth: almost the whole prompt arrives as cache rd/wr.
      cache rd  prompt tokens served from cache (roughly 10x cheaper)
      cache wr  prompt tokens written into the cache
      out       generated tokens
      cache%    cache rd / (in + cache rd + cache wr) -- the number to watch
                if you are trying to cut spend
      $         metered API pricing. On an OAuth subscription you are not
                billed per token, so treat it as "what this would have cost".
      tok/cent  tokens per cent spent; "-" when nothing was billed, which is
                normal for local models and subscription billing.
  USAGE
  exit 0
end

DAY_FILE = /\A(\d{4}-\d{2}-\d{2})\.csv\z/

def day_files(dir)
  Dir.glob(File.join(dir, "*.csv")).select { |f| File.basename(f) =~ DAY_FILE }
end

def day_of(path)
  File.basename(path, ".csv")
end

# ISO week label for a date, e.g. "2026-W32". cwyear, not year: the first days
# of January can belong to the last week of the previous ISO year.
def week_key(date)
  format("%04d-W%02d", date.cwyear, date.cweek)
end

# Monday of the ISO week identified by "YYYY-Www". Date.commercial handles the
# year-boundary arithmetic; a week number the year does not have raises.
def monday_of_week(year, week)
  Date.commercial(year, week, 1)
rescue Date::Error
  abort "no ISO week #{format('W%02d', week)} in #{year}"
end

files = day_files(DATA_DIR)
abort "no token-usage logs in #{DATA_DIR}" if files.empty?

arg = ARGV[0]
monday =
  case arg
  when nil
    # Newest day on file, which is not necessarily today's -- take its week.
    Date.iso8601(day_of(files.max_by { |f| day_of(f) })).then { |d| d - (d.cwday - 1) }
  when /\A(\d{4})-[Ww](\d{1,2})\z/
    monday_of_week(Regexp.last_match(1).to_i, Regexp.last_match(2).to_i)
  when /\A\d{4}-\d{2}-\d{2}\z/
    begin
      d = Date.iso8601(arg)
    rescue Date::Error
      abort "not a real date: #{arg}"
    end
    d - (d.cwday - 1)
  else
    abort "expected a week like 2026-W32 or a day like 2026-08-05, got: #{arg}"
  end

week_days = (0..6).map { |i| (monday + i).to_s }
week = week_key(monday)
week_files = week_days.map { |d| File.join(DATA_DIR, "#{d}.csv") }.select { |f| File.exist?(f) }
abort "no logs for #{week} (#{week_days.first}..#{week_days.last}) in #{DATA_DIR}" if week_files.empty?

FIELDS = %w[tokens_in tokens_cache_read tokens_cache_write tokens_out
            tokens_total cost_total bytes_in bytes_out].freeze

def blank_group
  { "count" => 0 }.merge(FIELDS.to_h { |f| [f, 0.0] })
end

def add!(group, row)
  group["count"] += 1
  FIELDS.each { |f| group[f] += row[f].to_f }
end

by_model = Hash.new { |h, k| h[k] = blank_group }
by_day   = Hash.new { |h, k| h[k] = blank_group }
session_ids = {}

# Rows are appended concurrently by several containers, so a torn final line is
# conceivable if something writes a row over PIPE_BUF. Skip anything malformed
# rather than dying on a whole day's file -- and skip an unreadable day rather
# than dying on the whole week.
week_files.each do |path|
  day = day_of(path)
  begin
    rows = CSV.read(path, headers: true).reject { |r| r["ts_iso"].to_s.empty? }
  rescue CSV::MalformedCSVError => e
    warn "skipping #{day}: #{e.message}"
    next
  end

  rows.each do |r|
    key =
      if r["model"].to_s.empty?
        r["kind"].to_s.empty? ? "(unknown)" : r["kind"]
      else
        "#{r['provider']}/#{r['model']}"
      end
    add!(by_model[key], r)
    add!(by_day[day], r)
    sid = r["session_id"].to_s
    session_ids[sid] = true unless sid.empty?
  end
end

abort "no rows for #{week}" if by_model.empty?

total = blank_group
by_model.each_value do |g|
  total["count"] += g["count"]
  FIELDS.each { |f| total[f] += g[f] }
end

def commafy(num)
  int = num.round.to_s
  int.reverse.scan(/\d{1,3}/).join(",").reverse
end

# Tokens bought per cent spent. Blank when nothing was billed (local models and
# subscription providers report cost 0) -- same rule the extension uses.
def per_cent(tokens, cost)
  cost.positive? ? commafy(tokens / (cost * 100)) : "-"
end

# Share of the billable input that came from cache instead of being re-read.
def cache_rate(g)
  denom = g["tokens_in"] + g["tokens_cache_read"] + g["tokens_cache_write"]
  denom.positive? ? format("%.1f%%", 100.0 * g["tokens_cache_read"] / denom) : "-"
end

def to_row(name, g)
  [
    name,
    commafy(g["count"]),
    commafy(g["tokens_in"]),
    commafy(g["tokens_cache_read"]),
    commafy(g["tokens_cache_write"]),
    commafy(g["tokens_out"]),
    commafy(g["tokens_total"]),
    cache_rate(g),
    format("%.4f", g["cost_total"]),
    per_cent(g["tokens_total"], g["cost_total"])
  ]
end

# Right-align everything but the label column, and rule off the header and the
# final TOTAL row.
def print_table(head, body)
  table = [head] + body
  widths = head.each_index.map { |i| table.map { |r| r[i].length }.max }

  table.each_with_index do |row, idx|
    puts row.each_with_index.map { |cell, i|
      i.zero? ? cell.ljust(widths[i]) : cell.rjust(widths[i])
    }.join("  ")
    puts widths.map { |w| "-" * w }.join("  ") if idx.zero? || idx == table.size - 2
  end
end

days_with_data = by_day.size

puts "#{week}  #{week_days.first}..#{week_days.last}  " \
     "(#{days_with_data} day#{'s' unless days_with_data == 1} with data, #{DATA_DIR})"
puts

model_body = by_model.sort_by { |_, g| -g["cost_total"] }.map { |name, g| to_row(name, g) }
model_body << to_row("TOTAL", total)
print_table(["model", "reqs", "in", "cache rd", "cache wr", "out", "total", "cache%", "$", "tok/cent"], model_body)

puts
# Every day of the week gets a row, including the quiet ones -- a zero row is
# information, and an absent row looks like a bug.
day_body = week_days.map { |d| to_row("#{d} #{Date.iso8601(d).strftime('%a')}", by_day[d]) }
day_body << to_row("TOTAL", total)
print_table(["day", "reqs", "in", "cache rd", "cache wr", "out", "total", "cache%", "$", "tok/cent"], day_body)

puts
puts "bytes in #{commafy(total['bytes_in'])}  /  bytes out #{commafy(total['bytes_out'])}"
puts "sessions #{commafy(session_ids.size)}  /  " \
     "avg $/day #{format('%.4f', total['cost_total'] / days_with_data)}"
