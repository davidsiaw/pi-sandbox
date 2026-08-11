/**
 * selftest.mjs — guard for pa-cloakbrowser's output handling.
 *
 * It does NOT launch CloakBrowser (a real fetch needs the network and is not a
 * unit test). It guards the two things that silently blow up a conversation:
 *
 *   1. `--dump-dom` output being returned WHOLE. A real page is 200-500 KB of
 *      markup; before this, all of it went straight into the context window.
 *      Now the complete output goes to a cache file and only a bounded preview
 *      is returned. The cache layer itself is covered by pa-yousoro-browse's
 *      selftest (same module); here we assert the preview/cache CONTRACT holds
 *      for a document the size cloak_browse actually produces.
 *   2. htmlToText collapsing newlines. The old markdown path did
 *      `.replace(/\s+/g, " ")`, producing ONE line of several hundred KB — which
 *      makes the cache file useless: `rg` reports a single unusable match and
 *      `read offset=` has nothing to index.
 *
 * htmlToText is regex-extracted from index.ts rather than imported, the same
 * trick pa-yousoro-browse uses: index.ts imports typebox, which is not resolvable
 * outside the image. The helper is self-contained, so evaluating it is enough.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");

let failures = 0;
function check(name, ok, detail) {
	if (ok) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// --- rendering: htmlToMarkdown / htmlToText -------------------------------
// Imported, not scraped: ../_shared/html-to-markdown.ts is a plain module with
// no browser or typebox dependency, so there is nothing to work around.
const R = await import(join(here, "..", "_shared", "html-to-markdown.ts"));

const HTML = `<!doctype html><html><head><title>T</title>
<style>body{color:red}</style><script>var x = "<p>not text</p>";</script></head>
<body><h1>Heading &amp; more</h1><p>First   para with a <a href="/docs?a=1">doc link</a>, <strong>bold</strong>, <code>x_y</code> and <a href="#Frag">an anchor</a>.</p>
<ul><li>one</li><li><a href="https://ex.org/two">two</a></li></ul>
<blockquote><p>quoted</p></blockquote>
<pre><code>def f(x)
  x * 2
end</code></pre>
<table><tr><th>lang</th><th>year</th></tr><tr><td>Ruby</td><td>1995</td></tr></table>
<p><a href="javascript:void(0)">js link</a> <img alt="pic" src="/i.png"> <img src="/spacer.gif"></p>
<div><div><div><span>nested</span></div></div></div>
<p>line<br>broken</p><!-- a comment --></body></html>`;
const BASE = "https://site.test/page?q=1";

{
	const md = R.htmlToMarkdown(HTML, BASE);
	check("markdown keeps headings", md.includes("# Heading & more"), md.split("\n")[0]);
	check("markdown carries link URLs (the whole point)", md.includes("[doc link](https://site.test/docs?a=1)"), md);
	check("markdown resolves relative hrefs against the page URL", !md.includes("](/docs"));
	check("markdown shortens same-document anchors", md.includes("[an anchor](#Frag)"), md);
	check("markdown drops javascript: targets, keeps the label", md.includes("js link") && !md.includes("javascript:"));
	check("markdown emits tight bullets", /- one\n- \[two\]/.test(md), md);
	check("markdown renders a real table with a separator", md.includes("| lang | year |") && md.includes("| --- | --- |"), md);
	check("markdown quotes blockquotes", md.includes("> quoted"));
	// Fences are restored AFTER tidying; tidying first would eat the indent.
	check("markdown fences code and KEEPS its indentation", md.includes("```\ndef f(x)\n  x * 2\nend\n```"), JSON.stringify(md));
	check("markdown keeps code spans literal", md.includes("`x_y`"));
	check("markdown keeps described images, drops decorative ones", md.includes("![pic](https://site.test/i.png)") && !md.includes("spacer.gif"));
	check("markdown re-joins punctuation left stranded by dropped tags", !/ ,/.test(md), md);
	check("markdown drops script/style/comment bodies", !md.includes("var x") && !md.includes("color:red") && !md.includes("a comment"));
	check("markdown leaves no tags behind", !/<[a-z/][^>]*>/i.test(md), md);
	// Outside code fences, where indentation is the point, no line should start
	// with the space a dropped opening tag leaves behind.
	const unfenced = md.replace(/```[\s\S]*?```/g, "");
	check("markdown lines are not left-padded by dropped tags", !/^ /m.test(unfenced), JSON.stringify(unfenced.slice(0, 120)));
}

{
	// Old sites lay pages out with NESTED tables (Hacker News, list archives).
	// Rendering those as tables duplicates every cell into giant pipe-rows; and a
	// single non-greedy regex pairs the outer <table> with the inner </table>,
	// mangling both. Innermost-first passes + a data-table heuristic fix it.
	const layout = `<table><tr><td><table><tr><td>header cell</td></tr></table></td></tr>
<tr><td><p>story <a href="https://ex.org/1">one</a></p></td></tr></table>`;
	const md = R.htmlToMarkdown(layout, BASE);
	check("layout tables are not rendered as tables", !md.includes("| --- |"), md);
	check("layout table content survives", md.includes("header cell") && md.includes("[one](https://ex.org/1)"), md);
	check("nested layout tables do not duplicate their cells", md.split("header cell").length - 1 === 1, md);
	check("no stray table tags survive the nesting", !/<\/?table/i.test(md), md);

	// A real data table still renders as one.
	const data = `<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>`;
	check("data tables still render as pipe tables", R.htmlToMarkdown(data, BASE).includes("| --- | --- |"));
}

{
	const text = R.htmlToText(HTML);
	const lines = text.split("\n");
	check("htmlToText keeps line structure (not one giant line)", lines.length > 4, `${lines.length} lines`);
	check("htmlToText drops script/style/comments", !text.includes("var x") && !text.includes("color:red") && !text.includes("a comment"));
	check("htmlToText keeps visible text", text.includes("Heading") && text.includes("nested"));
	check("htmlToText decodes entities", text.includes("Heading & more"), text);
	check("htmlToText turns <br> into a newline", /line\nbroken/.test(text), JSON.stringify(text));
	check("htmlToText emits no markup syntax", !text.includes("](") && !/<[a-z/][^>]*>/i.test(text));
	check("htmlToText collapses runs of blank lines", !text.includes("\n\n\n") && !text.startsWith("\n") && !text.endsWith("\n"));
}

// --- preview + cache contract on a dump-dom-sized document -----------------
const C = await import(join(here, "..", "_shared", "cache.ts"));

{
	// ~175 KB of markup, the order of magnitude --dump-dom really returns.
	const big = `${Array.from({ length: 8000 }, (_, i) => `<p>paragraph ${i + 1}</p>`).join("\n")}\n<p>LAST-LINE-MARKER</p>`;
	check("test fixture is dump-dom sized", big.length > 150000, `${big.length} chars`);

	const preview = C.truncateHead(big, 8000);
	check("preview is bounded by max_chars", preview.content.length <= 8000);
	check("preview reports the true total", preview.totalChars === big.length);
	check("preview omits the tail", !preview.content.includes("LAST-LINE-MARKER"));

	const dir = mkdtempSync(join(tmpdir(), "pa-cloak-selftest-"));
	try {
		const rawDoc = `<html><body>${big}<p>RAW-ONLY-MARKER</p></body></html>`;
		const info = C.writeCache(dir, "https://www.example.com/x", {
			text: big,
			textLabel: "PAGE MARKDOWN",
			rawHtml: rawDoc,
		});
		const onDisk = readFileSync(info.path, "utf8");
		check("cache labels the body by what it actually is", onDisk.startsWith("=== PAGE MARKDOWN ==="), onDisk.slice(0, 40));

		// The two-file contract: rendered body in .txt, raw DOM in a sibling .html
		// with the SAME stem, so the pair is obviously a pair in /tmp.
		check("raw DOM goes to a sibling .html file", info.rawPath === info.path.replace(/\.txt$/, ".html"), String(info.rawPath));
		check("raw file holds the untouched markup", readFileSync(info.rawPath, "utf8") === rawDoc);
		check("raw file is not folded into the greppable body", !onDisk.includes("RAW-ONLY-MARKER"));
		check("raw size is reported for the footer", info.rawBytes === Buffer.byteLength(rawDoc, "utf8"), String(info.rawBytes));

		const footer = C.formatCacheFooter(info, { truncated: true });
		check("footer names both files", footer.includes(info.path) && footer.includes(info.rawPath), footer);
		check("footer points at the raw file when rendering looks wrong", /raw HTML/i.test(footer), footer);

		const noRaw = C.writeCache(dir, "https://www.example.com/y", { text: "x" });
		check("no raw file when none was supplied", noRaw.rawPath === undefined);
		check("footer omits the raw line when there is no raw file", !/Raw HTML:/.test(C.formatCacheFooter(noRaw, { truncated: false })));
		check("cache holds the tail the preview dropped", onDisk.includes("LAST-LINE-MARKER"));
		const [start, end] = info.pageTextRange;
		const fileLines = onDisk.split("\n");
		check("reported range indexes the real first line", fileLines[start - 1] === "<p>paragraph 1</p>", fileLines[start - 1]);
		check("reported range indexes the real last line", fileLines[end - 1] === "<p>LAST-LINE-MARKER</p>", fileLines[end - 1]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- the wiring in index.ts itself ----------------------------------------
{
	check("index.ts defaults to markdown, not raw HTML", /params\.format \?\? "markdown"/.test(src), );
	check("index.ts renders via the shared converters", /htmlToMarkdown\(raw, params\.url\)/.test(src));
	check("index.ts caches every successful fetch", /writeCache\(tmpdir\(\)/.test(src));
	check("index.ts always keeps the raw DOM too", /rawHtml: raw/.test(src));
	check("index.ts previews with truncateHead", /truncateHead\(result, params\.max_chars/.test(src));
	check("index.ts uses the shared footer (identical to yousoro_browse)", /formatCacheFooter\(cache/.test(src));
	check("index.ts still degrades when the cache write fails", /formatCacheFailure\(cacheError\)/.test(src));

	// --dump-dom exits 0 whatever it was served, so without this a Cloudflare
	// interstitial came back looking exactly like the article.
	check("index.ts detects challenge/CAPTCHA pages", /looksChallenge\(titleOf\(raw\), readable\)/.test(src));
	check("a blocked page is reported as an error", /isError: blocked/.test(src));
	check("detection reads the RENDERED text, never raw markup", /const readable = format === "html" \? htmlToText\(raw\) : result;/.test(src));
	check("blocked text says cloak is the last resort, not to retry", /nothing further to/.test(src) && /different source/.test(src));
	check("spawn logic is shared with pa-yousoro-browse", /from "\.\.\/_shared\/cloak\.ts"/.test(src));
}

if (failures > 0) {
	console.error(`selftest: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("selftest: all checks passed");
