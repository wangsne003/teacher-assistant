# 🎓 課堂小幫手 — 語音教師助理（多班級 + 名單匯入 + GAS 試算表）

這是一個純 HTML / CSS / JavaScript 打造、**無須編譯工具**、採用**插件式架構**的網頁版教師助理工具，支援：

* **多班級切換**：頂部下拉選單快速切換不同班級，各班名單、加分板、抽籤池與統計獨立運作。
* **語音助理控制**：支援喚醒詞模式（預設「小幫手」）、按住空白鍵說話、**中文拼音同音字容錯**（「王小明」聽成「王小名」也能準確命中）、座號/學號比對、語音播報與一鍵復原。
* **多元匯入學生名單**：支援上傳 CSV 檔（含範本下載）或直接從 Excel／Google 試算表複製貼上，完整支援**座號、學號、姓名、組別、別名**欄位。
* **Google Apps Script + 試算表後端**：採用「前端樂觀更新（畫面零延遲）+ 背景同步佇列」，並內建流水帳與自動彙總公式分頁 `Summary`。
* **插件式架構**：未來想新增倒數計時器、課堂點名、分組工具、教室音量計，只需新增一個 `.js` 檔註冊即可。

---

## 📁 檔案結構

```text
teacher-assistant/
├── index.html                  # 主網頁入口
├── css/style.css               # 介面樣式
├── js/
│   ├── core/
│   │   ├── pinyin-util.js      # 中文數字轉換 & 拼音同音字模糊比對
│   │   ├── api-client.js       # GAS 通訊與背景重試同步佇列
│   │   ├── store.js            # 多班級狀態管理與 Undo 復原
│   │   ├── voice-engine.js     # Web Speech API 辨識 + 語音播報 + 合成音效
│   │   └── plugin-manager.js   # 插件註冊與語音指令路由器
│   ├── tools/
│   │   ├── score-tool.js       # ⭐ 加分板
│   │   ├── lottery-tool.js     # 🎲 抽籤機
│   │   ├── roster-tool.js      # 📋 班級與名單匯入
│   │   └── stats-tool.js       # 📊 統計紀錄
│   └── app.js                  # 主程式啟動點
└── gas/
    └── Code.gs                 # Google Apps Script 後端程式
```

---

## 🚀 快速開始

### 步驟 1：先體驗網頁功能（免後端即可試用）
直接用瀏覽器（建議 Chrome 或 Edge）開啟 `index.html`，或是部署到 GitHub Pages / 本機伺服器（**提醒：使用麥克風語音辨識建議透過 `https://` 如 GitHub Pages 或 `http://localhost` 開啟，瀏覽器才能記住麥克風權限**）。

可立即試用的語音／文字指令範例：
* `小幫手幫王小明加一分`（試試看故意打錯同音字 `幫王小名加一分` 也能命中！）
* `小幫手給5號加兩分`
* `小幫手全班加一分` / `小幫手第一組加兩分`
* `小幫手抽籤` / `小幫手抽三位` / `小幫手重置抽籤`
* `小幫手復原`

### 步驟 2：串接 Google 試算表與 GAS 後端
1. 在 Google Drive 新增一份空白的 **Google 試算表**（例如命名為「課堂小幫手資料庫」）。
2. 點擊上方選單 **擴充功能 → Apps Script**。
3. 將專案中 `gas/Code.gs` 的完整程式碼複製貼上，覆蓋編輯器預設內容。
4. 修改第 14 行的 `API_TOKEN` 為你自己設定的密碼（例如 `'my-class-2026'`）並按 `Ctrl + S` 存檔。
5. 在上方工具列選擇函式 `initSheets`，點擊「執行」並授權（首次授權請點進階 → 前往未安全頁面）。執行完後，試算表會自動建立 `Classes`、`Students`、`ScoreLogs`、`ToolLogs`、`Summary` 五個分頁。
6. 點擊右上角 **部署 → 新增部署作業 → 選取類型「網頁應用程式」**：
   * 執行身分：**我**
   * 誰可以存取：**所有人**
7. 複製部署完成後的 **網頁應用程式網址**（結尾為 `/exec`）。
8. 回到網頁右上角點擊 **⚙️ GAS 與語音設定**，貼上網址與剛剛設的 `API_TOKEN`，點「測試 GAS 連線」確認成功後，按「儲存設定」（若要把網頁裡建好的班級名單先傳到試算表，點一下「將目前本機名單上傳至試算表」即可）。

### 步驟 3：如何免費上線給教室電腦用（推薦 GitHub Pages）
1. 在 GitHub 建立一個公開或私人 Repository，把整個 `teacher-assistant` 資料夾（不含 `gas/` 也可）推上去。
2. 到 Repository 的 **Settings → Pages**，選擇 `main` 分支根目錄儲存。
3. 取得 `https://你的帳號.github.io/專案名/`，在教室電腦用 Chrome 開啟並加入書籤即可永久記住麥克風權限！

---

## 🧩 未來如何擴充新功能？（以「倒數計時器」為例）

只要新增 `js/tools/timer-tool.js`，並在 `index.html` 加一行 `<script defer src="js/tools/timer-tool.js"></script>`：

```javascript
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  const TimerTool = {
    id: 'timer',
    name: '計時器',
    icon: '⏱️',
    order: 50,
    commands: [
      {
        pattern: /^倒數([一二兩三四五六七八九十\d]+)(分鐘|分|秒)/,
        handler(match, ctx) {
          const num = ctx.pinyinUtil.parseChineseNumber(match[1]) || 1;
          const unit = match[2];
          // 啟動你的計時器邏輯...
          ctx.voice.speak(`開始倒數${num}${unit}`);
          return `倒數計時 ${num}${unit}`;
        },
      },
    ],
    render(container, ctx) {
      container.innerHTML = `<div class="panel-card"><h2>⏱️ 課堂倒數計時器</h2></div>`;
    },
  };

  TeacherApp.plugins.register(TimerTool);
})(window);
```
若該新工具也需要記錄資料到試算表，直接呼叫 `ctx.store.addToolLog('timer', 'start', { seconds: 180 })` 就會自動寫進試算表的 `ToolLogs` 分頁，連 GAS 後端都不用改！
