/**
 * 工具插件 4：統計與流水帳紀錄
 * 顯示目前班級的排行榜、加扣分明細、抽籤紀錄，並支援匯出統計報表。
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(iso) {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.toLocaleString('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (_e) {
      return iso;
    }
  }

  const StatsTool = {
    id: 'stats',
    name: '統計紀錄',
    icon: '📊',
    order: 40,

    commands: [
      {
        pattern: /^(?:查看|打開|顯示)(?:統計|排行榜|紀錄)/,
        description: '開啟統計與排行榜面板',
        handler(_match, ctx) {
          ctx.voice.speak('已切換到統計紀錄');
          return '已開啟統計紀錄';
        },
      },
    ],

    render(container, ctx) {
      const activeClass = ctx.store.getActiveClass();
      const students = ctx.store.getStudentsByClass();
      const scoresMap = ctx.store.getScoresMap();
      const scoreLogs = ctx.store.getScoreLogsByClass();
      const toolLogs = ctx.store.getToolLogsByClass();

      const totalPlus = scoreLogs
        .filter((l) => Number(l.delta) > 0)
        .reduce((sum, l) => sum + Number(l.delta), 0);
      const voiceCount = scoreLogs.filter((l) => l.source === 'voice').length;

      const ranking = students
        .map((s) => ({ ...s, score: scoresMap.get(s.student_id) || 0 }))
        .sort((a, b) => b.score - a.score || a.seat_no - b.seat_no);

      container.innerHTML = `
        <div class="panel-card">
          <div class="panel-toolbar">
            <strong style="font-size:16px;">📊 ${esc(activeClass ? activeClass.class_name : '')} 課堂統計與紀錄</strong>
            <span class="help-text">所有紀錄皆會自動背景同步至 Google 試算表（GAS）</span>
          </div>

          <div class="stat-summary-grid">
            <div class="stat-kpi">
              <div class="stat-kpi-label">班級人數</div>
              <div class="stat-kpi-val">${students.length}</div>
            </div>
            <div class="stat-kpi">
              <div class="stat-kpi-label">累計總加分</div>
              <div class="stat-kpi-val" style="color:#16a34a;">+${totalPlus}</div>
            </div>
            <div class="stat-kpi">
              <div class="stat-kpi-label">加扣分筆數（語音觸發）</div>
              <div class="stat-kpi-val">${scoreLogs.length} <span style="font-size:15px;color:#64748b;">(${voiceCount})</span></div>
            </div>
            <div class="stat-kpi">
              <div class="stat-kpi-label">抽籤／工具使用次數</div>
              <div class="stat-kpi-val">${toolLogs.length}</div>
            </div>
          </div>

          <div class="two-col-layout">
            <div>
              <h3 style="margin:0 0 8px;font-size:15px;">🏆 積分排行榜</h3>
              <div class="data-table-wrap" style="max-height:380px;overflow-y:auto;">
                <table class="data-table">
                  <thead>
                    <tr><th>名次</th><th>座號</th><th>學號</th><th>姓名</th><th>組別</th><th>總分</th></tr>
                  </thead>
                  <tbody>
                    ${
                      ranking.length === 0
                        ? '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">尚無資料</td></tr>'
                        : ranking
                            .map(
                              (s, idx) => `
                              <tr>
                                <td><strong>#${idx + 1}</strong></td>
                                <td>${esc(s.seat_no)}</td>
                                <td>${esc(s.student_no || '-')}</td>
                                <td><strong>${esc(s.name)}</strong></td>
                                <td>${esc(s.group_name || '-')}</td>
                                <td style="font-weight:800;color:${s.score < 0 ? '#dc2626' : '#2563eb'};">${s.score}</td>
                              </tr>
                            `
                            )
                            .join('')
                    }
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 style="margin:0 0 8px;font-size:15px;">🧾 最近加扣分流水帳</h3>
              <div class="data-table-wrap" style="max-height:380px;overflow-y:auto;">
                <table class="data-table">
                  <thead>
                    <tr><th>時間</th><th>學生</th><th>變動</th><th>原因</th><th>來源</th></tr>
                  </thead>
                  <tbody>
                    ${
                      scoreLogs.length === 0
                        ? '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">尚無加扣分紀錄</td></tr>'
                        : scoreLogs
                            .slice(0, 60)
                            .map(
                              (l) => `
                              <tr>
                                <td style="white-space:nowrap;">${esc(formatTime(l.timestamp))}</td>
                                <td>${esc(l.seat_no)}號 ${esc(l.name)}</td>
                                <td style="font-weight:800;color:${l.delta >= 0 ? '#16a34a' : '#dc2626'};">
                                  ${l.delta >= 0 ? '+' : ''}${l.delta}
                                </td>
                                <td>${esc(l.reason)}</td>
                                <td>${l.source === 'voice' ? '🎙️語音' : l.source === 'undo' ? '↩復原' : '👆手動'}</td>
                              </tr>
                            `
                            )
                            .join('')
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `;
    },
  };

  TeacherApp.plugins.register(StatsTool);
})(window);
