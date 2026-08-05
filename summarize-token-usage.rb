#!/usr/bin/env ruby
# frozen_string_literal: true

# summarize-token-usage.rb -- per-model summary of one day of pa-token-usage rows.
#
#   ruby summarize-token-usage.rb                # most recent day on file
#   ruby summarize-token-usage.rb 2026-08-05     # a specific day
#   ruby summarize-token-usage.rb path/to.csv    # an explicit file
#
# This is a HOST tool and is deliberately not baked into the image: it lives at
# the repo root, which no COPY in the Dockerfile touches. Run it on your machine
# with your own ruby.
#
# It needs no arguments because the pa launcher mounts the log directory from
# the host at the same path the extension writes to inside the container:
#   -v "$PI_HOME/agent/extensions:/home/agent/.pi/agent/extensions"
# so ~/.pi/agent/extensions/pa-token-usage/token-usage/ resolves to the same
# files on either side. To read a different agent dir, set PI_CODING_AGENT_DIR.

require "csv"

DATA_DIR = File.join(
  ENV["PI_CODING_AGENT_DIR"] || File.join(Dir.home, ".pi", "agent"),
  "extensions", "pa-token-usage", "token-usage"
)

if ARGV.any? { |a| %w[-h --help help].include?(a) }
  puts <<~USAGE
    summarize-token-usage.rb -- per-model summary of one day of pa-token-usage rows.

    Usage:
      ruby summarize-token-usage.rb                 most recent day on file
      ruby summarize-token-usage.rb 2026-08-05      a specific day
      ruby summarize-token-usage.rb path/to.csv     an explicit file
      ruby summarize-token-usage.rb --help          this message

    Reading from:
      #{DATA_DIR}
      (override with PI_CODING_AGENT_DIR)

    Logs are written by the pa-token-usage extension, one row per model
    response. The directory is bind-mounted by the pa launcher, so the same
    files are visible on the host and inside every sandbox.

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

# Newest log on file, which is not necessarily today's -- you may not have run
# the agent today. ISO-8601 names sort lexicographically in date order, so a
# plain max over the basenames is the newest day.
def latest_log(dir)
  Dir.glob(File.join(dir, "*.csv"))
     .select { |f| File.basename(f) =~ /\A\d{4}-\d{2}-\d{2}\.csv\z/ }
     .max_by { |f| File.basename(f) }
end

arg = ARGV[0]
path =
  if arg.nil?
    latest_log(DATA_DIR) || abort("no token-usage logs in #{DATA_DIR}")
  elsif arg =~ /\A\d{4}-\d{2}-\d{2}\z/
    File.join(DATA_DIR, "#{arg}.csv")
  else
    arg
  end

abort "no such file: #{path}" unless File.exist?(path)

FIELDS = %w[tokens_in tokens_cache_read tokens_cache_write tokens_out
            tokens_total cost_total bytes_in bytes_out].freeze

# Rows are appended concurrently by several containers, so a torn final line is
# conceivable if something writes a row over PIPE_BUF. Skip anything malformed
# rather than dying on the whole day's file.
rows = CSV.read(path, headers: true).reject { |r| r["ts_iso"].to_s.empty? }
abort "no rows in #{path}" if rows.empty?

groups = Hash.new { |h, k| h[k] = { "count" => 0 }.merge(FIELDS.to_h { |f| [f, 0.0] }) }

rows.each do |r|
  key =
    if r["model"].to_s.empty?
      r["kind"].to_s.empty? ? "(unknown)" : r["kind"]
    else
      "#{r['provider']}/#{r['model']}"
    end
  g = groups[key]
  g["count"] += 1
  FIELDS.each { |f| g[f] += r[f].to_f }
end

total = { "count" => 0 }.merge(FIELDS.to_h { |f| [f, 0.0] })
groups.each_value do |g|
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

HEAD = ["model", "reqs", "in", "cache rd", "cache wr", "out", "total", "cache%", "$", "tok/cent"].freeze

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

body = groups.sort_by { |_, g| -g["cost_total"] }.map { |name, g| to_row(name, g) }
body << to_row("TOTAL", total)

table = [HEAD] + body
widths = HEAD.each_index.map { |i| table.map { |r| r[i].length }.max }

puts "#{File.basename(path, '.csv')}  (#{path})"
puts

table.each_with_index do |row, idx|
  line = row.each_with_index.map { |cell, i|
    i.zero? ? cell.ljust(widths[i]) : cell.rjust(widths[i])
  }.join("  ")
  puts line
  puts widths.map { |w| "-" * w }.join("  ") if idx.zero? || idx == table.size - 2
end

puts
puts "bytes in #{commafy(total['bytes_in'])}  /  bytes out #{commafy(total['bytes_out'])}"
