# Live page REPL (`pa-console`)

The image bakes a `pa-console` extension that registers three tools and two
commands for driving **one live browser page** and reading its console:

| | |
|---|---|
| `page_console(url?, script?)` | open / drive / drain the live page |
| `page_screenshot(path?)` | capture its **current** state |
| `page_close()` | release the browser early |
| `/page-status`, `/page-close` | human visibility into a forgotten browser |

- Extension source: `pa-extensions/pa-console/`
- Baked at `/opt/pa/extensions/pa-console`, loaded additively by `pa`
  (see [usage.md](usage.md#baked-skills--extensions)).
- **Usage guidance lives in the `pa-console` skill**
  (`pa-skills/pa-console/SKILL.md`), not in the tool descriptions — see
  [Where the how-to lives](#where-the-how-to-lives) below.
- Playwright is **not** bundled; it resolves the global install at
  `/usr/lib/node_modules/playwright` with browsers at `/opt/ms-playwright`.

## Why it exists next to `screenshot_url` and `yousoro_browse`

Those tools are one-shot: launch, load, read, close. Neither can express
**"click this, *then* look"**, which is the shape of nearly every real bug
report — *"I press Pay and nothing happens"*. A fresh load can only ever show
the initial state.

`pa-console` keeps the page open across tool calls, so an agent can drive it and
then inspect the consequences. Three things follow, and they are the whole point:

1. **Late errors are not missed.** Events arriving *between* tool calls are still
   captured. Measured: an error thrown from a `setTimeout` 2 seconds after the
   triggering call landed in the buffer and was delivered on the next call. This
   is why there is no `settle_ms`-style guess to get wrong.
2. **Iteration without reloading.** Poke, read, poke again, against one page.
3. **Post-interaction screenshots** — impossible with `screenshot_url`.

## What it is equivalent to

Opening the page in Chrome and typing into the DevTools console. Verified
equivalences: same JS realm, same DOM, same globals; top-level `await` works;
return values come back; and the message text is literally DevTools' preview
string (`console.log('cart =', {id:7, items:[1,2]})` → `cart = {id: 7, items:
Array(2)}`).

Four measured differences:

| | DevTools | `page_console` |
|---|---|---|
| Interaction | REPL, state persists | one live page, but each call is a separate eval |
| Profile | your cookies/logins/extensions | fresh, empty |
| Objects | expandable tree | flat preview, one level deep |
| DOM nodes | inspectable | **`JSHandle@node`** |

Two consequences worth internalising:

- **REPL state must live on `window`.** `window.n = 41` reads back on the next
  call; a top-level `const` does not (each eval is its own function scope —
  that scope is what provides top-level `await`).
- **Never log a DOM node.** `console.log(el)` reports `JSHandle@node`. Log
  `el.outerHTML.slice(0,200)` or `el.className` instead.

## The output stream

One chronological stream per call, containing only what is new since the last
one. Everything shares it — the agent's own `console.log`, the page's logging,
uncaught exceptions, and failed requests — because grouping by kind is exactly
what destroys the causality that makes it readable.

```
     0ms  nav                       GET http://127.0.0.1:8123/  200
    17ms  log      /app.js:1        [app] mounted
   333ms  agent                     [agent] clicked Pay
   335ms  http                      POST /api/pay  500
   335ms  error    /api/pay:1       Failed to load resource: … 500 (Internal Server Error)
   745ms  uncaught /app.js:5        Cannot read properties of undefined (reading 'id')
                                    at http://127.0.0.1:8123/app.js:5:32
```

Kinds:

| kind | meaning |
|---|---|
| `nav` | navigation, with HTTP status |
| `agent` | console output from **your injected script** |
| `log` `warn` `error` `info` `debug` | the page's own console output |
| `uncaught` | a thrown exception (never passes through the console API) |
| `http` | a 4xx/5xx response — usually the real cause of "nothing happened" |
| `neterr` | request failed at the network layer |
| `script` | **your snippet** failed (bad selector, typo) |
| `return` | the snippet's return value |

Three deliberate details:

- **Times are suffixed `ms`.** A bare `402` in the leading column reads just as
  easily as a line number, an index or a status code.
- **`agent` rows are detected, not tagged.** Injected script has no source URL;
  the page's own code does. No marker convention to remember.
- **`script` is not counted as an error.** Your broken selector is not evidence
  about the page, and counting it would send an agent hunting a bug that does
  not exist.

### The 0-based line-number fix

Playwright reports a console message's location as a **0-based** line
([`line`](https://playwright.dev/docs/api/class-consolemessage#console-message-location),
with `lineNumber` deprecated). Stack frames on `uncaught` rows are 1-based, and
so is every editor. Reported raw, a `console.log` on line 1 of `app.js` showed
`:0` while an exception on line 5 of the same file showed `:5` — an off-by-one
in the one field whose job is to point at a line of code. `sourceRef()` adds 1.

## Element positions: query the DOM, don't detect them

For a page you control, `detect_ui_elements` is the wrong tool. Measured on the
same button:

| | DOM via `page_console` | `detect_ui_elements` |
|---|---|---|
| box | `256,85,101,42` (exact) | `255,84,106,44` (conf 0.83) |
| identity | `id="pay"`, text `"Pay now"` | class `Unknown`, no text |
| cost | one tool call | ML pass + a vision call to read any region |

```js
page_console(script: `return [...document.querySelectorAll('button')]
  .map(e => ({ id: e.id, text: e.innerText, ...e.getBoundingClientRect().toJSON() }))`)
```

Reach for `page_screenshot` + `detect_ui_elements` only when you need to see
**rendering** — overlap, clipping, CSS the DOM cannot describe.

## Lifecycle and shutdown

The browser is launched **lazily**, inside the tool, never in the extension
factory: pi is explicit that factories may run in invocations that never start a
session, so background resources must not start there.

- `page_console(url=…)` closes the whole **context**, not just the page, so
  cookies and localStorage go too — "fresh" has to mean fresh. The **browser
  process is reused**, keeping a reload at ~100ms.
- `page_close()` is idempotent and flushes any undrained log to a file first, so
  closing never destroys evidence.
- `pi.on("session_shutdown")` is the backstop; it fires on
  `quit | reload | new | resume | fork`.

Why bother with an explicit close: an idle headless Chromium on `about:blank`
was measured holding **~357 MB RSS**. It is *not* a safety mechanism —
`SIGKILL`ing the owning node process was measured to take every Chromium process
with it, so nothing can run away. It is an early-release valve.

One sandbox-specific note: PID 1 in this image is `pi`, which does not reap
orphans, so each browser launch leaves `<defunct>` entries behind. They hold a
PID slot, not RAM. Reusing one browser across pages keeps the count down.

## No fingerprint masking, deliberately

Unlike `screenshot_url` and `yousoro_browse`, this tool does **not** use
`_shared/stealth.ts`. It targets pages the agent itself wrote, on localhost,
where masking is pure overhead and the "is this a bot-block?" heuristic could
fire on a page that merely contains the word *blocked*.

## Where the how-to lives

Tool `description` and `promptGuidelines` sit in the system prompt of **every**
session, whether or not a browser is ever opened. A skill body is loaded only
when the model decides the task matches. So the split is:

| | contents |
|---|---|
| tool description + guidelines | *when* to reach for the tool, and a pointer |
| `pa-skills/pa-console/SKILL.md` | *how* to use it: the REPL loop, the `window` rule, `JSHandle@node`, DOM geometry vs `detect_ui_elements`, recipes, troubleshooting |

Measured, always-resident prompt text:

| | before | after |
|---|---|---|
| tool descriptions | 1095 | 947 |
| promptGuidelines | 1443 (12 bullets) | 671 (4 bullets) |
| skill description | — | 478 |
| **total** | **2538** | **2096** |

A 442-character saving, and the detailed guidance grew from 1443 always-resident
characters to a 6.8KB body available on demand. Note the skill *description* is
also always-resident — a verbose one cancels the whole exercise out. The first
draft of it was 923 characters, which made the change a net **+3**.

If you find yourself adding a third guideline bullet to a tool here, it belongs
in the skill instead.

## Guard

`pa-extensions/pa-console/selftest.mjs` (run by `smoketest.sh`) covers the
formatting helpers and, more importantly, the live-page properties that break
silently: injected-vs-page output being distinguishable, `window` state
surviving between evals while a top-level `const` does not, a bad selector
rejecting caller-side instead of masquerading as a page error, a re-open
dropping previous state, and — the one that matters most — **a delayed error
still being captured after the call that triggered it returned**. A regression
there would make the tool report "no errors" for a page that is still broken.
