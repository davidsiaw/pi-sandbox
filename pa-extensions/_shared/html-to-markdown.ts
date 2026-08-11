/**
 * _shared/html-to-markdown.ts — HTML string → Markdown / plain text, no DOM.
 *
 * WHO USES THIS, AND WHY IT IS NOT pa-yousoro-browse/markdown.ts
 * `yousoro_browse` owns a live Playwright page, so it walks the real DOM and can
 * ask `Element.checkVisibility()` what is actually rendered. That is strictly
 * better and it stays there.
 *
 * `cloak_browse` has no such page: it shells out to the CloakBrowser binary with
 * `--dump-dom` and gets back a STRING. There is no DOM parser in the image (no
 * jsdom, and adding one to convert markup is a poor trade), so this module does
 * what can honestly be done with regexes over markup.
 *
 * WHAT THAT COSTS, STATED PLAINLY
 * Regexes cannot know what is visible. A `display:none` menu, a collapsed
 * accordion and an off-screen cookie banner all survive here, where the DOM walk
 * drops them. Nested list depth and table structure are likewise not tracked.
 * So cloak_browse markdown is noisier than yousoro_browse markdown for the same
 * page. It is still far better than the previous behaviour (all whitespace
 * collapsed into one unusable line), and the raw markup is cached next to it for
 * when the rendering is not enough.
 *
 * The right fix is to drive CloakBrowser over CDP (it is a Chromium; launch with
 * --remote-debugging-port and connect with the playwright-core already installed
 * in the image) and then reuse the DOM walker. That is a real change to the
 * fetch path, so it is deliberately not bundled with this one.
 */

const SKIP_BLOCKS = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Decode the handful of entities that actually show up in prose. */
function decodeEntities(s: string): string {
	return (
		s
			.replace(/&nbsp;|&#160;/gi, " ")
			.replace(/&lt;|&#60;/gi, "<")
			.replace(/&gt;|&#62;/gi, ">")
			.replace(/&quot;|&#34;/gi, '"')
			.replace(/&#0*39;|&apos;|&#x27;/gi, "'")
			.replace(/&mdash;|&#8212;/gi, "—")
			.replace(/&ndash;|&#8211;/gi, "–")
			.replace(/&hellip;|&#8230;/gi, "…")
			// &amp; LAST, or "&amp;lt;" double-decodes into "<".
			.replace(/&amp;|&#38;/gi, "&")
	);
}

/** Strip every tag and collapse horizontal whitespace. For link labels/cells. */
function plain(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Resolve an href against the page URL so links are followable as printed. */
function absolute(href: string, baseUrl?: string): string {
	if (!baseUrl) return href;
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return href;
	}
}

/**
 * Dropping a tag leaves a space behind, so prose ends up reading "the docs ,
 * and". Re-join punctuation with the word before it.
 */
function fixPunctuation(s: string): string {
	return s.replace(/(\S) ([,.;:!?])(\s|$)/g, "$1$2$3");
}

/** Trim, drop leading/trailing blanks, and never allow more than one blank run. */
function tidyLines(text: string): string {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		// Full trim, not trimEnd: a dropped opening tag leaves a leading space on
		// every line. Code fences are still placeholders at this point, so their
		// indentation is not at risk.
		const line = raw.replace(/[^\S\n]+/g, " ").trim();
		if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
		lines.push(line);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/**
 * Readable text, no markup syntax. Line structure preserved (block tags become
 * newlines) — a single giant line would make the cache file ungreppable.
 */
export function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(SKIP_BLOCKS, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/?(p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|aside|main|form|pre|blockquote|figure|figcaption|option|label)\b[^>]*>/gi,
			"\n",
		)
		.replace(/<[^>]+>/g, " ");
	return tidyLines(fixPunctuation(decodeEntities(text)));
}

/**
 * Real pipe tables, because a table rendered as loose lines loses which value
 * belongs to which column — the only thing a table is for. Runs after links and
 * emphasis so cells keep their `[text](url)`.
 *
 * BUT old sites lay whole pages out with nested <table>s (Hacker News, mailing
 * list archives). Rendering those as tables produces giant duplicated pipe-rows
 * and destroys the page, so a table that does not look like DATA is degraded to
 * plain block content instead.
 */
function renderTable(body: string): string {
	const rows: { cells: string[]; header: boolean }[] = [];
	const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let row: RegExpExecArray | null = rowRe.exec(body);
	while (row !== null) {
		const cells: string[] = [];
		let header = false;
		const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
		let cell: RegExpExecArray | null = cellRe.exec(row[1]);
		while (cell !== null) {
			if (cell[1].toLowerCase() === "th") header = true;
			cells.push(plain(cell[2]).replace(/\|/g, "\\|"));
			cell = cellRe.exec(row[1]);
		}
		if (cells.length > 0) rows.push({ cells, header });
		row = rowRe.exec(body);
	}

	const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
	const uniform = rows.every((r) => r.cells.length === width);
	const hasHeader = rows.some((r) => r.header);
	const isData = rows.length >= 2 && width >= 2 && (hasHeader || uniform);
	if (!isData) {
		// Layout table: keep the contents, drop the grid.
		return `\n${body.replace(/<\/?(tr|td|th)\b[^>]*>/gi, "\n")}\n`;
	}

	const out = [
		`| ${rows[0].cells.join(" | ")} |`,
		`| ${rows[0].cells.map(() => "---").join(" | ")} |`,
	];
	for (let i = 1; i < rows.length; i++) out.push(`| ${rows[i].cells.join(" | ")} |`);
	return `\n\n${out.join("\n")}\n\n`;
}

/**
 * Markdown-ish rendering: headings, links with resolved URLs, list markers, code
 * fences, quotes and emphasis. See the module header for what regexes cannot do.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
	let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(SKIP_BLOCKS, " ");

	// Fenced code first: its contents must not be processed as markup.
	const fences: string[] = [];
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => {
		const code = decodeEntities(String(body).replace(/<[^>]+>/g, "")).replace(/\s+$/, "");
		if (!code.trim()) return "\n";
		fences.push(code);
		return `\n\n\u0000FENCE${fences.length - 1}\u0000\n\n`;
	});

	// Inline code, before generic tag stripping eats the delimiters.
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body) => {
		const code = plain(String(body));
		return code ? `\`${code}\`` : "";
	});

	// Links and images carry the URLs, which is the whole reason to render
	// markdown rather than text.
	s = s.replace(
		/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href: string, body: string) => {
			const label = plain(body);
			if (!label) return " ";
			if (!href || /^javascript:/i.test(href)) return label;
			const url = absolute(href, baseUrl);
			// Same-document anchors: keep the fragment, drop the repeated page URL.
			if (baseUrl && url.split("#")[0] === baseUrl.split("#")[0]) {
				const frag = url.includes("#") ? `#${url.split("#")[1]}` : "";
				return frag ? `[${label}](${frag})` : label;
			}
			return `[${label}](${url})`;
		},
	);
	s = s.replace(/<img\b[^>]*>/gi, (tag) => {
		const alt = /alt=["']([^"']*)["']/i.exec(tag);
		const src = /src=["']([^"']*)["']/i.exec(tag);
		const label = alt ? plain(alt[1]) : "";
		// A decorative image with no alt text is noise; a described one is not.
		return label ? `![${label}](${absolute(src ? src[1] : "", baseUrl)})` : " ";
	});

	// Emphasis.
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => {
		const label = plain(String(body));
		return label ? `**${label}**` : "";
	});
	s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => {
		const label = plain(String(body));
		return label ? `*${label}*` : "";
	});

	// Headings.
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => {
		const label = plain(body);
		return label ? `\n\n${"#".repeat(Number(level))} ${label}\n\n` : "\n";
	});

	// Blockquotes: prefix every line the quote produced.
	s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body) => {
		const inner = tidyLines(htmlToMarkdown(String(body), baseUrl));
		if (!inner) return "\n";
		return `\n\n${inner
			.split("\n")
			.map((l) => `> ${l}`.trimEnd())
			.join("\n")}\n\n`;
	});

	// Innermost tables first. The pattern cannot match a table that itself
	// contains a <table>, so repeated passes collapse nesting from the inside out;
	// a single non-greedy pass would pair an outer <table> with an inner </table>
	// and mangle both. The pass cap stops a pathological document from looping.
	const innermostTable = "<table\\b[^>]*>((?:(?!<table\\b)[\\s\\S])*?)<\\/table>";
	for (let pass = 0; pass < 20; pass++) {
		if (!new RegExp(innermostTable, "i").test(s)) break;
		s = s.replace(new RegExp(innermostTable, "gi"), (_m, body) => renderTable(String(body)));
	}

	// List items. Depth is not tracked (see the module header), so every item is
	// a top-level bullet; the text survives even when the nesting does not.
	// `</li>` maps to nothing, not a newline: the next `<li>` already starts a
	// line, and emitting both puts a blank line between every bullet.
	s = s
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/li>/gi, "")
		.replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/?(p|div|ul|ol|section|article|header|footer|nav|aside|main|form|figure|figcaption|option|label|dl|dt|dd)\b[^>]*>/gi,
			"\n",
		)
		.replace(/<[^>]+>/g, " ");

	// Tidy BEFORE restoring the fences: tidying collapses horizontal whitespace,
	// which would eat the indentation that makes a code block worth having.
	s = tidyLines(fixPunctuation(decodeEntities(s)))
		// A bullet whose content vanished (an icon-only link, say) is pure noise.
		.replace(/^-\s*$/gm, "");

	return s.replace(
		/\u0000FENCE(\d+)\u0000/g,
		(_m, i: string) => `\`\`\`\n${fences[Number(i)]}\n\`\`\``,
	);
}
