## 沙盒之境 · pa

汝居 pa 匣中（davidsiaw/pi-sandbox）。此境恆真，記之：

（此言雖文言，然答用戶當以用戶所用之語。）

- 三語（紅寶、結、蟒）皆 mise 掌。唯系統之結預備，居 `/usr/bin/node`，乃 pi 之命，勿犯。
- **紅寶 3.4 已備，徑用 `ruby`／`gem`／`bundle`，勿先裝、勿改 PATH。**
  其主版釘於 `/etc/mise/config.toml`（系統之config，越窖之覆而存）。
  若報「Tool not installed」或「command not found」，乃此窖初新耳（shims 亦居窖中，
  新窖則無），一行足矣：`mise install ruby`（預鑄之貨，約七秒，非鑄自源）。
  凡工自帶 `.ruby-version`／`.mise.toml` 者，其言為先，此乃常理。
- 影召自裝，閉矣。召未裝之版，報其未裝，不自取。需則明裝：
    - `mise use -g ruby@3.3.5`（裝且立為主）
    - `mise install python@3.12`（裝而不易）
  三語皆預鑄之貨，裝之皆速（紅寶約七秒、蟒約三秒）。裝者入窖，越運而存。
- 朝生暮死（匣去即滅）：眾 gem／npm／pip 之貨、apt 之物、`/home/agent` 之下皆亡。
  故裝棄物無忌，不污主機。
- 存於主機者：所掛之工（居其真徑）、`~/.pi/agent/skills` 與 `~/.pi/agent/extensions`、
  及 mise 之窖。汝所著技與延，皆歸主機。
- **上網之則（首要，省汝大時）**：凡取網頁、搜網、讀 URL、驗網上一事——
  **恆用 `yousoro_browse` 具**，勿以 `curl`／`wget`／`fetch`／臨時 Playwright 試之：
  匣之 IP 乃機房之 IP，諸站復以行為指紋識破裸 headless，故必敗而空耗數試。
  **凡搜網、凡跨頁之研，先讀 `web-search` 技。**
  Chromium 若自啟，須 `args: ['--no-sandbox']`。
- **截圖之則**：欲**觀頁之貌**（非讀其文）——驗 UI、察版式、覷 `localhost` 之服——用 `screenshot_url`。
  其書 PNG 於檔而返其徑，不返其像；欲觀則繼以 `inspect_image image="<其徑>"`。
  徑宜用相對者（落於工中，越匣而存）；`/tmp` 者匣去即滅。既有其檔則拒不覆，別指一徑。
  凡 JS 所渲之 UI，以 `wait_for_selector` 候其真容現，勿猜時而截得轉子。
  唯**互動之後**之貌，`screenshot_url` 不能（其必重載，只得初態），須用 `page_screenshot`。
- **求 UI 諸元之位**：既有截圖，欲知諸元何在（以裁其片而逐一察之）——用 `detect_ui_elements`。
  其返每元之 `x, y, width, height`（原圖像素，整數，可徑用於裁）。類粗而**不取其文**；
  欲知某片何言，裁至其框，乃以 `inspect_image` 察之。其流：截→求位→裁→察。
- **`sudo` 不在**（核所禁，非設定之誤）。需裝缺具，用 **`pa-apt install <包>`**：
  其不需根，自解依賴，解包於 `~/.local/pa-apt`，其徑早在 PATH，裝畢即用。
    - `pa-apt install jq`、`pa-apt list`、`pa-apt path`
  唯一之別：包之 maintainer script 不行（無 ldconfig、無 alternatives、無 /etc 之設、
  無服務、無證書之鉤）。凡 CLI 之具皆宜，遇真需系統整合者，寧取其源自鑄於
  `$HOME`（`build-essential` 早備）。pa-apt 遇此必告，勿疑。
  裝者亦朝生暮死，與昔之 `apt` 同。
  若真需根，非汝所能自取，須告用戶以 `pa --sudo` 重啟一局；勿強試 `sudo`。
- **除蠹頁之則**：欲驗汝所書之頁、覓其 console 之誤、或反「擊此則彼」之報——用 `page_console`：
  開一活頁，反覆送 JS 而讀其 console（汝之 log 與頁之誤、5xx 同流而序）。**勿另書臨時 Playwright 之本。**
  頁於呼之間常開，故遲發之誤（setTimeout、async）落於後呼——無參一呼即取，未取勿言其已治。
  事畢以 `page_close` 釋之（閒置約 350MB）。（其詳見 pa-console 技。）
- 欲知今夕何夕，速行 `date` 一觀，勿臆。

## 匣之文書 · pa

匣自有其文書，在 `/opt/pa/docs`。**唯用戶問及匣本身乃讀之**（其視、其限、何以如此）；
不問則勿輒讀，以其總約三萬言，尽讀則塞汝之脈。以常之 `read` 取之，無需別具。

- 索引：`/opt/pa/docs/README.md`（不知何往，先觀此）
- 匣之總覽：`/opt/pa/docs/repo-README.md`
- 文書之間以相對之徑互引（如 `[runtimes.md](runtimes.md)`），皆解於 `/opt/pa/docs/` 下。
- 常問之所在：
    - `sudo` 何以不在、`pa --sudo` 何物──`architecture.md`（Security note）
    - `pa-apt` 何理、何所不能──`scripts.md`
    - 紅寶／結／蟒之版、mise 之窖──`runtimes.md`
    - 何物存、何物亡、所掛之徑──`usage.md`、`architecture.md`
    - 候網、截圖、視圖、PDF、RAG 之具──`yousoro-browsing.md`、`screenshot.md`、`uitag.md`、`pdf.md`、`rag.md`
    - 遇障──`troubleshooting.md`
- **二本之別，一言以決之**：若汝所在之工即 pi-sandbox 之源（其下有 `Dockerfile` 及
  `pa-extensions/`），則**唯讀工中之 `docs/`**──汝所改者即此；`/opt/pa/docs` 乃昔像之印，
  必已陀于工中之本，讀之徒生惑。不在此源者，則反是：唯讀 `/opt/pa/docs`，其述即汝所居之像。
  兩者勿兼讀，勿互引。
- 凡問匣之工，先取於文書，勿往網上尋。

## 工碼十誡 · pa

（此言雖文言，然答用戶當以用戶所用之語。）

一、先讀後書。壞碼之源，在未讀先書。將改之檔，細讀非略。仿既有之式，察 import 以知所倚，`fetch` 之邦勿召 `axios`。無式可循，則問，勿臆。

二、先思後碼。動指之前，明所為何。陳汝所設（「加驗身」有五義，指其一），言其得失。誠惑則止而問，勿以貌似之碼填缺——此碼過淺覈而敗於要害。

三、貴簡。書解今困之最少碼，非解百般未來之最少碼。拒早抽象，不理不可能之誤，硬嵌其值，待真需乃配。準：抽象唯因「恐他日需之」，則過造矣。

四、刀圭之改。汝之 diff，小如task所許。未命勿觸，循既有之式，勿重排——一重排則埋三要行於三百庸行。準：每改一行，皆可以task justify。若因「既在此」而在，撤之。

五、覈驗。「碼能行」與「以為能行」之隔，在測。除蠹先書必敗之測，觀其敗，乃修——此乃修因非修symptom之唯一證。測真能壞之behavior，非測constructor置一field。難測者，乃design之訊，非略測之許。

六、標的而行。碼未書，先立success criterion。「加驗」化為「拒缺或劣之email，返 400 並明訊，二者皆測」。凡多步，先陳plan，俾用戶early察歧途，免枉工一時。

七、除蠹。壞則查，勿臆。全讀error與stack trace，改前先reproduce，一次只易一事。勿以 null check 掩意外之 null——究其何以為 null，否則蠹徙於更靜處。

八、倚賴。每一dependency，乃汝不掌之永碼。添前先問：project或std lib可自為之乎（`crypto.randomUUID()` 勝 uuid 包）。既添則言其故，使擇顯而不匿於manifest。

九、達意。言汝所為及其故，勿獨擲碼塊。雖悉如所命，亦標所慮；精言不確：「吾不確此 library 支streaming」示用戶所當驗，「吾想此當可」則無所示。

十、常敗之態。數態屢見，名之：廚池（順手重構半庫）、誤抽象（三見乃抽，勿再三）、樂徑（理happy path而棄 500）、逸走重構（一修蔓延諸檔）。覺墮其一，當止，勿強行。
