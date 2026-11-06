# Herdr 的 YouTube 播放器

Herdr 右側面板裡的 YouTube 播放器 mod。後端在背景開一個 headless Chrome 播放 YouTube，聲音直接從 Chrome 出來；畫面用 Chrome 的 screencast 抓下來，以 Kitty 圖片協定畫進面板裡的終端機區塊。

```text
控制列 main.js ──exec──► backend.mjs request ──socket──► backend.mjs serve
                                                           │ CDP
                                                           ▼
                                     headless Chrome（播 YouTube、出聲音）
                                                           │ screencast（Chrome 主動推 PNG）
                                                           ▼
                                     終端機區塊（Kitty 圖片，先傳後放）
```

## 安裝

Herdr 從 `~/.config/herdr-app/mods/youtube` 讀這個 mod，所以 repo 直接 clone 在那裡：

```sh
git clone git@github.com:handsomeno7/herdr-youtube.git ~/.config/herdr-app/mods/youtube
ln -s ../.config/herdr-app/mods/youtube ~/src/herdr-youtube
herdr-app check ~/.config/herdr-app/mods/youtube
```

不要反過來把 `mods/youtube` 做成指到別處的 symlink：Herdr 不會追蹤 symlink 資料夾裡的變動，改檔後不會自動重新載入。chezmoi 在 `.chezmoiignore` 裡略過這個資料夾，由本 repo 自己管。

`gpui-kit.d.ts` 與 `jsconfig.json` 是 Herdr 每次執行時寫入的，不進 git。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `main.js` | 分頁列（The Office／YouTube、搜尋、清單、登入）與控制列 |
| `backend.mjs` | `request` 送指令給播放器；`serve` 管 Chrome、播放狀態與畫面 |
| `model.mjs` | 純函式：解析網址、讀 YouTube 頁面資料、組 Kitty 圖片封包 |
| `icons/` | 控制列圖示，Herdr 依文字顏色上色 |

測試：`node model.test.mjs`

## 設計決定

這些是 2026-11-06 量測後的決定，改之前先看原因。

**headless Chrome 加 `--disable-extensions`。** 登入用的一般 Chrome 視窗會同步 Google 帳號的擴充功能到專用 profile。headless 載入它們時，擴充功能程序吃掉 130% 以上 CPU，CDP 呼叫要排 10 到 21 秒，出現「瀏覽器操作逾時」。關掉後 CPU 從 267% 降到約 30%。

**`status` 不排隊。** Herdr 的 `exec` 只等 30 秒。`status` 直接回傳快取的狀態，不進 `serial` 佇列；狀態由畫面迴圈每輪呼叫 `updateState()` 更新。`request` 的 socket 逾時是 25 秒，比 30 秒短，逾時時回中文錯誤，不會被 Herdr 砍掉。

**用 screencast，不用 `captureScreenshot` 輪詢。** 輪詢是要一張、等一張，640×360 的 PNG 一張要 96 ms，上限約 10 fps。screencast 用實際顯示的大小，Chrome 主動推畫面，實測約 25 fps。終端機還在寫上一張時只留最新一張，畫面不會越積越延遲。暫停時停掉 screencast，改每 0.5 秒截一張靜止畫面。

**先傳後放（`framePacket`）。** 用同一個圖片編號直接覆蓋，Herdr 解新 PNG 的那一瞬間沒有圖可畫，會閃黑。現在每張先用 `a=t` 傳過去但不顯示，下一張進來時才 `a=p` 放上去，再刪掉更早的那張；三個編號輪流。畫面因此晚一張（約 40 ms）。比較過的其他做法：兩個編號輪流覆蓋仍會閃；Unicode 佔位字元會破圖；未壓縮像素不閃，但 screencast 只給 PNG，資料量也是 4 倍。

**只給欄數，不給列數。** 同時給 `c` 與 `r` 會讓 Herdr 把圖拉伸。高度由來源比例決定，所以要用 cell size（`\e[16t`，這台是 8×20 px）算出 16:9 該佔幾欄。

**面板高度配合格子。** Herdr 依區塊大小調整這個終端機的格數，上下各留約 12 px 邊距。影片要撐滿，格子本身要接近 16:9：60 欄 × 8 px = 480 px 寬，需要 14 列（280 px）。`my-main.json` 的 `office` 因此設成 370 px。改了右欄寬度就要重算這個高度。

## 已知限制

- screencast 的解析度在開始播放時決定。播放中改面板大小，畫面會被縮放到新大小，暫停再播放或換下一首才會換解析度。
- 面板隱藏時後端會暫停影片，切回來不會自動繼續播放。
