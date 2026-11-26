/**
 * 工具插件 2：課堂抽籤機
 * 支援語音指令：
 * - 「抽籤」「抽一位」「點一位」「抽三位」
 * - 「重置抽籤」「清空抽籤」
 * 特色：支援各班級獨立不重複抽籤池、抽中後可直接一鍵幫中獎學生加分！
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  // 依 classId 各自維護抽籤池狀態
  const poolByClass = new Map();
  let noRepeat = true;
  let drawCount = 1;
  let lastWinners = [];
  let isRolling = false;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getDrawnSet(classId) {
    if (!poolByClass.has(classId)) {
      poolByClass.set(classId, new Set());
    }
    return poolByClass.get(classId);
  }

  function executeDraw(ctx, count, container) {
    const classId = ctx.store.getActiveClassId();
    const students = ctx.store.getStudentsByClass(classId);
    if (students.length === 0) {
      const msg = '目前班級還沒有學生名單，無法抽籤';
      ctx.voice.speak(msg);
      ctx.toast(msg, 'warning');
      return msg;
    }

    const drawnSet = getDrawnSet(classId);
    let available = noRepeat
      ? students.filter((s) => !drawnSet.has(s.student_id))
      : students.slice();

    if (available.length === 0) {
      // 全班都抽過一輪，自動重置
      drawnSet.clear();
      available = students.slice();
      ctx.toast('本班所有同學皆已抽過一輪，已自動開始新一輪抽籤！', 'warning');
    }

    const actualCount = Math.min(Math.max(1, count || 1), available.length);

    // Fisher-Yates 洗牌抽選
    const shuffled = available.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const winners = shuffled.slice(0, actualCount);

    if (noRepeat) {
      for (const w of winners) drawnSet.add(w.student_id);
    }

    lastWinners = winners;

    // 紀錄到通用 ToolLogs（會同步至 GAS 試算表）
    ctx.store.addToolLog('lottery', 'draw', {
      count: actualCount,
      winners: winners.map((w) => ({
        seat_no: w.seat_no,
        student_no: w.student_no,
        name: w.name,
      })),
    });

    ctx.voice.playSound('win');
    const namesSpoken = winners.map((w) => `${w.seat_no}號${w.name}`).join('、');
    const msg = `抽中了：${namesSpoken}`;
    ctx.voice.speak(`抽中，${namesSpoken}`);
    ctx.toast(msg, 'success');

    if (container) {
      LotteryTool.render(container, ctx);
    }
    return msg;
  }

  const LotteryTool = {
    id: 'lottery',
    name: '抽籤機',
    icon: '🎲',
    order: 20,

    commands: [
      {
        pattern: /^(?:重置|重新|清空)抽籤/,
        description: '重置不重複抽籤池（例：重置抽籤）',
        handler(_match, ctx) {
          const classId = ctx.store.getActiveClassId();
          getDrawnSet(classId).clear();
          lastWinners = [];
          const msg = '已重置本班抽籤名單';
          ctx.voice.speak(msg);
          ctx.toast(msg, 'success');
          return msg;
        },
      },
      {
        pattern: /^(?:幫我)?(?:抽籤|抽人|點名抽籤|抽一個|抽一位|點一位|抽([一二兩三四五六七八九十\d]+)(?:位|個|人)?)/,
        description: '隨機抽籤叫出學生（例：抽籤、抽三位）',
        handler(match, ctx) {
          const rawCount = match[1];
          const count = rawCount ? ctx.pinyinUtil.parseChineseNumber(rawCount) || 1 : 1;
          return executeDraw(ctx, count);
        },
      },
    ],

    render(container, ctx) {
      const classId = ctx.store.getActiveClassId();
      const activeClass = ctx.store.getActiveClass();
      const students = ctx.store.getStudentsByClass(classId);
      const drawnSet = getDrawnSet(classId);

      // 過濾掉非目前班級的舊中獎人
      const currentWinners = lastWinners.filter((w) => w.class_id === classId);
      const remainingCount = students.filter((s) => !drawnSet.has(s.student_id)).length;

      container.innerHTML = `
        <div class="panel-card">
          <div class="panel-toolbar">
            <div class="toolbar-group">
              <strong style="font-size:16px;">🎲 ${esc(activeClass ? activeClass.class_name : '')} 課堂抽籤機</strong>
              <label class="select-input" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="chkLotteryNoRepeat" ${noRepeat ? 'checked' : ''} />
                <span>不重複抽籤（剩餘 ${remainingCount} / ${students.length} 人）</span>
              </label>
            </div>
            <div class="toolbar-group">
              <label style="font-size:13px;font-weight:600;">一次抽：</label>
              <select id="selectDrawCount" class="select-input">
                ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${drawCount === n ? 'selected' : ''}>${n} 位</option>`).join('')}
              </select>
              <button id="btnResetLottery" class="btn btn-outline btn-sm">↻ 重置已抽名單</button>
            </div>
          </div>

          <div class="lottery-stage">
            <div id="lotteryResultBox" class="lottery-result-box">
              ${
                currentWinners.length === 0
                  ? `<div style="color:#64748b;font-size:18px;font-weight:600;">
                      按下下方按鈕，或直接說「小幫手抽籤」！
                    </div>`
                  : currentWinners
                      .map(
                        (w) => `
                        <div class="lottery-winner">
                          <div class="lottery-winner-seat">${esc(w.seat_no)} 號 ${w.group_name ? `· ${esc(w.group_name)}` : ''}</div>
                          <div class="lottery-winner-name">${esc(w.name)}</div>
                          <div class="lottery-winner-no">學號：${esc(w.student_no || '-')}</div>
                          <div class="lottery-winner-actions">
                            <button class="btn btn-success btn-sm btn-winner-score" data-id="${esc(w.student_id)}" data-delta="1">⭐ 回答正確 +1</button>
                            <button class="btn btn-primary btn-sm btn-winner-score" data-id="${esc(w.student_id)}" data-delta="2">🌟 表現優異 +2</button>
                          </div>
                        </div>
                      `
                      )
                      .join('')
              }
            </div>

            <button id="btnStartLottery" class="btn btn-primary btn-lg" ${students.length === 0 || isRolling ? 'disabled' : ''}>
              🎯 開始抽籤（抽 ${drawCount} 位）
            </button>
          </div>

          <div>
            <h3 style="margin:0 0 10px;font-size:14px;color:#475569;">本班抽籤池狀態（灰色刪除線代表本輪已抽過）</h3>
            ${
              students.length === 0
                ? `<p class="help-text">尚無學生名單，請先至「班級與名單管理」匯入學生。</p>`
                : `<div class="lottery-pool-chips">
                    ${students
                      .map((s) => {
                        const isDrawn = noRepeat && drawnSet.has(s.student_id);
                        return `<span class="pool-chip ${isDrawn ? 'drawn' : ''}">${esc(s.seat_no)}號 ${esc(s.name)}</span>`;
                      })
                      .join('')}
                  </div>`
            }
          </div>
        </div>
      `;

      container.querySelector('#chkLotteryNoRepeat').addEventListener('change', (e) => {
        noRepeat = e.target.checked;
        LotteryTool.render(container, ctx);
      });

      container.querySelector('#selectDrawCount').addEventListener('change', (e) => {
        drawCount = parseInt(e.target.value, 10) || 1;
        LotteryTool.render(container, ctx);
      });

      container.querySelector('#btnResetLottery').addEventListener('click', () => {
        drawnSet.clear();
        lastWinners = [];
        ctx.toast('已重置抽籤池', 'success');
        LotteryTool.render(container, ctx);
      });

      const btnStart = container.querySelector('#btnStartLottery');
      if (btnStart) {
        btnStart.addEventListener('click', () => {
          if (isRolling || students.length === 0) return;
          isRolling = true;
          btnStart.disabled = true;

          // 短暫滾動動畫增加課堂期待感
          const box = container.querySelector('#lotteryResultBox');
          let ticks = 0;
          const timer = setInterval(() => {
            ticks += 1;
            const rand = students[Math.floor(Math.random() * students.length)];
            box.innerHTML = `
              <div class="lottery-winner" style="opacity:0.8;">
                <div class="lottery-winner-seat">${esc(rand.seat_no)} 號</div>
                <div class="lottery-winner-name">${esc(rand.name)}</div>
              </div>
            `;
            if (ticks >= 10) {
              clearInterval(timer);
              isRolling = false;
              executeDraw(ctx, drawCount, container);
            }
          }, 70);
        });
      }

      container.querySelectorAll('.btn-winner-score').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.id;
          const delta = parseInt(btn.dataset.delta, 10);
          const student = students.find((s) => s.student_id === sid);
          if (!student) return;
          ctx.store.addScore(sid, delta, '抽籤回答加分', 'manual');
          ctx.voice.playSound('plus');
          ctx.voice.speak(`已幫${student.name}加${delta}分`);
          ctx.toast(`已幫 ${student.name} +${delta} 分`, 'success');
        });
      });
    },
  };

  TeacherApp.plugins.register(LotteryTool);
})(window);
