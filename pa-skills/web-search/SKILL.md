---
name: web-search
description: >-
  Search the web and read pages reliably from the pa sandbox using the
  stealth_browse tool, then follow promising links a few hops deep to actually
  find the answer. Use whenever the user asks you to look something up online,
  research a topic, find an article/docs/news, check a fact on the web, or when
  a plain fetch returns a bot-block (403/429/503) or a page that does not
  contain the answer. Covers link collection (extract="a" extract_attr="href"),
  ranking candidate links by their anchor text, and bounded breadth-first
  crawling so you don't wander aimlessly.
---

# web-search

Reliable web research from the pa sandbox. The sandbox IP gets bot-blocked by
Reddit, Cloudflare-fronted sites, and search engines when using a plain
headless browser, so **always use the `stealth_browse` tool** (from the
`pa-stealth-browse` extension) instead of ad-hoc Playwright or `curl`.

## Core idea: collect links, then follow the hopeful ones

A single page rarely contains the full answer. The winning loop is:

1. **Fetch** the page (and its text).
2. **Collect links** on that page as `(anchor text, absolute URL)` pairs.
3. **Rank** links by how promising their anchor text / URL looks for the goal.
4. **Follow** the top few, a bounded number of hops, until the answer appears.

Anchor text is the single most useful signal for deciding where to go next.
Never follow raw URLs blind — read their text first.

## The stealth_browse tool

Key parameters:

- `url` — page to fetch (http/https).
- `extract` — CSS selector; returns innerText of each match.
- `extract_attr` — attribute to also return per match. **Use `"href"` with
  `extract="a"` to collect links** (returns resolved absolute URLs).
- `scroll` / `scroll_wait_ms` — scroll passes for lazy/infinite-scroll feeds
  (Reddit, Twitter mirrors). Start with `scroll=5` for feeds.
- `wait_ms` — extra settle time for JS-heavy pages (try `3000`+).
- `max_attempts` — retry-with-backoff on blocks (default 4; leave as-is).
- `max_chars` — cap returned page text (default 8000).

The tool already masks the automation fingerprint and retries transient blocks,
so a `blocked: true` result means it genuinely could not get through.

### Collect links from a page

```
stealth_browse url="https://example.com/topic" extract="a" extract_attr="href"
```

You get a numbered list of `text` + `[href] URL`. That is your candidate set.

To narrow to real content links, prefer selectors that target the content
region when you know it (e.g. `article a`, `main a`, `h2 a`, `.post a`), which
cuts nav/footer/login noise before you even rank.

## The research loop (bounded BFS)

Follow this procedure. **Bound it** so you don't crawl forever.

1. **Seed.** Pick 1–3 starting URLs.
   - Have a specific site? Start there.
   - Need to discover sources? Start from a search results page you can read.
     DuckDuckGo HTML (`https://duckduckgo.com/html/?q=...`) and Bing sometimes
     work via stealth_browse; if a search engine returns a block or strips
     links, go directly to a likely authoritative site or a topic hub/index
     page instead.

2. **Read + collect.** For each page:
   - Read the page text. **If it already answers the question, stop and
     report** — cite the URL.
   - If not, collect links (`extract="a" extract_attr="href"`).

3. **Rank candidates.** Score each `(text, url)` by relevance to the goal:
   - anchor text contains the key terms of the question → high
   - URL path looks like an article/story/doc (`/article/`, `/story/`,
     `/blog/`, dated slugs, `/docs/`) → boost
   - obvious non-content (login, signup, privacy, terms, share, `mailto:`,
     external social profiles, tag/category indexes) → drop
   - already visited → drop

4. **Follow.** Visit the top **2–3** ranked links. Repeat from step 2.

5. **Stop conditions (respect all of these):**
   - Answer found → report it. **Always cite the exact URL(s).**
   - **Depth limit: 3 hops** from a seed.
   - **Budget limit: ~8–10 total page fetches** for a normal query. If you hit
     the budget without an answer, report what you found, the best leads, and
     say the answer wasn't confirmed. Do not silently keep going.
   - Two consecutive pages add no new relevant links → back up and try the next
     best unexplored candidate, or a different seed.

Keep a short running list of **visited URLs** and **unexplored good
candidates** so you can backtrack instead of looping.

## Reporting

- Lead with the answer.
- **Cite every claim with the URL it came from.** If synthesized from several
  pages, list them.
- If blocked or inconclusive, say so plainly and list the best leads you found.

## Gotchas

- **Don't override the `Accept` header** manually anywhere — some sites (Reddit)
  serve a stripped 3-item fallback. stealth_browse already avoids this.
- Feeds (Reddit, mirrors) need `scroll` to load more than the first handful of
  items.
- `extract` returns **innerText**; only `extract_attr` returns URLs. To harvest
  links you MUST pass `extract_attr="href"`.
- Datacenter/consumer-IP blocks are per-site rate limits — if `blocked: true`
  persists after retries, try a different source rather than hammering.
- Prefer content-scoped selectors (`article a`, `main a`) over bare `a` to
  reduce nav/boilerplate noise in the candidate set.
