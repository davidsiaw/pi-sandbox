# Reading videos: the `video` skill

No tool, just a skill plus two binaries. `yt-dlp` downloads the video (or only
its subtitles), `ffmpeg` cuts frames and **contact sheets** out of it, and the
agent `read`s the images. Skill source: `pa-skills/video/` (baked to
`/opt/pa/skills/video/`).

| piece | where | installed by |
|---|---|---|
| `yt-dlp` | `/usr/local/bin/yt-dlp`, config `/etc/yt-dlp.conf` | `scripts/install-yt-dlp.sh` |
| `ffmpeg`, `ffprobe` | Debian package | `scripts/install-ffmpeg.sh` |
| `contact-sheet.sh` | `/opt/pa/skills/video/` | skill helper |
| `vtt2txt.sh` | `/opt/pa/skills/video/` | skill helper |

## Why not page_console

A browser on a video page shows you one frame. Often it isn't even that: you
get a consent wall, a pre-roll ad or a spinner. Scrubbing through a video with
screenshots costs a tool call per frame and you can't choose which frame you
get. Downloading the file and asking ffmpeg for exact timestamps fixes both
problems.

## The loop

**metadata → transcript → overview → zoom**:

1. `yt-dlp --skip-download -O ...`: title, duration, **chapters**, description.
2. Subtitles (`--write-subs --write-auto-subs --skip-download`) → `vtt2txt.sh`.
   Text costs much less than images, so get it first.
3. Video-only download at ≤720p (≤1080p if on-screen text is small), or just a
   time range with `--download-sections '*12:30-15:00'`.
4. `contact-sheet.sh`: a 4x4 grid of 320 px tiles, each with its timestamp
   burned in. One `read` shows 16 moments. The default spacing fits the whole
   video on one sheet.
5. `ffmpeg -ss <ts> -i video -frames:v 1 frame.png` for a full-size frame of
   anything that needs reading.

The skill has the exact commands, the failure table and what to report.

## Design notes

- **Standalone yt-dlp binary.** The image has no system Python. The
  PyInstaller build bundles its own interpreter **and** `yt-dlp-ejs`, the
  YouTube challenge-solver scripts
  ([EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)).
- **Node as the JS runtime.** YouTube needs an external JS runtime. yt-dlp
  enables only deno by default and supports node ≥ 22 via `--js-runtimes`. The
  image already has node 22 at `/usr/bin/node`, so `/etc/yt-dlp.conf` says
  `--js-runtimes node:/usr/bin/node`. The path is absolute so that a project's
  mise `node` shim (possibly older) can't shadow it.
- **yt-dlp is unpinned and installed low in the Dockerfile**, below the pi
  install. YouTube changes break old yt-dlp releases within weeks. pi changes
  on nearly every build, so this placement re-fetches the current yt-dlp on
  each image build instead of reusing a stale cached layer. The binary is
  checked against the release's `SHA2-256SUMS`. Pin with
  `YTDLP_VERSION=<tag> sh build.sh`. If it goes stale between builds, the skill
  tells the agent to fetch the current release into `/tmp` (`/usr/local/bin`
  is read-only).
- **Debian ffmpeg, not a static build.** Same reasoning as poppler: one apt
  line, both architectures, security updates. About 175 MB of libraries on top
  of the image (measured on trixie arm64, `--no-install-recommends`). It sits
  in its own layer at the end of the third-party section, so adding it
  invalidated nothing above it. `drawtext` (the tile timestamps) uses
  `fonts-dejavu`, which is already baked.
- **No speech-to-text.** There is no whisper or similar in the image. Without
  subtitles, the agent can only report what is visible on screen. The skill
  tells it to say so rather than guess.

## Limits

- YouTube may gate a datacenter IP or a video ("Sign in to confirm you're not a
  bot", age-gated videos). The fix is a user-supplied `cookies.txt` passed with
  `--cookies`; the agent must never ask for a password. In testing from the
  sandbox, YouTube metadata, subtitles, full downloads and section downloads
  all worked without cookies.
- DRM-protected streams can't be downloaded.
- A scene-change `select` that matches zero frames makes ffmpeg fail with an
  mjpeg encoder error. That means "no cuts above the threshold", not a broken
  install.

## Tests

`smoketest.sh` checks `ffmpeg`/`ffprobe`/`yt-dlp` are on PATH and runs an
offline pipeline:

1. Build a lavfi test clip.
2. Run yt-dlp `-v` on it via `file://`. This asserts the config loaded node as
   the JS runtime and yt-dlp found ffmpeg.
3. Run `contact-sheet.sh` and check it writes a sheet.
4. Run `vtt2txt.sh` on a sample and check it collapses rolling-caption
   duplicates.

The one thing it can't prove offline is that YouTube itself still works with the
baked version.
