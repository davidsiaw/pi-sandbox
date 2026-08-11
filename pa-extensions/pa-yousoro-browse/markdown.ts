/**
 * pa-yousoro-browse/markdown.ts — DOM → Markdown, run INSIDE the page.
 *
 * WHY THIS EXISTS
 * `document.body.innerText` is flat: headings, list nesting and — the expensive
 * omission — link URLs are all gone. An agent reading a search-results page or
 * an article in innerText can see that a link exists but not where it points,
 * so it has to re-fetch with extract="a" extract_attr="href" and then re-align
 * two lists by hand. Markdown carries `[text](url)` inline, so one fetch answers
 * both "what does it say" and "where do I go next".
 *
 * WHY IN THE PAGE, NOT IN NODE
 * Three reasons, in order of importance:
 *   1. VISIBILITY. Only the live page knows what is actually rendered.
 *      `Element.checkVisibility()` drops `display:none` menus, collapsed
 *      accordions and off-screen cookie banners — the bulk of the junk in a
 *      naive HTML-to-markdown conversion. A string of HTML in Node cannot tell
 *      a rendered nav from a hidden one.
 *   2. It is the DOM we already have: post-JS, post-`scroll`, post-challenge.
 *      Re-serialising with page.content() and re-parsing would be strictly
 *      more work for a worse result.
 *   3. No dependency. Turndown would be ~50KB plus a lockfile entry plus a
 *      Dockerfile install, to do a job the DOM does natively.
 *
 * CONSTRAINT: `domToMarkdown` is handed to `page.evaluate`, which serialises it
 * to source and re-parses it in the browser. It must therefore be entirely
 * SELF-CONTAINED: no imports, no module-scope helpers, no closure variables.
 * That is why everything lives in one function body, and why the body carries no
 * TypeScript annotations — only the signature, which the transpiler blanks out.
 *
 * This is deliberately NOT a general-purpose HTML-to-Markdown library. It
 * targets the subset an agent reads: headings, paragraphs, lists, links, code,
 * quotes and tables. Anything unrecognised degrades to its text.
 */

/**
 * Serialise the current document body as Markdown. Runs in the browser.
 */
export function domToMarkdown(): string {
	const SKIP = new Set([
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"TEMPLATE",
		"SVG",
		"CANVAS",
		"IFRAME",
		"OBJECT",
		"EMBED",
		"AUDIO",
		"VIDEO",
		"SELECT",
		"HEAD",
	]);
	const BLOCK = new Set([
		"ADDRESS",
		"ARTICLE",
		"ASIDE",
		"BLOCKQUOTE",
		"DETAILS",
		"DIALOG",
		"DIV",
		"DL",
		"DD",
		"DT",
		"FIELDSET",
		"FIGCAPTION",
		"FIGURE",
		"FOOTER",
		"FORM",
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"HEADER",
		"HR",
		"LI",
		"MAIN",
		"NAV",
		"OL",
		"P",
		"PRE",
		"SECTION",
		"TABLE",
		"UL",
	]);

	const blocks = [];

	function hidden(el) {
		// checkVisibility is the whole point of doing this in-page. Older engines
		// lack it, so fall back to computed style rather than dropping everything.
		if (typeof el.checkVisibility === "function") {
			return !el.checkVisibility({ checkVisibilityCSS: true });
		}
		const cs = getComputedStyle(el);
		return cs.display === "none" || cs.visibility === "hidden";
	}

	function clean(s) {
		return s.replace(/\s+/g, " ");
	}

	/** Markdown control characters that would otherwise fake structure. */
	function escapeText(s) {
		return s.replace(/([\\`*_[\]])/g, "\\$1");
	}

	function inline(node) {
		if (node.nodeType === 3) return escapeText(clean(node.nodeValue || ""));
		if (node.nodeType !== 1) return "";
		const el = node;
		const tag = el.tagName;
		if (SKIP.has(tag)) return "";
		if (hidden(el)) return "";
		if (tag === "BR") return "\n";
		if (tag === "IMG") {
			const alt = clean(el.getAttribute("alt") || "").trim();
			const src = el.currentSrc || el.src || "";
			// A decorative image with no alt text is noise; a described one is not.
			return alt ? `![${escapeText(alt)}](${src})` : "";
		}

		let inner = "";
		for (const child of el.childNodes) inner += inline(child);

		if (tag === "A") {
			const href = el.href || "";
			const label = inner.trim();
			if (!label) return "";
			// javascript: links go nowhere; keep the label, drop the fake target.
			if (!href || href.startsWith("javascript:")) return label;
			// Same-document anchors: a table of contents otherwise repeats the full
			// page URL on every entry. Measured on a Wikipedia article that alone was
			// ~20KB of duplicated prefix. Keep the fragment, drop the prefix.
			// Compare the href MINUS its fragment for EQUALITY. A prefix test is wrong:
			// on https://example.com/ every link on the site starts with the page URL,
			// so /docs?a=1 would be mangled into a relative "docs?a=1".
			const self = location.origin + location.pathname + location.search;
			const hash = href.indexOf("#");
			if ((hash === -1 ? href : href.slice(0, hash)) === self) {
				const frag = hash === -1 ? "" : href.slice(hash);
				return frag && frag !== "#" ? `[${label}](${frag})` : label;
			}
			return `[${label}](${href})`;
		}
		if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
			const label = inner.trim();
			// Undo the escaping inside code spans: backslashes are literal there.
			// Built by concatenation, not a template literal — the regex below contains
			// a backtick, which would terminate a template early.
			const tick = "`";
			return label ? tick + label.replace(/\\([\\`*_[\]])/g, "$1") + tick : "";
		}
		if (tag === "STRONG" || tag === "B") {
			const label = inner.trim();
			return label ? `**${label}**` : "";
		}
		if (tag === "EM" || tag === "I") {
			const label = inner.trim();
			return label ? `*${label}*` : "";
		}
		return inner;
	}

	function inlineOf(el) {
		let s = "";
		for (const child of el.childNodes) s += inline(child);
		// Collapse the spaces left behind by dropped inline elements, but keep the
		// newlines <br> produced.
		return s
			.split("\n")
			.map((line) => line.replace(/[^\S\n]+/g, " ").trim())
			.join("\n")
			.trim();
	}

	function push(s) {
		const t = s.trim();
		if (t) blocks.push(t);
	}

	function hasBlockChild(el) {
		for (const child of el.children) if (BLOCK.has(child.tagName)) return true;
		return false;
	}

	function listBlock(el, depth) {
		const ordered = el.tagName === "OL";
		let n = Number(el.getAttribute("start") || 1);
		const lines = [];
		for (const li of el.children) {
			if (li.tagName !== "LI" || hidden(li)) continue;
			const marker = ordered ? `${n++}. ` : "- ";
			const pad = "  ".repeat(depth);
			// Split the item's own text from any nested list, so the nesting shows.
			let own = "";
			const nested = [];
			for (const child of li.childNodes) {
				if (child.nodeType === 1 && (child.tagName === "UL" || child.tagName === "OL")) {
					nested.push(child);
				} else {
					own += inline(child);
				}
			}
			own = own.replace(/\s+/g, " ").trim();
			if (own) lines.push(pad + marker + own);
			for (const sub of nested) {
				const subLines = listBlock(sub, depth + 1);
				if (subLines) lines.push(subLines);
			}
		}
		return lines.join("\n");
	}

	/** Rows belonging to THIS table, not to a table nested inside it. */
	function ownRows(el) {
		const rows = [];
		for (const tr of el.querySelectorAll("tr")) {
			if (tr.closest("table") === el && !hidden(tr)) rows.push(tr);
		}
		return rows;
	}

	function rowCells(tr) {
		const cells = [];
		for (const cell of tr.children) {
			if (cell.tagName === "TD" || cell.tagName === "TH") cells.push(cell);
		}
		return cells;
	}

	/**
	 * Old sites lay pages out with nested <table>s (Hacker News, mailing list
	 * archives). Rendering those as Markdown tables produces giant duplicated
	 * pipe-rows and destroys the page. So only a table that looks like DATA is
	 * rendered as one; a layout table is walked like any other container.
	 */
	function isDataTable(el, rows) {
		if (rows.length < 2) return false;
		for (const tr of rows) if (tr.querySelector("table")) return false;
		const counts = rows.map((tr) => rowCells(tr).length);
		const width = Math.max.apply(null, counts);
		if (width < 2) return false;
		const hasHeader = rows.some((tr) => rowCells(tr).some((c) => c.tagName === "TH"));
		const uniform = counts.every((c) => c === width);
		return hasHeader || uniform;
	}

	function tableBlock(el, rows) {
		const body = [];
		for (const tr of rows) {
			const cells = rowCells(tr).map((cell) =>
				inlineOf(cell).replace(/\n/g, " ").replace(/\|/g, "\\|"),
			);
			if (cells.length > 0) body.push(cells);
		}
		if (body.length === 0) return "";
		const out = [`| ${body[0].join(" | ")} |`, `| ${body[0].map(() => "---").join(" | ")} |`];
		for (let i = 1; i < body.length; i++) out.push(`| ${body[i].join(" | ")} |`);
		return out.join("\n");
	}

	function walk(node) {
		if (node.nodeType === 3) {
			push(escapeText(clean(node.nodeValue || "")));
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node;
		const tag = el.tagName;
		if (SKIP.has(tag)) return;
		if (hidden(el)) return;

		if (/^H[1-6]$/.test(tag)) {
			const text = inlineOf(el);
			if (text) push(`${"#".repeat(Number(tag[1]))} ${text.replace(/\n/g, " ")}`);
			return;
		}
		if (tag === "HR") {
			push("---");
			return;
		}
		if (tag === "PRE") {
			const code = el.textContent || "";
			if (code.trim()) push("```\n" + code.replace(/\s+$/, "") + "\n```");
			return;
		}
		if (tag === "UL" || tag === "OL") {
			push(listBlock(el, 0));
			return;
		}
		if (tag === "TABLE") {
			const rows = ownRows(el);
			if (isDataTable(el, rows)) {
				push(tableBlock(el, rows));
			} else {
				// Layout table: descend into the cells and treat their contents as
				// ordinary blocks.
				for (const tr of rows) for (const cell of rowCells(tr)) walk(cell);
			}
			return;
		}
		if (tag === "BLOCKQUOTE") {
			// Render the quote's contents, then prefix whatever came out. Recursing
			// into the shared `blocks` array and slicing it off keeps one code path
			// for nested structure instead of a second, divergent walker.
			const mark = blocks.length;
			for (const child of el.childNodes) walk(child);
			const inner = blocks.splice(mark).join("\n\n");
			if (inner) {
				push(
					inner
						.split("\n")
						.map((l) => `> ${l}`.trimEnd())
						.join("\n"),
				);
			}
			return;
		}

		// A container whose children include block elements is structure, not
		// content: recurse. Anything else is a leaf paragraph-ish node, so emit its
		// inline rendering (which is where links become [text](url)).
		if (hasBlockChild(el)) {
			for (const child of el.childNodes) walk(child);
			return;
		}
		const text = inlineOf(el);
		if (text) push(text);
	}

	const body = document.body;
	if (!body) return "";
	for (const child of body.childNodes) walk(child);

	return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
