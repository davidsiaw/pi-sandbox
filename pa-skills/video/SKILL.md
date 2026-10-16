---
name: video
description: >-
  Watch / read a video in the pa sandbox: a YouTube (or any yt-dlp-supported)
  link or a local video file. Gets metadata and chapters, the transcript from
  subtitles, and timestamped contact sheets of frames you can `read`, using
  yt-dlp + ffmpeg. Use whenever asked what a video says or shows, to summarise
  a talk, find the moment something happens, or read on-screen text/code from a
  video. Do NOT play it in page_console / screenshot_url. 以 yt-dlp、ffmpeg 觀視頻。
---

# video — watch a video with yt-dlp + ffmpeg

A browser on a video page shows one frame, often an ad or a consent wall.
Download instead and let ffmpeg pick exact moments. Helpers live next to this
file:

| helper | does |
|---|---|
| `/opt/pa/skills/video/contact-sheet.sh <video> [outdir=sheets] [interval_s=auto] [cols=4] [rows=4]` | 320 px tiles with the timestamp burned in, tiled into `outdir/sheet_NNN.jpg`; `auto` spaces frames so the whole input fits on one sheet. Prints the sheet paths |
| `/opt/pa/skills/video/vtt2txt.sh [-t] <file.vtt>` | subtitles → plain text, rolling-caption duplicates collapsed; `-t` prefixes `[hh:mm:ss]` |

Work in a scratch dir (`d=$(mktemp -d); cd "$d"`). Videos are large; never put
them in the user's project.

## The loop: metadata → transcript → overview → zoom

Go in this order and stop as soon as you can answer. Text is far cheaper than
images.

**1. Metadata** (no download):

```bash
yt-dlp --skip-download -O "%(title)s | %(uploader)s | %(duration_string)s | %(upload_date)s" \
  -O "%(chapters)j" -O "%(description)s" "$URL"
```

Chapters (`null` if none) tell you where to zoom later.

**2. Transcript.** Check what exists, then fetch it:

```bash
yt-dlp --list-subs "$URL"          # manual subs beat auto-generated ones
yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs "en.*,en" \
  --sub-format vtt -o "subs.%(ext)s" "$URL"
/opt/pa/skills/video/vtt2txt.sh -t subs.en.vtt > transcript.txt   # or whichever subs.*.vtt landed
wc -l transcript.txt
```

For another language, use its code in `--sub-langs`. For a long transcript,
`rg` it for the topic rather than reading it all. The `-t` timestamps are what
you zoom to in step 4.

**3. Overview.** Download the video only (no audio) at ≤720p. Use ≤1080p when
you need to read small on-screen text such as code or slides:

```bash
yt-dlp -f "bv*[height<=720]/b[height<=720]/bv*/b" -o "video.%(ext)s" "$URL"
# or only a time range (much faster on long videos):
yt-dlp -f "bv*[height<=720]/b[height<=720]" --download-sections "*12:30-15:00" -o "part.%(ext)s" "$URL"
/opt/pa/skills/video/contact-sheet.sh video.* sheets
```

`read` the sheet, which shows 16 moments. On a long video those are far apart,
so make more sheets over a range rather than one huge sheet: pass an interval,
e.g. `contact-sheet.sh video.mp4 sheets 30` for one frame every 30 s.
Timestamps on a section download start at 0, not at the section start; add the
offset yourself.

**4. Zoom** to a full-size frame for anything you have to read:

```bash
ffmpeg -v error -ss 00:12:41 -i video.mp4 -frames:v 1 frame.png
```

Then `read frame.png`. To find cuts or slide changes, sheet the scene changes:

```bash
ffmpeg -v error -i video.mp4 -vf "select='gt(scene,0.3)',scale=320:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf:text='%{pts\:hms}':x=4:y=4:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x4" \
  -fps_mode passthrough scenes_%03d.jpg
```

Local file instead of a URL? Skip yt-dlp and start at step 3 with
`contact-sheet.sh`. Use `ffprobe -v error -show_format -show_streams file` for
metadata, and `ffmpeg -i file -map 0:s:0 subs.vtt` if it has embedded subs.

## When it fails

| symptom | meaning / fix |
|---|---|
| `Sign in to confirm you're not a bot`, age-gated, members-only | YouTube is gating this IP or video. Ask the user for a `cookies.txt` export and pass `--cookies cookies.txt`. **Never ask for a password.** |
| `nsig extraction failed`, `Requested format is not available` for everything, odd 403s on a video that plays in a browser | The baked yt-dlp is stale. `/usr/local/bin` is read-only, so fetch the current release to `/tmp`: `curl -fsSL -o /tmp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux` (`yt-dlp_linux_aarch64` on arm64; check `dpkg --print-architecture`), `chmod +x /tmp/yt-dlp`, then retry with `/tmp/yt-dlp`. Mention it so the image gets rebuilt |
| `No supported JavaScript runtime` | `/etc/yt-dlp.conf` was bypassed (`--ignore-config`?). Add `--js-runtimes node:/usr/bin/node` |
| `--list-subs` shows nothing | No subtitles exist. There is **no speech-to-text** here, so report only what is on screen and say that the audio was not transcribed. Don't guess at the speech |
| scene `select` fails with an mjpeg encoder error | No frame passed the threshold, so there are no cuts above it. Lower it (`0.15`) or use `contact-sheet.sh` |
| DRM error | DRM-protected streams can't be downloaded. Say so |

## What to report

- What the video is (title, channel, length) and what you based the answer on:
  transcript, frames, or both. If there was no transcript, say so.
- Timestamps (`12:41`) for every claim about a specific moment, so the user can
  check.
- Quote on-screen text only from a full-size frame you actually read, not from
  a 320 px tile.
