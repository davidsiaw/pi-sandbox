# Context windows from the server (`pa-server-context`)

pi takes the `contextWindow` of a `models.json` model as written, or 128000 when
it is left out, and never asks the server. A local server, though, decides the
context when it loads a model (from the GPU and whatever else is using it), so
the number in `models.json` goes stale, and pi compacts too late (the request
fails for being too long) or too early (context wasted).

Servers already say what the context is: each model's entry at the
OpenAI-standard `GET /v1/models` carries it, under the field of the server's
convention. `pa-server-context` reads it.

| Field | Servers |
|---|---|
| `meta.n_ctx` | llama.cpp's llama-server, and servers modelled on it (LMD, tqserve) |
| `max_model_len` | vLLM, SGLang, omlx |
| `context_length` | OpenRouter's catalog field, used by several gateways |
| `meta.n_ctx_train` | llama.cpp's trained context, when none of the above is there |

## Setup

None. Every provider declared in `models.json` is asked; a `contextWindow` there
is only used when its server does not report one (or does not answer).

## How it works

- **Which entry.** The one with the model's id. Failing that, when the server
  serves exactly one model, that one: a single-model server may name its model
  differently from `models.json`, but can only mean that one. A model its server
  does not report keeps what `models.json` says.
- **When.** Every `models.json` provider at session start; the current model's
  provider again before each prompt and when a model is selected, so a server
  that reloads with another context is followed. pi's built-in providers are
  never asked: their catalog already knows.
- **How.** It re-registers the provider (`pi.registerProvider`) with its models
  as declared and the reported contexts, `maxTokens` capped at them, and only when
  a context changed. pi then refreshes the current model, so compaction and the
  context gauge follow at once. It drops its own registration first each time, so
  the models start from `models.json` as it is now and edits still apply. The
  request carries the provider's own API key and headers.
- **Failures** never reach the turn: a server that does not answer within 3 s,
  or answers something else, changes nothing. A server that is off can delay the
  start of a session by those 3 s.

## Tests

`pa-extensions/pa-server-context/selftest.mjs` drives the real handlers against
loopback servers answering in the llama.cpp, vLLM and OpenRouter conventions, a
one-model server, and one that is down; the smoketest runs it.
