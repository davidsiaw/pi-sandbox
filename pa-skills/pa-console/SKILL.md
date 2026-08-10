---
name: pa-console
description: >-
  How to drive and debug a live web page with the page_console /
  page_screenshot / page_close tools in the pa sandbox. Read this BEFORE using
  them: it covers the REPL loop, the traps that silently waste a debugging
  session, and recipes. Trigger when reproducing "I click this and X happens",
  finding why a button does nothing, reading JS errors from a localhost app,
  driving a UI and inspecting the result, or screenshotting post-interaction
  state. 以 page_console 驅動網頁、讀其 console。
---

# pa-console — live page REPL

Three tools, backed by one live headless Chromium page:

| tool | what it does |
|---|---|
| `page_console(url?, script?, width?, height?, settle_ms?)` | open / drive / drain the live page |
| `page_screenshot(path?, full_page?, selector?)` | PNG of its **current** state |
| `page_close()` | release the browser (idempotent) |

Plus `/page-status` and `/page-close` for the human.

## When to use this instead of the other browsing tools

| situation | tool |
|---|---|
| "click this, **then** look" | **`page_console`** |
| read the text of a web page | `yousoro_browse` |
| photograph a URL as it first loads | `screenshot_url` |
| photograph a page **after** you interacted with it | **`page_screenshot`** |

`screenshot_url` and `yousoro_browse` reload from scratch every call, so they
can only ever show the *initial* state. If the bug needs a click first, they
cannot express it.

## The loop

```
page_console(url="http://localhost:3000/")        # 1. open
page_console(script="document.querySelector('#pay').click()")   # 2. drive
page_console()                                     # 3. drain late output
page_screenshot(path="state.png")                  # 4. (optional) look
page_close()                                       # 5. release
```

Call arguments are all optional and compose:

- `url` only — throw the old page away entirely (**including cookies and
  localStorage**) and load fresh.
- `script` only — run JS in the page already open.
- both — fresh load, then run.
- **neither — just drain.** This is how you collect errors that fired after your
  last call returned.

## Reading the stream

```
     0ms  nav                       GET http://localhost:3000/  200
    17ms  log      /app.js:1        [app] mounted
   333ms  agent                     [agent] clicked Pay
   335ms  http                      POST /api/pay  500
   335ms  error    /api/pay:1       Failed to load resource: … 500
   745ms  uncaught /app.js:5        Cannot read properties of undefined (reading 'id')
                                    at http://localhost:3000/app.js:5:32
```

| kind | meaning |
|---|---|
| `nav` | navigation + HTTP status |
| `agent` | console output from **your injected script** |
| `log` `warn` `error` `info` `debug` | the page's own console output |
| `uncaught` | a thrown exception (never goes through the console API) |
| `http` | a 4xx/5xx response — often the real cause of "nothing happened" |
| `neterr` | request failed at the network layer |
| `script` | **your snippet** failed (bad selector, typo) — not a page bug |
| `return` | your snippet's return value |

Times are ms since the page loaded, and they include your own thinking time
between calls. What matters is the **spacing between rows in one drain**, not
the absolute number.

## Rules that will bite you

**1. REPL state lives on `window`.**

```js
page_console(script: "window.n = 41")     // ✅ survives to the next call
page_console(script: "const n = 41")      // ❌ gone; each eval is its own scope
page_console(script: "return window.n")   // → 41
```

**2. Never log a DOM node.** `console.log(el)` reports `JSHandle@node` and tells
you nothing. Log a serialisable summary:

```js
console.log(el.outerHTML.slice(0, 200))
console.log(el.className, el.getBoundingClientRect().toJSON())
```

Objects arrive as DevTools' flat preview (`{id: 7, items: Array(2)}`), one level
deep. If you need the contents, `return` the value instead of logging it — the
`return` row is JSON.

**3. In-page clicks are untrusted.** `el.click()` produces
`event.isTrusted === false`, exactly as it would if you typed it into DevTools.
Fine for almost everything; if a library specifically checks `isTrusted`, this
route cannot reproduce it.

**4. A `script` row is your bug, not the page's.** It means your snippet threw —
usually a selector that matched nothing. The rows above it normally explain why
(e.g. the element renders only after a fetch that returned 500).

**5. Errors that fire later are not lost.** They land in the buffer and appear on
your next call. If you clicked something and the stream looks clean, do
something else and then call `page_console()` with no arguments before
concluding it works.

## Element geometry: query the DOM, don't detect it

For a page you control, do **not** screenshot and run `detect_ui_elements`. Ask
the DOM — it is exact, includes text and ids, and costs no vision call:

```js
page_console(script: `return [...document.querySelectorAll('button')]
  .filter(e => e.offsetParent !== null)          // visible only
  .map(e => ({ id: e.id, text: e.innerText, ...e.getBoundingClientRect().toJSON() }))`)
```

Use `page_screenshot` + `detect_ui_elements` only when you need to see
**rendering** — overlap, clipping, CSS the DOM cannot describe.

## Recipes

**Reproduce "I click X and nothing happens"**

```js
page_console(url: "http://localhost:3000/")
page_console(script: "console.log('[agent] clicking'); document.querySelector('#pay').click()")
// then, after doing something else:
page_console()
```

Watch for an `http` row: a 500 is the most common answer, and it appears in the
same stream as the JS error it causes.

**Instrument the app and re-run.** Add `console.log` to the app source, then
re-issue the *same* calls. Your logs appear inline, in true order, next to the
page's errors — that interleaving is the point of the tool.

**Check what the user actually sees**

```js
page_console(script: "return { count: document.querySelector('#count').textContent, err: document.querySelector('.error')?.innerText ?? null }")
```

**Verify a fix didn't just move the crash.** After fixing, click again, wait, and
drain with no arguments. A fix that turns a synchronous error into a delayed one
looks identical until you drain.

## Housekeeping

Call `page_close()` when you are done. An idle headless Chromium holds roughly
350 MB for the rest of the session. It is safe to call at any time, including
when nothing is open, and it flushes any undrained log to a file first, so
closing never destroys evidence.

If a call reports **"No page is open"**, open one with `url=` first — the page
may have crashed, or `page_close` may already have run.

The browser is also closed automatically when the pi session ends.
