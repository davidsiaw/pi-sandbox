# Token usage logging

The `pa-token-usage` extension appends one CSV row per model response, so you
can see where tokens and money actually went across every session and every
container.

## Where things live

| Path | Role |
|------|------|
| `pa-extensions/pa-token-usage/index.ts` | the extension (baked read-only to `/opt/pa`) |
| `pa-extensions/pa-token-usage/selftest.mjs` | auth-free guard, run by `smoketest.sh` |
| `summarize-token-usage.rb` | per-day report — a **host** tool, at the repo root |
| `~/.pi/agent/extensions/pa-token-usage/token-usage/YYYY-MM-DD.csv` | **the data** |

The data directory is deliberately **not** next to the code. `/opt/pa` is
root-owned, read-only, and lives in the container layer, so anything written
there is unwritable at runtime and destroyed on exit. The `pa` launcher already
bind-mounts `~/.pi/agent/extensions` read-write from the host:

```bash
-v "$PI_HOME/agent/extensions:/home/agent/.pi/agent/extensions"
```

so the extension writes there instead. **No launcher change is required.**

That directory contains no `index.ts`, so pi's auto-discovery of subdirectory
extensions skips it. Do not add one: the launcher already loads the baked copy
from `/opt/pa`, and a second copy would log every request twice.

## Columns

```
ts_iso, session_id, kind, provider, model, response_model, stop_reason,
tokens_in, tokens_cache_read, tokens_cache_write, tokens_out, tokens_reasoning,
tokens_total, cost_input, cost_cache_read, cost_cache_write, cost_output,
cost_total, tokens_per_cent, bytes_in, bytes_out
```

- `kind` is `assistant` for a normal response, or `tool:<name>` for a nested LLM
  call made by a tool (e.g. `inspect_image` calling a vision model). Pi accounts
  for those separately, so they get their own row. Provider/model are blank
  there because the nested call does not report them.
- **The four token counters are raw, exactly as the provider reported them.**
  On `anthropic-oauth`, `tokens_in` is routinely `2` — that is not a bug. Almost
  the entire prompt arrives as `tokens_cache_read` / `tokens_cache_write`. Sum
  all three to get the real input size.
- `tokens_per_cent` is `tokens_total / (cost_total × 100)`. It is **blank** when
  `cost_total` is 0, which is the normal case for local models (`m5-max`,
  `llama-cpp`) and for subscription billing. Blank rather than `Infinity` so the
  column stays numeric.
- `bytes_out` is the exact serialized response content. `bytes_in` is an
  **approximation**: pi never exposes the serialized request, so the extension
  re-serializes the active context (compaction applied) as the closest stand-in.
  Treat it as indicative, not authoritative.

## Concurrency

Every container bind-mounts the *same* host directory, so several agents append
to one file at once. Each row is written with a single `fs.appendFileSync`
(`O_APPEND`). POSIX guarantees a single `write()` under `PIPE_BUF` (4096 bytes)
to an `O_APPEND` descriptor is atomic on a local filesystem; rows here are ~200
bytes. So writers interleave whole rows and never tear or lose one. There is no
read-modify-write and no lock.

The header is created with flag `wx`, and `EEXIST` is ignored — the same race,
resolved the same way. `selftest.mjs` asserts this with 8 concurrent processes
writing 40 rows each.

Writing failures never break a turn: the first one warns via `ctx.ui.notify` and
the rest are silent.

## Reading the log

`summarize-token-usage.rb` lives at the repo root, not in `pa-extensions/`, so
it is never copied into the image. It is a user tool: run it on the host with
your own ruby.

```bash
ruby summarize-token-usage.rb                # most recent day on file
ruby summarize-token-usage.rb 2026-08-05     # a specific day
ruby summarize-token-usage.rb path/to.csv    # an explicit file
ruby summarize-token-usage.rb --help        # usage + column meanings
```

With no arguments it reports the **newest log present**, not today's — so it
still shows something useful on a day you have not run the agent. Files whose
names are not `YYYY-MM-DD.csv` are ignored.

It needs no arguments: the launcher mounts the log directory from the host, so
`~/.pi/agent/extensions/pa-token-usage/token-usage/` is the same set of files
inside the container and out. Set `PI_CODING_AGENT_DIR` to read a different
agent dir.

To run it *inside* a sandbox instead, install ruby first — none is baked:

```bash
mise use -g ruby@3.4.10
```

```
2026-08-05  (/home/agent/.pi/agent/extensions/pa-token-usage/token-usage/2026-08-05.csv)

model                            reqs     in  cache rd  cache wr    out   total  cache%       $  tok/cent
-------------------------------  ----  -----  --------  --------  -----  ------  ------  ------  --------
anthropic-oauth/claude-opus-5       3      6    20,520    12,989  1,032  34,547   61.2%  0.1173     2,946
m5-max/Qwen3.6-27B-oQ6-fp16-mtp     1    417     6,144         0     51   6,612   93.6%  0.0000         -
tool:inspect_image                  1  1,200         0         0     40   1,240    0.0%  0.0000         -
-------------------------------  ----  -----  --------  --------  -----  ------  ------  ------  --------
TOTAL                               5  1,623    26,664    12,989  1,123  42,399   64.6%  0.1173     3,615

bytes in 2,120  /  bytes out 741
```

`cache%` is the share of billable input served from cache
(`cache_read / (in + cache_read + cache_write)`) — the number to watch if you
are trying to cut spend, since cache reads are roughly 10× cheaper than fresh
input on Anthropic.
