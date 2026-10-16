#!/usr/bin/env bash
# vtt2txt.sh [-t] <file.vtt>
#
# WebVTT subtitles -> plain text, one caption line per line. Drops the header,
# cue timings, NOTE/STYLE/REGION blocks and inline tags (<c>, <00:01.000>...),
# decodes common entities, and collapses the duplicates that YouTube's rolling
# auto-captions produce. -t prefixes each line with its cue start [hh:mm:ss].
set -euo pipefail

ts=0
if [ "${1:-}" = "-t" ]; then ts=1; shift; fi
if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
[ -f "$1" ] || { echo "vtt2txt: no such file: $1" >&2; exit 1; }

awk -v ts="$ts" '
  { sub(/\r$/, "") }
  NR == 1 { inhdr = 1 }                        # WEBVTT line + header block
  inhdr  { if ($0 == "") inhdr = 0; next }
  skip   { if ($0 == "") skip = 0; next }      # inside NOTE/STYLE/REGION
  /^(NOTE|STYLE|REGION)([ \t]|$)/ { skip = 1; next }
  /-->/  { start = substr($1, 1, length($1) - 4); if (start !~ /^[0-9]+:[0-9]+:/) start = "00:" start
           incue = 1; next }
  $0 == "" { incue = 0; next }
  !incue { next }                              # cue identifiers, stray text
  {
    gsub(/<[^>]*>/, "")
    gsub(/&nbsp;/, " "); gsub(/&lt;/, "<"); gsub(/&gt;/, ">")
    gsub(/&quot;/, "\""); gsub(/&#39;/, "\047"); gsub(/&amp;/, "\\&")
    gsub(/[ \t]+/, " "); sub(/^ /, ""); sub(/ $/, "")
    if ($0 == "" || $0 == last) next
    last = $0
    print (ts ? "[" start "] " : "") $0
  }
' "$1"
