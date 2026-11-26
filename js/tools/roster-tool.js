/**
 * 工具插件 3：班級與學生名單管理
 * 支援：
 * - 多班級建立、切換與刪除
 * - 匯入學生名單（包含座號、學號、姓名、組別、別名）：
 *   1. 上傳 CSV 檔案（附範本下載）
 *   2. 直接從 Excel / Google 試算表複製貼上（自動偵測 Tab / 逗號分隔與標題列）
 * - 單筆新增 / 刪除 / 匯出 CSV 備份
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  let parsedPreview = [];
  let rawPasteText = '';
  let importMode = 'merge'; // merge | replace

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 簡易 CSV / TSV 行解析器（支援雙引號包住的欄位）
   */
  function splitLine(line, delimiter) {
    if (delimiter === '\t') {
      return line.split('\t').map((v) => v.trim());
    }
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  /**
   * 自動解析 CSV 或 Excel 貼上文字，智慧對應「座號、學號、姓名、組別、別名」欄位
   */
  function parseRosterText(text) {
    const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!cleaned) return [];

    const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // 判斷分隔符號：優先 Tab，否則逗號
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const firstCols = splitLine(lines[0], delimiter);

    // 判斷第一列是否為標題列
    const headerKeywords = ['座號', '學號', '姓名', '名字', '組別', '別名', 'seat', 'student', 'name'];
    const hasHeader = firstCols.some((c) =>
      headerKeywords.some((k) => c.toLowerCase().includes(k))
    );

    let colMap = { seat: 0, studentNo: 1, name: 2, group: 3, alias: 4 };
    let startIdx = 0;

    if (hasHeader) {
      startIdx = 1;
      colMap = { seat: -1, studentNo: -1, name: -1, group: -1, alias: -1 };
      firstCols.forEach((col, i) => {
        const lower = col.toLowerCase();
        if (col.includes('座號') || lower.includes('seat')) colMap.seat = i;
        else if (col.includes('學號') || lower.includes('student_no') || lower.includes('id')) colMap.studentNo = i;
        else if (col.includes('姓名') || col.includes('名字') || lower === 'name') colMap.name = i;
        else if (col.includes('組') || lower.includes('group')) colMap.group = i;
        else if (col.includes('別名') || col.includes('綽號') || lower.includes('alias')) colMap.alias = i;
      });
      // 若標題沒寫完整，給預設容錯
      if (colMap.name === -1 && firstCols.length >= 3) colMap.name = 2;
      if (colMap.name === -1 && firstCols.length === 2) colMap.name = 1;
    } else if (firstCols.length === 2) {
      // 若只有兩欄且沒標題，預設為「座號, 姓名」
      colMap = { seat: 0, studentNo: -1, name: 1, group: -1, alias: -1 };
    }

    const rows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const cols = splitLine(lines[i], delimiter);
      const name = colMap.name >= 0 ? (cols[colMap.name] || '').trim() : '';
      if (!name) continue;

      const rawSeat = colMap.seat >= 0 ? cols[colMap.seat] : '';
      const seatNo = parseInt(String(rawSeat || '').replace(/[^\d]/g, ''), 10) || rows.length + 1;
      const studentNo = colMap.studentNo >= 0 ? (cols[colMap.studentNo] || '').trim() : '';
      const groupName = colMap.group >= 0 ? (cols[colMap.group] || '').trim() : '';
      const alias = colMap.alias >= 0 ? (cols[colMap.alias] || '').trim() : '';

      rows.push({
        seat_no: seatNo,
        student_no: studentNo,
        name,
        group_name: groupName,
        alias,
      });
    }
    return rows;
  }

  function downloadCsv(filename, content) {
    // 加上 UTF-8 BOM 讓 Excel 開啟中文不亂碼
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const RosterTool = {
    id: 'roster',
    name: '班級與名單',
    icon: '📋',
    order: 30,

    commands: [],

    render(container, ctx) {
      const classes = ctx.store.getClasses();
      const activeClass = ctx.store.getActiveClass();
      const activeClassId = ctx.store.getActiveClassId();
      const students = ctx.store.getStudentsByClass(activeClassId);

      container.innerHTML = `
        <div class="two-col-layout">
          <!-- 左側：批次匯入學生名單 -->
          <div class="panel-card">
            <div class="panel-toolbar" style="margin-bottom:10px;">
              <strong style="font-size:16px;">📥 匯入學生名單至「${esc(activeClass ? activeClass.class_name : '')}」</strong>
              <button id="btnDownloadTemplate" class="btn btn-outline btn-sm">⬇️ 下載 CSV 範本</button>
            </div>

            <div class="import-box">
              <div class="form-group">
                <label>方式一：上傳 CSV 檔案（UTF-8）</label>
                <input id="inputCsvFile" type="file" accept=".csv,.txt" class="text-input" />
              </div>

              <div class="form-group">
                <label>方式二：直接從 Excel / 試算表複製貼上</label>
                <textarea
                  id="textareaPasteRoster"
                  class="textarea-input"
                  rows="6"
                  placeholder="可直接貼上含標題列的表格，例如：&#10;座號,學號,姓名,組別,別名&#10;1,1140101,王小明,第一組,小明&#10;2,1140102,陳怡君,第一組,怡君"
                >${esc(rawPasteText)}</textarea>
                <p class="help-text">支援逗號（CSV）或 Tab（Excel 直接複製），自動辨識「座號、學號、姓名、組別、別名」欄位。</p>
              </div>

              <div class="form-row-2" style="align-items:end;margin-bottom:12px;">
                <div class="form-group" style="margin-bottom:0;">
                  <label>匯入模式</label>
                  <select id="selectImportMode" class="select-input" style="width:100%;">
                    <option value="merge" ${importMode === 'merge' ? 'selected' : ''}>合併／更新名單（保留既有學生）</option>
                    <option value="replace" ${importMode === 'replace' ? 'selected' : ''}>覆蓋目前班級全部名單</option>
                  </select>
                </div>
                <div class="btn-row" style="margin-top:0;">
                  <button id="btnParsePreview" type="button" class="btn btn-secondary btn-sm">🔍 解析預覽</button>
                  <button id="btnConfirmImport" type="button" class="btn btn-primary btn-sm" ${parsedPreview.length === 0 ? 'disabled' : ''}>
                    ✅ 確認匯入（${parsedPreview.length} 人）
                  </button>
                </div>
              </div>

              ${
                parsedPreview.length > 0
                  ? `
                  <div class="data-table-wrap" style="max-height:220px;overflow-y:auto;">
                    <table class="data-table">
                      <thead>
                        <tr><th>座號</th><th>學號</th><th>姓名</th><th>組別</th><th>別名</th></tr>
                      </thead>
                      <tbody>
                        ${parsedPreview
                          .map(
                            (r) => `
                            <tr>
                              <td>${esc(r.seat_no)}</td>
                              <td>${esc(r.student_no || '-')}</td>
                              <td><strong>${esc(r.name)}</strong></td>
                              <td>${esc(r.group_name || '-')}</td>
                              <td>${esc(r.alias || '-')}</td>
                            </tr>
                          `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  </div>
                  `
                  : ''
              }
            </div>

            <!-- 單筆快速新增學生 -->
            <div class="import-box" style="margin-top:14px;">
              <strong style="font-size:14px;display:block;margin-bottom:10px;">➕ 單筆新增學生</strong>
              <form id="singleStudentForm" class="form-row-2">
                <input id="ssSeat" class="text-input" type="number" min="1" placeholder="座號（如 7）" required />
                <input id="ssNo" class="text-input" type="text" placeholder="學號（如 1140107）" required />
                <input id="ssName" class="text-input" type="text" placeholder="姓名（必填）" required />
                <input id="ssGroup" class="text-input" type="text" placeholder="組別（選填，如 第三組）" />
                <input id="ssAlias" class="text-input" type="text" placeholder="別名/語音提示（選填）" />
                <button type="submit" class="btn btn-primary btn-sm">加入此班級</button>
              </form>
            </div>
          </div>

          <!-- 右側：班級列表與目前班級學生明細 -->
          <div class="panel-card">
            <div class="panel-toolbar" style="margin-bottom:10px;">
              <strong style="font-size:16px;">🏫 班級管理（共 ${classes.length} 班）</strong>
              <button id="btnExportClassCsv" class="btn btn-outline btn-sm" ${students.length === 0 ? 'disabled' : ''}>📤 匯出本班 CSV</button>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
              ${classes
                .map(
                  (c) => `
                  <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;border:1px solid ${c.class_id === activeClassId ? '#2563eb' : '#cbd5e1'};background:${c.class_id === activeClassId ? '#eff6ff' : '#fff'};">
                    <button class="btn-switch-cls" data-id="${esc(c.class_id)}" style="border:none;background:none;font-weight:700;cursor:pointer;color:${c.class_id === activeClassId ? '#1d4ed8' : '#334155'};">
                      ${esc(c.class_name)}
                    </button>
                    ${
                      classes.length > 1
                        ? `<button class="btn-del-cls" data-id="${esc(c.class_id)}" title="刪除此班級" style="border:none;background:none;color:#dc2626;cursor:pointer;font-size:13px;">✕</button>`
                        : ''
                    }
                  </div>
                `
                )
                .join('')}
            </div>

            <h3 style="margin:0 0 8px;font-size:14px;color:#475569;">
              「${esc(activeClass ? activeClass.class_name : '')}」目前學生名單（${students.length} 人）
            </h3>

            ${
              students.length === 0
                ? `<div class="empty-state">這個班級還沒有學生，請從左側匯入 CSV 或貼上 Excel 名單。</div>`
                : `<div class="data-table-wrap" style="max-height:460px;overflow-y:auto;">
                    <table class="data-table">
                      <thead>
                        <tr><th>座號</th><th>學號</th><th>姓名</th><th>組別</th><th>別名</th><th>操作</th></tr>
                      </thead>
                      <tbody>
                        ${students
                          .map(
                            (s) => `
                            <tr>
                              <td>${esc(s.seat_no)}</td>
                              <td>${esc(s.student_no || '-')}</td>
                              <td><strong>${esc(s.name)}</strong></td>
                              <td>${esc(s.group_name || '-')}</td>
                              <td>${esc(s.alias || '-')}</td>
                              <td>
                                <button class="btn btn-ghost btn-sm btn-del-student" data-id="${esc(s.student_id)}" style="color:#dc2626;">刪除</button>
                              </td>
                            </tr>
                          `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  </div>`
            }
          </div>
        </div>
      `;

      // 下載 CSV 範本
      container.querySelector('#btnDownloadTemplate').addEventListener('click', () => {
        const sample = [
          '座號,學號,姓名,組別,別名',
          '1,1140101,王小明,第一組,小明',
          '2,1140102,陳怡君,第一組,怡君',
          '3,1140103,林志豪,第二組,志豪',
        ].join('\n');
        downloadCsv('學生名單範本.csv', sample);
      });

      // 上傳 CSV 檔
      container.querySelector('#inputCsvFile').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          rawPasteText = String(reader.result || '');
          parsedPreview = parseRosterText(rawPasteText);
          ctx.toast(`已解析 ${parsedPreview.length} 筆學生資料，請確認預覽後按下「確認匯入」`, 'success');
          RosterTool.render(container, ctx);
        };
        reader.readAsText(file, 'UTF-8');
      });

      // 貼上文字
      const pasteEl = container.querySelector('#textareaPasteRoster');
      pasteEl.addEventListener('input', (e) => {
        rawPasteText = e.target.value;
      });

      container.querySelector('#selectImportMode').addEventListener('change', (e) => {
        importMode = e.target.value;
      });

      container.querySelector('#btnParsePreview').addEventListener('click', () => {
        rawPasteText = pasteEl.value;
        parsedPreview = parseRosterText(rawPasteText);
        if (parsedPreview.length === 0) {
          ctx.toast('無法解析出有效學生資料，請確認至少有姓名欄位', 'warning');
        } else {
          ctx.toast(`解析成功：共 ${parsedPreview.length} 位學生`, 'success');
        }
        RosterTool.render(container, ctx);
      });

      container.querySelector('#btnConfirmImport').addEventListener('click', () => {
        if (parsedPreview.length === 0) return;
        try {
          const count = ctx.store.importStudents(activeClassId, parsedPreview, importMode);
          parsedPreview = [];
          rawPasteText = '';
          ctx.toast(`已成功匯入 ${count} 位學生至「${activeClass.class_name}」`, 'success');
          RosterTool.render(container, ctx);
        } catch (err) {
          ctx.toast(err.message, 'error');
        }
      });

      // 單筆新增學生
      container.querySelector('#singleStudentForm').addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          ctx.store.upsertSingleStudent(activeClassId, {
            seat_no: container.querySelector('#ssSeat').value,
            student_no: container.querySelector('#ssNo').value,
            name: container.querySelector('#ssName').value,
            group_name: container.querySelector('#ssGroup').value,
            alias: container.querySelector('#ssAlias').value,
          });
          ctx.toast('已加入學生資料', 'success');
          RosterTool.render(container, ctx);
        } catch (err) {
          ctx.toast(err.message, 'error');
        }
      });

      // 切換班級
      container.querySelectorAll('.btn-switch-cls').forEach((btn) => {
        btn.addEventListener('click', () => {
          ctx.store.setActiveClass(btn.dataset.id);
        });
      });

      // 刪除班級
      container.querySelectorAll('.btn-del-cls').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = classes.find((c) => c.class_id === btn.dataset.id);
          if (!target) return;
          if (!global.confirm(`確定要刪除「${target.class_name}」及其學生名單嗎？`)) return;
          try {
            ctx.store.deleteClass(target.class_id);
            ctx.toast(`已刪除班級「${target.class_name}」`, 'warning');
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        });
      });

      // 刪除單筆學生
      container.querySelectorAll('.btn-del-student').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!global.confirm('確定要刪除此位學生嗎？（歷史加分流水帳仍會保留）')) return;
          ctx.store.deleteStudent(btn.dataset.id);
          ctx.toast('已刪除學生', 'warning');
          RosterTool.render(container, ctx);
        });
      });

      // 匯出本班 CSV
      container.querySelector('#btnExportClassCsv').addEventListener('click', () => {
        const header = '座號,學號,姓名,組別,別名,目前總分';
        const scoresMap = ctx.store.getScoresMap(activeClassId);
        const lines = students.map((s) =>
          [
            s.seat_no,
            s.student_no || '',
            s.name,
            s.group_name || '',
            s.alias || '',
            scoresMap.get(s.student_id) || 0,
          ]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(',')
        );
        downloadCsv(`${activeClass.class_name}_名單與分數.csv`, [header, ...lines].join('\n'));
      });
    },
  };

  TeacherApp.plugins.register(RosterTool);
})(window);
