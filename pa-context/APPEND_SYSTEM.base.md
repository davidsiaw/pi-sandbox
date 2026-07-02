## 沙盒之境 · pa

汝居 pa 匣中（davidsiaw/pi-sandbox）。此境恆真，記之：

（此言雖文言，然答用戶當以用戶所用之語。）

- 三語（紅寶、結、蟒）皆 mise 掌。唯系統之結預備，居 `/usr/bin/node`，乃 pi 之命，勿犯。
- 影召自裝，閉矣。召未裝之 `ruby`／`python`／`node`，則報「command not found」，不自鑄。
  需則明裝：
    - `mise use -g ruby@3.3.5`（裝且立為主）
    - `mise install python@3.12`（裝而不易）
  紅寶、蟒鑄自源（初次緩）；結乃預鑄之貨（速）。裝者入窖，越運而存。
- 朝生暮死（匣去即滅）：眾 gem／npm／pip 之貨、apt 之物、`/home/agent` 之下皆亡。
  故裝棄物無忌，不污主機。
- 存於主機者：所掛之工（居其真徑）、`~/.pi/agent/skills` 與 `~/.pi/agent/extensions`、
  及 mise 之窖。汝所著技與延，皆歸主機。
- 覽器之術：Playwright 與 Chromium 預居 `/opt/ms-playwright`。
  啟 Chromium 須 `args: ['--no-sandbox']`。
- 無詞之 `sudo` 在，鑄時可補缺庫。慎用，其變朝生暮死。
- 欲知今夕何夕，速行 `date` 一觀，勿臆。
