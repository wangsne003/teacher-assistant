/**
 * 課堂小幫手 — Google Apps Script 後端 API
 *
 * 使用方式：
 * 1. 新建一份 Google 試算表，點上方選單「擴充功能 -> Apps Script」。
 * 2. 將本檔案全部貼上覆蓋 Code.gs，並修改下方 API_TOKEN 成自己的密碼。
 * 3. 先在編輯器上方選擇 `initSheets` 執行一次（會自動建立所有必要分頁與欄位標題）。
 * 4. 點右上角「部署 -> 新增部署作業 -> 網頁應用程式」：
 *    - 執行身分：我
 *    - 誰可以存取：所有人（安全性由 API_TOKEN 把關）
 * 5. 複製部署後的網頁應用程式網址，貼進前端「⚙️ GAS 與語音設定」即可！
 */

const API_TOKEN = 'CHANGE_ME_YOUR_SECRET_TOKEN'; // 請在 Apps Script 編輯器中改成你自己的安全金鑰

const SHEETS_SCHEMA = {
  Classes: ['class_id', 'class_name', 'created_at'],
  Students: ['student_id', 'class_id', 'seat_no', 'student_no', 'name', 'group_name', 'alias'],
  ScoreLogs: ['log_id', 'timestamp', 'class_id', 'student_id', 'seat_no', 'student_no', 'name', 'delta', 'reason', 'source'],
  ToolLogs: ['log_id', 'timestamp', 'class_id', 'tool_id', 'action', 'detail_json'],
  Summary: ['班級名稱', '座號', '學號', '姓名', '組別', '累計總分'],
};

/**
 * 自動初始化所有必要試算表分頁與統計公式（可重複執行，不會覆蓋既有資料）
 */
function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS_SCHEMA).forEach((name) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    const headers = SHEETS_SCHEMA[name];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eff6ff');
      sheet.setFrozenRows(1);
    }
  });

  // 在 Summary 分頁設定自動彙總公式（自動帶出班級名稱並從 ScoreLogs 即時統計各班每位學生的總分）
  const summarySheet = ss.getSheetByName('Summary');
  if (summarySheet.getLastRow() <= 1) {
    summarySheet
      .getRange('A2')
      .setFormula(
        '=IFERROR(ARRAYFORMULA(IF(Students!A2:A="","", {IFERROR(VLOOKUP(Students!B2:B, Classes!A2:B, 2, FALSE), Students!B2:B), Students!C2:F, SUMIF(ScoreLogs!D2:D, Students!A2:A, ScoreLogs!H2:H)})), "")'
      );
  }
}

function verifyToken_(token) {
  if (!API_TOKEN) return true;
  return String(token || '') === String(API_TOKEN);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function readTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).filter((row) => row.some((cell) => cell !== '')).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
}

function writeTableRows_(sheet, headers, objects) {
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }
  if (objects.length === 0) return;
  const rows = objects.map((obj) => headers.map((h) => (obj[h] !== undefined && obj[h] !== null ? obj[h] : '')));
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/**
 * GET 入口：前端開啟時讀取所有班級、學生名單與統計紀錄
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (!verifyToken_(params.token)) {
      return jsonOut_({ ok: false, error: '金鑰驗證失敗（API_TOKEN 不符）' });
    }

    initSheets();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const action = params.action || 'bootstrap';

    if (action === 'bootstrap') {
      return jsonOut_({
        ok: true,
        classes: readTable_(ss.getSheetByName('Classes')),
        students: readTable_(ss.getSheetByName('Students')),
        scoreLogs: readTable_(ss.getSheetByName('ScoreLogs')),
        toolLogs: readTable_(ss.getSheetByName('ToolLogs')),
      });
    }

    return jsonOut_({ ok: false, error: '未知的 GET action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * POST 統一路由表：未來新增功能只需在這裡多加一個 handler！
 */
const POST_HANDLERS = {
  upsertClass(ss, payload) {
    const sheet = ss.getSheetByName('Classes');
    const list = readTable_(sheet);
    const idx = list.findIndex((c) => String(c.class_id) === String(payload.class_id));
    const item = {
      class_id: payload.class_id,
      class_name: payload.class_name,
      created_at: payload.created_at || new Date().toISOString(),
    };
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    writeTableRows_(sheet, SHEETS_SCHEMA.Classes, list);
    return { saved: item };
  },

  deleteClass(ss, payload) {
    const classId = String(payload.class_id);
    const clsSheet = ss.getSheetByName('Classes');
    const stuSheet = ss.getSheetByName('Students');

    const classes = readTable_(clsSheet).filter((c) => String(c.class_id) !== classId);
    const students = readTable_(stuSheet).filter((s) => String(s.class_id) !== classId);

    writeTableRows_(clsSheet, SHEETS_SCHEMA.Classes, classes);
    writeTableRows_(stuSheet, SHEETS_SCHEMA.Students, students);
    return { deletedClassId: classId };
  },

  importStudents(ss, payload) {
    const classId = String(payload.class_id);
    const mode = payload.mode || 'merge';
    const incoming = Array.isArray(payload.students) ? payload.students : [];
    const sheet = ss.getSheetByName('Students');
    const existing = readTable_(sheet);

    const others = existing.filter((s) => String(s.class_id) !== classId);
    let targetClassStudents = [];

    if (mode === 'replace') {
      targetClassStudents = incoming;
    } else {
      const currentMap = {};
      existing
        .filter((s) => String(s.class_id) === classId)
        .forEach((s) => {
          currentMap[String(s.student_id)] = s;
        });
      incoming.forEach((s) => {
        currentMap[String(s.student_id)] = s;
      });
      targetClassStudents = Object.keys(currentMap).map((k) => currentMap[k]);
    }

    writeTableRows_(sheet, SHEETS_SCHEMA.Students, others.concat(targetClassStudents));
    return { imported: incoming.length };
  },

  deleteStudent(ss, payload) {
    const sheet = ss.getSheetByName('Students');
    const list = readTable_(sheet).filter((s) => String(s.student_id) !== String(payload.student_id));
    writeTableRows_(sheet, SHEETS_SCHEMA.Students, list);
    return { deletedStudentId: payload.student_id };
  },

  syncAllClassesAndStudents(ss, payload) {
    const classes = Array.isArray(payload.classes) ? payload.classes : [];
    const students = Array.isArray(payload.students) ? payload.students : [];
    writeTableRows_(ss.getSheetByName('Classes'), SHEETS_SCHEMA.Classes, classes);
    writeTableRows_(ss.getSheetByName('Students'), SHEETS_SCHEMA.Students, students);
    return { classesCount: classes.length, studentsCount: students.length };
  },

  addScore(ss, payload) {
    const sheet = ss.getSheetByName('ScoreLogs');
    const row = SHEETS_SCHEMA.ScoreLogs.map((h) => (payload[h] !== undefined && payload[h] !== null ? payload[h] : ''));
    sheet.appendRow(row);
    return { log_id: payload.log_id };
  },

  addToolLog(ss, payload) {
    const sheet = ss.getSheetByName('ToolLogs');
    const row = SHEETS_SCHEMA.ToolLogs.map((h) => (payload[h] !== undefined && payload[h] !== null ? payload[h] : ''));
    sheet.appendRow(row);
    return { log_id: payload.log_id };
  },
};

/**
 * POST 入口：加上 LockService 避免短時間連喊加分時發生寫入衝突
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!verifyToken_(body.token)) {
      return jsonOut_({ ok: false, error: '金鑰驗證失敗（API_TOKEN 不符）' });
    }

    initSheets();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const handler = POST_HANDLERS[body.action];
    if (!handler) {
      return jsonOut_({ ok: false, error: '不支援的 POST action: ' + body.action });
    }

    const result = handler(ss, body.payload || {});
    return jsonOut_({ ok: true, result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (_ignore) {}
  }
}
