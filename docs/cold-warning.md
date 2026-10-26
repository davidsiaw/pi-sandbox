# Cold-context warning

The `pa-cold-warning` extension warns you before you pay to re-warm a big
Claude context you walked away from.

## The problem

Anthropic prompt caches expire after 5 minutes (1 hour with
`PI_CACHE_RETENTION=long`). pi's own cache warmer keeps the cache alive for at
most 30 idle minutes, and only with `cacheWarming: "idle"`. The default
(`"streaming"`) stops warming as soon as the agent settles. The first prompt
after the cache expires re-writes the **whole** context at 1.25× the input price
(2× for the 1-hour tier). Cache reads cost 0.1×
([pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).

Measured on this repo's own sessions: 11 cold restores were ~9% of total spend.
The worst was 320k tokens re-written after a 20-minute break: $2.00 for one
message.

## What it does

When you send a prompt and the last cache touch (the last assistant reply, or a
pi `cache_warm` ping) is older than the TTL, a dialog shows how long you were
idle and the estimated restore cost, and offers:

- **Restore full context**: pay it and carry on.
- **Cancel**: your text goes back into the editor, so you can `/compact`,
  `/new`, or switch model first.

Only Claude models (provider or id mentions `claude`/`anthropic`), only
interactive input, only when the context is ≥ 40k tokens and the restore would
cost ≥ $0.10.

The cost is an estimate: last response's prompt + output tokens × the model's
`cacheWrite` rate (or `input` if unset).

## Config

| Env | Default | |
|-----|---------|--|
| `PA_COLD_WARNING=off` | on | disable entirely |
| `PA_COLD_WARNING_MIN_TOKENS` | `40000` | below this a restore is cheap; do nothing |

## History

An earlier version also wrote a handoff summary shortly before the cache
expired (replaying the exact cached prefix so it was a 0.1× cache read) and
offered to compact onto it when you came back. It did not work reliably in
practice and was removed; only the warning remains.

## Files

| Path | |
|------|--|
| `pa-extensions/pa-cold-warning/index.ts` | the extension |
| `pa-extensions/pa-cold-warning/selftest.mjs` | auth-free guard, run by `smoketest.sh` |
