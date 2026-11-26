/**
 * 工具插件 1：課堂加分板
 * 支援語音指令：
 * - 「幫王小明加一分」「給 5 號扣 2 分」「王小名加三分」
 * - 「全班加一分」「第一組加兩分」
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  let sortBy = 'seat'; // seat | score | name
  let filterGroup = 'ALL';
  let searchKeyword = '';
  let lastFlashed = null; // { studentId, type: 'plus'|'minus', ts }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function applyScore(ctx, student, delta, reason, source) {
    ctx.store.addScore(student.student_id, delta, reason, source);
    lastFlashed = {
      studentId: student.student_id,
      type: delta >= 0 ? 'plus' : 'minus',
      ts: Date.now(),
    };
    ctx.voice.playSound(delta >= 0 ? 'plus' : 'minus');
  }

  const ScoreTool = {
    id: 'score',
    name: '加分板',
    icon: '⭐',
    order: 10,

    setSort(mode) {
      if (['seat', 'score', 'name'].includes(mode)) sortBy = mode;
    },

    setGroupFilter(group) {
      filterGroup = group || 'ALL';
    },

    flashStudent(studentId, type) {
      lastFlashed = { studentId, type: type || 'plus', ts: Date.now() };
    },

    commands: [
      {
        // 全班加減分，例如：「全班加一分」「幫全班加 2 分」
        pattern: /^(?:幫|給)?全班(加|扣)([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/,
        description: '全班加扣分（例：全班加一分）',
        handler(match, ctx) {
          const [, op, rawNum, reason] = match;
          const num = ctx.pinyinUtil.parseChineseNumber(rawNum) || 1;
          const delta = op === '加' ? num : -num;
          const students = ctx.store.getStudentsByClass();
          if (students.length === 0) {
            ctx.voice.speak('這個班級還沒有學生名單');
            return '目前班級尚無學生';
          }
          ctx.store.addBatchScore(
            students.map((s) => s.student_id),
            delta,
            reason || `全班${op}分`,
            'voice'
          );
          ctx.voice.playSound(delta >= 0 ? 'plus' : 'minus');
          const msg = `已幫全班 ${students.length} 位同學${op} ${num} 分`;
          ctx.voice.speak(msg);
          ctx.toast(msg, 'success');
          return msg;
        },
      },
      {
        // 組別加減分，例如：「幫第一組加兩分」「第2組扣1分」
        pattern: /^(?:幫|給)?(第?[一二兩三四五六七八九十\d]+組)(加|扣)([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/,
        description: '整組加扣分（例：第一組加兩分）',
        handler(match, ctx) {
          const [, rawGroup, op, rawNum, reason] = match;
          const num = ctx.pinyinUtil.parseChineseNumber(rawNum) || 1;
          const delta = op === '加' ? num : -num;
          const students = ctx.store.getStudentsByClass();

          // 同時比對「第一組」與「第1組」與「1組」
          const gNumMatch = rawGroup.match(/([一二兩三四五六七八九十\d]+)/);
          const gNum = gNumMatch ? ctx.pinyinUtil.parseChineseNumber(gNumMatch[1]) : null;

          const matched = students.filter((s) => {
            if (!s.group_name) return false;
            if (s.group_name === rawGroup) return true;
            if (gNum !== null) {
              const sNumMatch = s.group_name.match(/([一二兩三四五六七八九十\d]+)/);
              if (sNumMatch && ctx.pinyinUtil.parseChineseNumber(sNumMatch[1]) === gNum) {
                return true;
              }
            }
            return false;
          });

          if (matched.length === 0) {
            const msg = `找不到「${rawGroup}」的學生`;
            ctx.voice.speak(msg);
            ctx.toast(msg, 'warning');
            return msg;
          }

          ctx.store.addBatchScore(
            matched.map((s) => s.student_id),
            delta,
            reason || `${rawGroup}${op}分`,
            'voice'
          );
          ctx.voice.playSound(delta >= 0 ? 'plus' : 'minus');
          const msg = `已幫${rawGroup}（${matched.length}人）${op} ${num} 分`;
          ctx.voice.speak(msg);
          ctx.toast(msg, 'success');
          return msg;
        },
      },
      {
        // 單人加減分，例如：「幫王小名加一分」「給 5 號加 2 分」「王小明扣一分」
        pattern: /^(?:請)?(?:幫|給|替)?(.+?)(加|扣|減)([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/,
        description: '幫指定學生加扣分（例：幫王小明加一分、給5號加2分）',
        handler(match, ctx) {
          const [, rawTarget, op, rawNum, reason] = match;
          const num = ctx.pinyinUtil.parseChineseNumber(rawNum);
          if (!num || num <= 0) return '無法辨識分數數字';

          const delta = op === '加' ? num : -num;
          const students = ctx.store.getStudentsByClass();
          const hit = ctx.pinyinUtil.findStudentByQuery(rawTarget, students);

          if (!hit) {
            const msg = `找不到名為「${rawTarget.trim()}」的學生`;
            ctx.voice.speak(msg);
            ctx.toast(msg, 'warning');
            return msg;
          }

          applyScore(ctx, hit.student, delta, reason || '', 'voice');
          const newScore = ctx.store.getStudentScore(hit.student.student_id);
          const opText = delta > 0 ? '加' : '扣';
          const fuzzyNote = hit.matchType === 'homophone' || hit.matchType === 'fuzzy'
            ? `（同音比對「${rawTarget.trim()}」）`
            : '';
          const msg = `已幫 ${hit.student.seat_no}號 ${hit.student.name} ${opText} ${num} 分（總分 ${newScore}）${fuzzyNote}`;

          ctx.voice.speak(`已幫${hit.student.name}${opText}${num}分`);
          ctx.toast(msg, delta > 0 ? 'success' : 'warning');
          return msg;
        },
      },
    ],

    render(container, ctx) {
      const activeClass = ctx.store.getActiveClass();
      const students = ctx.store.getStudentsByClass();
      const scoresMap = ctx.store.getScoresMap();

      // 取得該班所有組別
      const groups = Array.from(new Set(students.map((s) => s.group_name).filter(Boolean)));
      if (filterGroup !== 'ALL' && !groups.includes(filterGroup)) {
        filterGroup = 'ALL';
      }

      // 篩選與排序
      let displayList = students.filter((s) => {
        if (filterGroup !== 'ALL' && s.group_name !== filterGroup) return false;
        if (searchKeyword) {
          const kw = searchKeyword.toLowerCase();
          return (
            String(s.name).toLowerCase().includes(kw) ||
            String(s.seat_no).includes(kw) ||
            String(s.student_no || '').toLowerCase().includes(kw)
          );
        }
        return true;
      });

      displayList = displayList.slice().sort((a, b) => {
        if (sortBy === 'score') {
          return (scoresMap.get(b.student_id) || 0) - (scoresMap.get(a.student_id) || 0);
        }
        if (sortBy === 'name') {
          return String(a.name).localeCompare(String(b.name), 'zh-Hant');
        }
        return (parseInt(a.seat_no, 10) || 999) - (parseInt(b.seat_no, 10) || 999);
      });

      const isFlashValid = lastFlashed && Date.now() - lastFlashed.ts < 1500;

      container.innerHTML = `
        <div class="panel-card">
          <div class="panel-toolbar">
            <div class="toolbar-group">
              <strong style="font-size:16px;">${esc(activeClass ? activeClass.class_name : '')} 加分板（共 ${students.length} 人）</strong>
              <input id="scoreSearchInput" class="text-input" style="width:180px;" placeholder="搜尋座號/學號/姓名" value="${esc(searchKeyword)}" />
              ${
                groups.length > 0
                  ? `<select id="scoreGroupFilter" class="select-input">
                      <option value="ALL">全部組別</option>
                      ${groups.map((g) => `<option value="${esc(g)}" ${filterGroup === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
                    </select>`
                  : ''
              }
            </div>
            <div class="toolbar-group">
              <select id="scoreSortSelect" class="select-input" title="排序方式">
                <option value="seat" ${sortBy === 'seat' ? 'selected' : ''}>依座號排序</option>
                <option value="score" ${sortBy === 'score' ? 'selected' : ''}>依總分高到低</option>
                <option value="name" ${sortBy === 'name' ? 'selected' : ''}>依姓名排序</option>
              </select>
              <button id="btnAllPlusOne" class="btn btn-success btn-sm" ${students.length === 0 ? 'disabled' : ''}>🌟 全班 +1 分</button>
            </div>
          </div>

          ${
            displayList.length === 0
              ? `<div class="empty-state">
                  <p>目前沒有符合的學生資料。</p>
                  <button id="btnGoImportRoster" class="btn btn-primary btn-sm">前往匯入學生名單</button>
                </div>`
              : `<div class="student-grid">
                  ${displayList
                    .map((s) => {
                      const score = scoresMap.get(s.student_id) || 0;
                      const flashCls =
                        isFlashValid && lastFlashed.studentId === s.student_id
                          ? lastFlashed.type === 'plus'
                            ? 'flash-plus'
                            : 'flash-minus'
                          : '';
                      return `
                        <div class="student-card ${flashCls}" data-student-id="${esc(s.student_id)}">
                          <div class="student-meta">
                            <span class="seat-badge">${esc(s.seat_no)} 號</span>
                            ${s.group_name ? `<span class="group-tag">${esc(s.group_name)}</span>` : '<span></span>'}
                          </div>
                          <div class="student-name">${esc(s.name)}</div>
                          <div class="student-no">學號：${esc(s.student_no || '-')}</div>
                          <div class="score-display ${score < 0 ? 'negative' : ''}">${score}</div>
                          <div class="score-actions">
                            <button class="btn-score btn-score-minus" data-delta="-1" title="扣 1 分">-1</button>
                            <button class="btn-score btn-score-plus1" data-delta="1" title="加 1 分">+1</button>
                            <button class="btn-score btn-score-plus2" data-delta="2" title="加 2 分">+2</button>
                          </div>
                        </div>
                      `;
                    })
                    .join('')}
                </div>`
          }
        </div>
      `;

      // 綁定互動事件
      const searchEl = container.querySelector('#scoreSearchInput');
      if (searchEl) {
        searchEl.addEventListener('input', (e) => {
          searchKeyword = e.target.value;
          ScoreTool.render(container, ctx);
          const refocus = container.querySelector('#scoreSearchInput');
          if (refocus) {
            refocus.focus();
            refocus.setSelectionRange(searchKeyword.length, searchKeyword.length);
          }
        });
      }

      const groupEl = container.querySelector('#scoreGroupFilter');
      if (groupEl) {
        groupEl.addEventListener('change', (e) => {
          filterGroup = e.target.value;
          ScoreTool.render(container, ctx);
        });
      }

      const sortEl = container.querySelector('#scoreSortSelect');
      if (sortEl) {
        sortEl.addEventListener('change', (e) => {
          sortBy = e.target.value;
          ScoreTool.render(container, ctx);
        });
      }

      const btnAll = container.querySelector('#btnAllPlusOne');
      if (btnAll) {
        btnAll.addEventListener('click', () => {
          ctx.store.addBatchScore(
            displayList.map((s) => s.student_id),
            1,
            filterGroup === 'ALL' ? '全班加分' : `${filterGroup}加分`,
            'manual'
          );
          ctx.voice.playSound('plus');
          ctx.toast(`已幫畫面中 ${displayList.length} 位同學各 +1 分`, 'success');
          ScoreTool.render(container, ctx);
        });
      }

      const btnGoImport = container.querySelector('#btnGoImportRoster');
      if (btnGoImport) {
        btnGoImport.addEventListener('click', () => ctx.plugins.activate('roster'));
      }

      container.querySelectorAll('.student-card .btn-score').forEach((btn) => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.student-card');
          const studentId = card.dataset.studentId;
          const delta = parseInt(btn.dataset.delta, 10);
          const student = students.find((s) => s.student_id === studentId);
          if (!student) return;
          applyScore(ctx, student, delta, '', 'manual');
          ScoreTool.render(container, ctx);
        });
      });
    },
  };

  TeacherApp.plugins.register(ScoreTool);
})(window);
