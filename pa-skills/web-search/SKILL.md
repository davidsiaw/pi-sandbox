---
name: web-search
description: >-
  以 yousoro_browse 於 pa 匣中搜網、讀頁，循善鏈數跳以得答。凡用戶命汝上網查物、研一題、
  尋文獻／文檔／新聞、驗網上一事，或平常 fetch 遭擋（403／429／503）、或所得之頁無答，
  皆用之。含集鏈（extract="a" extract_attr="href"）、以錨字評鏈、有界廣搜（BFS）勿漫遊。
---

# web-search

（此言雖文言，然答用戶當以用戶所用之語。）

於 pa 匣中穩健研網。匣之 IP 遭 Reddit、Cloudflare 之站、搜索引擎以裸 headless 覽器擋，
故**恆用 `yousoro_browse` 具**（出 `pa-yousoro-browse` 延），勿用臨時 Playwright 或 `curl`。

## 綱：集鏈，followed 善者

單頁鮮含全答。勝之環：

1. **取**頁（及其文）。
2. **集鏈**為 `(錨字, 絕對 URL)` 對。
3. **評**鏈，視錨字／URL 對目標之望。
4. **循**首數者，跳數有界，至答現。

錨字乃決下往何處之至要之信。勿盲循裸 URL——先讀其字。

## yousoro_browse 具

要參：

- `url`——所取之頁（http／https）。
- `extract`——CSS selector；返每中者之 innerText。
- `extract_attr`——每中者亦返之屬性。**以 `"href"` 配 `extract="a"` 集鏈**（返解析之絕對 URL）。
- `scroll` ／ `scroll_wait_ms`——為懶載／無限捲之 feed（Reddit、Twitter 鏡）捲之。feed 始以 `scroll=5`。
- `wait_ms`——JS 重之頁多候（試 `3000`+）。
- `max_attempts`——遭擋則退避重試（默 4；勿改）。
- `max_chars`——限返之頁文（默 8000）。

具已掩自動化指紋、重試瞬擋，故 `blocked: true` 者，乃真不得過也。

### 集一頁之鏈

```
yousoro_browse url="https://example.com/topic" extract="a" extract_attr="href"
```

得 `text` + `[href] URL` 之號列。此汝之候選集也。

欲窄至真內容鏈，知內容區則擇之（如 `article a`、`main a`、`h2 a`、`.post a`），
先斬 nav／footer／login 之雜，後評。

## 研之環（有界 BFS）

循此法。**界之**勿永爬。

1. **種。**擇一至三始 URL。
   - 有定站？始於此。
   - 需覓源？始於可讀之搜索果頁（見下**薦用之搜索引擎與源**）。
   - 若搜索引擎返擋或去鏈，則徑往可信之站或題之樞頁／索引頁。

## 薦用之搜索引擎與源

（自匣中 IP 試之，機房 IP，地定於東京。用可通者，避 Cloudflare 牆者。）

**元搜索（覓源）：**

- ✅ **DuckDuckGo HTML**——`https://html.duckduckgo.com/html/?q=...`——最穩。
  鏈全、snippet 全。果之 URL 裹於 `https://duckduckgo.com/l/?uddg=<編碼>` 轉向；
  解 `uddg` 參之編碼得真的。
- ✅ **Yahoo**——`https://search.yahoo.com/search?p=...`——佳，返**直**（未裹）之果 URL 及豐 snippet。
  雖曰「Powered by Bing」，然 Bing 自身不通時此仍通。
- ⚠️ **Google**——`https://www.google.com/search?q=...`——通，然匣之 IP 令其返**日文** SERP、鏈裹 tracker。
  綴 `&hl=en&gl=us` 以強英文。真 URL 埋於 `ved=`／`sca_esv=` 參，或為 `#:~:text=` 片段。
- ✅ **Bing**——`https://www.bing.com/search?q=...`——**今通**（yousoro_browse 之指紋掩護既備 Google Chrome UA、真 GPU，昔之 CAPTCHA 不復現）。返直 URL、豐 snippet。

**舊牌／替代元搜索（多已轉為 metasearch 面子，非自爬）：**

- ✅ **Dogpile**——`https://www.dogpile.com/serp?q=...` ——通，果潔、URL 直。
- ✅ **MetaCrawler**——`https://www.metacrawler.com/serp?q=...` ——通（與 Dogpile 同屬 System1）。
- ✅ **Startpage**——`https://www.startpage.com/sp/search?query=...` ——通，Google 果代取。
- ✅ **Naver**（韓）——`https://search.naver.com/search.naver?query=...` ——通，但首多韓文廣告。
- ❌ **Lycos**——`search.lycos.com` DNS 不解（ERR_NAME_NOT_RESOLVED，已废）。
- ❌ **Ask.com ／ Excite**——旧搜索路徑 404（已去其搜索功能）。
- ✅ **WebCrawler**——`https://www.webcrawler.com/serp?q=...`——**今通**（昔 Cloudflare 403，yousoro 之掩既足以過）。
- ❌ **Mojeek**——ALTCHA CAPTCHA（「Verification required」，非瞬擋，不自解；yousoro_browse 正報 `blocked: true`）。
- ✅ **Yandex**——`https://yandex.com/search/?text=...`——**今通**（昔 SmartCaptcha，yousoro 之掩既足）。

**直源（知域則越元搜索）：**

- ✅ **GitHub**——`https://github.com/search?q=...&type=repositories`（無需登入）。
  亦 `github.com/topics/<題>`、`github.com/trending`。nav 樣板繁，宜濾至 `github.com/<user>/<repo>` 之鏈或用內容域 selector。
- ✅ **Hugging Face**——`https://huggingface.co/models?...&sort=trending`——覓模型之最結構化源。
  以 URL facet 濾之，如 `&library=gguf`、`&other=ollama`、`&pipeline_tag=text-generation`。
- ✅ **Reddit**——通；yousoro_browse 自解其 JS challenge。feed／評論用 `scroll=5+`。
- ✅ **GitLab**——`https://gitlab.com/explore/projects`、`gitlab.com/search?search=...`——**今通**（昔 Cloudflare「Just a moment」403，yousoro 之掩既足以過）。

**社群／論壇（覓真人之見）：**

- ✅ **Hacker News**——有公開 JSON API，不須爬、不遭擋，最佳。
  `https://hn.algolia.com/api/v1/search?query=<q>&tags=story`（按分），
  `.../search_by_date?query=<q>&tags=story`（按日），`tags=comment` 取評論。
  返結構 JSON：title、url、points、num_comments、objectID。
- ✅ **4chan**——官方 JSON API 不遭擋：`https://a.4cdn.org/<board>/catalog.json`（全緒）、
  `https://a.4cdn.org/<board>/thread/<no>.json`。**無原生全文搜索**（`find.4chan.org` 遭 Cloudflare 403），
  己取 catalog.json 而濾 `com`／`sub` 字。`/g/` 乃技術板，內有循環之 **「/lmg/」（Local Models General）**主題乃地方模型之樞。
- ⚠️ **Twitter／X**——本站登入牆。然**替代前端可用**（見下）。

**替代前端／代理（穿墙讀封閉之服務）：**

- ✅ **fxtwitter／其族**——單推代理：`https://api.fxtwitter.com/<user>/status/<id>` 返 JSON（tweet 內文、數據）。
  同屬：vxtwitter、fixupx。**只取單推**，不能搜索。
- ✅ **Nitter（poast）**——`https://nitter.poast.org/search?q=<q>&f=tweets` ——**能搜 Twitter**！多數公共 Nitter 已死，此一尚活（偶需重試）。
- ✅ **Redlib**（Reddit 前端）——`https://redlib.catsarch.com/r/<sub>/search?q=<q>&restrict_sr=on` ——無 Reddit 之 JS challenge，果潔。別的 instance：redlib.perennialte.ch 等。
- ✅ **Priviblur**（Tumblr 前端）——`https://priviblur.pussthecat.org/search/<q>` ——通。
- ❌ **SearXNG （searx.be、yewtu.be Invidious）**——多有 antibot 503（unixfox 之驗證頁）。searx.tiekoetter 頁載然 GET 搜索轉向首頁，不可靠。

通則：公共镜像（Nitter、Redlib、Invidious、SearXNG）**好壞隨時變**。一 instance 死則換一個；可於 github.com/zedeus/nitter、各 instance uptime 頁尋活者。

**其他佳始點（均試通）：**

- ✅ **Wikipedia**——`https://en.wikipedia.org/w/index.php?search=<q>` ——背景、定義、引源之樞。
- ✅ **Lobsters**——`https://lobste.rs/search?q=<q>&what=stories&order=relevance` ——技術向論壇，優質鏈。
- ✅ **Stack Exchange API**——`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=<q>&site=stackoverflow` ——返 JSON，技術 QA。**首選**（無 challenge、潔）。
- ✅ **Stack Overflow／Stack Exchange 網頁**——`https://stackoverflow.com/questions?tab=Newest`、`https://stackexchange.com/`——**今亦通**。彼行 Cloudflare「先 403 後轉」之關：首返 403 挑戰頁，指紋過則轉真頁。yousoro_browse 候其自解，故通。（然結構化查詢仍以上之 API 為佳。）
- ❌ **Marginalia**——`search.marginalia.nu` 超時（不可靠）。

**JSON／API 端點（均試通，優於爬 HTML）：**

- ✅ **Wikipedia API**——`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=<q>&format=json` ——比 HTML 潔。
- ✅ **GitHub API**——`https://api.github.com/search/repositories?q=<q>&sort=stars` ——返 JSON；total_count、full_name、stars 等。未認證限速約 10／分。
- ✅ **arXiv API**——`https://export.arxiv.org/api/query?search_query=all:<q>&max_results=<n>` ——返 Atom XML。
  ❗ **空格被拆為 OR**；片語用 `+` 連或引號包之（如 `all:%22local+llm%22`）。
- ✅ **npm registry**——`https://registry.npmjs.org/-/v1/search?text=<q>&size=<n>` ——返 JSON，包發現。
- ❌ **PyPI 搜索**——`pypi.org/search` 遭 CAPTCHA（Client Challenge）。已知包名則用 `https://pypi.org/pypi/<name>/json`。

通則：多數 Cloudflare「Just a moment」瞬擋今由 yousoro_browse 自過（Google Chrome 指紋、真 GPU、候其自解）。此類站行「**先 403 後轉**」之關——首返 403 挑戰頁，指紋過則轉真頁；故初之 403 非真擋，工具候其自解，過則以 200 論。然**圖形 CAPTCHA（PyPI、Mojeek）與最硬之 managed challenge（find.4chan.org）仍不得過**——此非指紋之事，乃須解謎或真 residential IP。若一源重試後仍 `blocked: true`，則另尋一源，勿捶之。

2. **讀且集。**每頁：
   - 讀頁文。**若已答，止而報**——引其 URL。
   - 未答，則集鏈（`extract="a" extract_attr="href"`）。

3. **評候選。**每 `(text, url)` 依對目標之切評之：
   - 錨字含問之要詞 → 高
   - URL 徑似文章／story／文檔（`/article/`、`/story/`、`/blog/`、含日之 slug、`/docs/`）→ 升
   - 明非內容（login、signup、privacy、terms、share、`mailto:`、外社交、tag／類索引）→ 棄
   - 已訪 → 棄

4. **循。**訪首 **2–3** 評鏈。自第二步復始。

5. **止之條（皆守之）：**
   - 得答 → 報之。**恆引確之 URL。**
   - **深限：自種 3 跳。**
   - **算限：常問約 8–10 取頁。**若達限而無答，報所得、最佳之緒、並言答未確。勿默續行。
   - 連二頁無新切鏈 → 退，試次佳未探之候選，或另一種。

存**已訪 URL** 與**未探之善候選**之短列，俾可退而勿環。

## 報

- 首陳答。
- **每述引其所出之 URL。**若合數頁而成，列之。
- 若遭擋或不決，直言之，並列所得最佳之緒。

## 陷

- **勿於何處手改 `Accept` 頭**——某站（Reddit）返削之三項 fallback。yousoro_browse 已避此。
- feed（Reddit、鏡）需 `scroll` 以載首數項之外。
- `extract` 返 **innerText**；唯 `extract_attr` 返 URL。集鏈**必**傳 `extract_attr="href"`。
- 機房／民 IP 之擋乃每站之限速——若 `blocked: true` 重試後仍持，則另尋一源，勿捶之。
- 擇內容域之 selector（`article a`、`main a`）勝裸 `a`，以減候選集之 nav／樣板之雜。
