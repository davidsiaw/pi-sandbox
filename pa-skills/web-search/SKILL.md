---
name: web-search
description: >-
  以 stealth_browse 於 pa 匣中搜網、讀頁，循善鏈數跳以得答。凡用戶命汝上網查物、研一題、
  尋文獻／文檔／新聞、驗網上一事，或平常 fetch 遭擋（403／429／503）、或所得之頁無答，
  皆用之。含集鏈（extract="a" extract_attr="href"）、以錨字評鏈、有界廣搜（BFS）勿漫遊。
---

# web-search

（此言雖文言，然答用戶當以用戶所用之語。）

於 pa 匣中穩健研網。匣之 IP 遭 Reddit、Cloudflare 之站、搜索引擎以裸 headless 覽器擋，
故**恆用 `stealth_browse` 具**（出 `pa-stealth-browse` 延），勿用臨時 Playwright 或 `curl`。

## 綱：集鏈，followed 善者

單頁鮮含全答。勝之環：

1. **取**頁（及其文）。
2. **集鏈**為 `(錨字, 絕對 URL)` 對。
3. **評**鏈，視錨字／URL 對目標之望。
4. **循**首數者，跳數有界，至答現。

錨字乃決下往何處之至要之信。勿盲循裸 URL——先讀其字。

## stealth_browse 具

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
stealth_browse url="https://example.com/topic" extract="a" extract_attr="href"
```

得 `text` + `[href] URL` 之號列。此汝之候選集也。

欲窄至真內容鏈，知內容區則擇之（如 `article a`、`main a`、`h2 a`、`.post a`），
先斬 nav／footer／login 之雜，後評。

## 研之環（有界 BFS）

循此法。**界之**勿永爬。

1. **種。**擇一至三始 URL。
   - 有定站？始於此。
   - 需覓源？始於可讀之搜索果頁。DuckDuckGo HTML（`https://duckduckgo.com/html/?q=...`）
     與 Bing 或可經 stealth_browse；若搜索引擎返擋或去鏈，則徑往可信之站或題之樞頁／索引頁。

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

- **勿於何處手改 `Accept` 頭**——某站（Reddit）返削之三項 fallback。stealth_browse 已避此。
- feed（Reddit、鏡）需 `scroll` 以載首數項之外。
- `extract` 返 **innerText**；唯 `extract_attr` 返 URL。集鏈**必**傳 `extract_attr="href"`。
- 機房／民 IP 之擋乃每站之限速——若 `blocked: true` 重試後仍持，則另尋一源，勿捶之。
- 擇內容域之 selector（`article a`、`main a`）勝裸 `a`，以減候選集之 nav／樣板之雜。
