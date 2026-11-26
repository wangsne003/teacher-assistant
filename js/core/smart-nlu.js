/**
 * 雙層智慧口語指令引擎（Smart NLU）
 *
 * 1. 多暱稱喚醒詞偵測（支援「小幫手, 麥克, Mike」＋拼音同音容錯，如「麥可」也能喚醒「麥克」）
 * 2. 第一層（本地零延遲 NLU）：支援自然口語（「我要抽籤」「幫我切到七年乙班」「依分數排序」「王小明幾分」等全網頁命令）
 * 3. 第二層（選配 Gemini AI 備援）：若使用者在設定中填入 Gemini API Key，本地未命中時自動交由 Gemini 解析複雜口語並執行
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  function parseWakeWords(wakeWordSetting) {
    const raw = String(wakeWordSetting || '小幫手');
    const list = raw
      .split(/[,，、;；/|]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    return list.length > 0 ? list : ['小幫手'];
  }

  /**
   * 檢查句子中是否包含任一喚醒詞（支援精準比對、英文不分大小寫、以及中文同音拼音滑動視窗比對）
   */
  function matchWakeWord(rawText, wakeWordSetting) {
    const text = String(rawText || '').trim();
    if (!text) return { matched: false, commandText: '' };

    const aliases = parseWakeWords(wakeWordSetting);
    const lowerText = text.toLowerCase();

    // 1. 精準子字串比對（不分大小寫）
    for (const alias of aliases) {
      const idx = lowerText.indexOf(alias.toLowerCase());
      if (idx !== -1) {
        const rest = text.slice(idx + alias.length).replace(/^[，,、。！？!?\s]+/, '').trim();
        return { matched: true, matchedAlias: alias, commandText: rest };
      }
    }

    // 2. 中文拼音同音滑動視窗比對（例如設定「麥克」，辨識成「麥可」「邁克」也能命中）
    const pyUtil = TeacherApp.pinyinUtil;
    if (pyUtil && typeof pyUtil.toPlainPinyin === 'function') {
      const chars = Array.from(text);
      for (const alias of aliases) {
        const aliasChars = Array.from(alias);
        if (aliasChars.length < 2) continue;
        // 只針對含中文字的暱稱做拼音滑動比對
        if (!/[\u4e00-\u9fff]/.test(alias)) continue;
        const targetPy = pyUtil.toPlainPinyin(alias);
        if (!targetPy) continue;

        const winLen = aliasChars.length;
        for (let i = 0; i <= chars.length - winLen; i++) {
          const sliceStr = chars.slice(i, i + winLen).join('');
          if (pyUtil.toPlainPinyin(sliceStr) === targetPy) {
            const rest = chars
              .slice(i + winLen)
              .join('')
              .replace(/^[，,、。！？!?\s]+/, '')
              .trim();
            return { matched: true, matchedAlias: alias, heardAlias: sliceStr, commandText: rest };
          }
        }
      }
    }

    return { matched: false, commandText: text };
  }

  /**
   * 去除口語開頭贅字與句尾語氣詞，保留核心意圖
   */
  function stripFillerWords(text) {
    let s = String(text || '').trim();
    // 去除句尾標點與語氣助詞
    s = s.replace(/[，,。！？!?\s]+$/g, '');
    s = s.replace(/(?:一下|好嗎|可以嗎|謝謝你?|拜託|喔|哦|啊|呀|吧|呢|啦)+$/g, '').trim();

    // 迴圈去除常見口語開頭（支援疊加，如「請你幫我現在我要抽籤」）
    const prefixRe = /^(?:嗨|哈囉|你好|請問|麻煩你?|拜託你?|請你?|你可以|能不能|可不可以|我要|我想|我們要|現在|來|去|幫我|幫我們|給我|替我|就|把)[，,\s]*/;
    let prev = '';
    while (s !== prev) {
      prev = s;
      s = s.replace(prefixRe, '').trim();
    }
    return s;
  }

  /**
   * 依自然口語尋找最相近的班級（例如說「乙班」命中「七年乙班（範例）」）
   */
  function findClassByQuery(rawQuery, classes) {
    const q = String(rawQuery || '')
      .trim()
      .replace(/的?(?:加分板|名單|抽籤|班級)?$/g, '')
      .replace(/[，。！？\s]/g, '');
    if (!q || !classes.length) return null;

    // 1. 完全相等或包含
    const exact = classes.find((c) => c.class_name === q);
    if (exact) return exact;
    const includes = classes.find((c) => c.class_name.includes(q) || q.includes(c.class_name));
    if (includes) return includes;

    // 2. 拼音包含比對
    const pyUtil = TeacherApp.pinyinUtil;
    const qPy = pyUtil.toPlainPinyin(q);
    if (qPy) {
      const pyHit = classes.find((c) => pyUtil.toPlainPinyin(c.class_name).includes(qPy));
      if (pyHit) return pyHit;
    }
    return null;
  }

  /**
   * 尋找指定組別的學生（同時支援「第一組」「第1組」「1組」）
   */
  function findStudentsByGroup(rawGroup, students, pyUtil) {
    const gNumMatch = String(rawGroup || '').match(/([一二兩三四五六七八九十\d]+)/);
    const gNum = gNumMatch ? pyUtil.parseChineseNumber(gNumMatch[1]) : null;
    return students.filter((s) => {
      if (!s.group_name) return false;
      if (s.group_name === rawGroup || s.group_name.includes(rawGroup)) return true;
      if (gNum !== null) {
        const sNumMatch = s.group_name.match(/([一二兩三四五六七八九十\d]+)/);
        if (sNumMatch && pyUtil.parseChineseNumber(sNumMatch[1]) === gNum) return true;
      }
      return false;
    });
  }

  /**
   * 執行結構化意圖（本地 NLU 與 Gemini AI 共用同一個執行器）
   */
  function executeAction(action, ctx) {
    const store = ctx.store;
    const voice = ctx.voice;
    const plugins = ctx.plugins;
    const pyUtil = ctx.pinyinUtil;

    switch (action.type) {
      case 'score_student': {
        const students = store.getStudentsByClass();
        const hit = pyUtil.findStudentByQuery(action.target, students);
        if (!hit) {
          const msg = `找不到名為「${action.target}」的學生`;
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        const delta = Number(action.delta || 1);
        store.addScore(hit.student.student_id, delta, action.reason || '', 'voice');
        const scoreTool = plugins.getPlugin('score');
        if (scoreTool && scoreTool.flashStudent) {
          scoreTool.flashStudent(hit.student.student_id, delta >= 0 ? 'plus' : 'minus');
        }
        voice.playSound(delta >= 0 ? 'plus' : 'minus');
        if (plugins.activeId !== 'score') plugins.activate('score');
        else plugins.renderActive();

        const newScore = store.getStudentScore(hit.student.student_id);
        const opText = delta >= 0 ? '加' : '扣';
        const absNum = Math.abs(delta);
        const fuzzyNote =
          hit.matchType === 'homophone' || hit.matchType === 'fuzzy'
            ? `（同音比對「${action.target}」）`
            : '';
        const msg = `已幫 ${hit.student.seat_no}號 ${hit.student.name} ${opText} ${absNum} 分（總分 ${newScore}）${fuzzyNote}`;
        voice.speak(`已幫${hit.student.name}${opText}${absNum}分`);
        ctx.toast(msg, delta >= 0 ? 'success' : 'warning');
        return msg;
      }

      case 'score_group': {
        const students = store.getStudentsByClass();
        const matched = findStudentsByGroup(action.group, students, pyUtil);
        if (matched.length === 0) {
          const msg = `找不到「${action.group}」的學生`;
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        const delta = Number(action.delta || 1);
        const opText = delta >= 0 ? '加' : '扣';
        store.addBatchScore(
          matched.map((s) => s.student_id),
          delta,
          action.reason || `${action.group}${opText}分`,
          'voice'
        );
        voice.playSound(delta >= 0 ? 'plus' : 'minus');
        if (plugins.activeId !== 'score') plugins.activate('score');
        else plugins.renderActive();

        const msg = `已幫${action.group}（${matched.length}人）${opText} ${Math.abs(delta)} 分`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'score_all': {
        const students = store.getStudentsByClass();
        if (students.length === 0) {
          const msg = '目前班級還沒有學生名單';
          voice.speak(msg);
          return msg;
        }
        const delta = Number(action.delta || 1);
        const opText = delta >= 0 ? '加' : '扣';
        store.addBatchScore(
          students.map((s) => s.student_id),
          delta,
          action.reason || `全班${opText}分`,
          'voice'
        );
        voice.playSound(delta >= 0 ? 'plus' : 'minus');
        if (plugins.activeId !== 'score') plugins.activate('score');
        else plugins.renderActive();

        const msg = `已幫全班 ${students.length} 位同學${opText} ${Math.abs(delta)} 分`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'lottery_draw': {
        const lotteryTool = plugins.getPlugin('lottery');
        const count = Math.max(1, Number(action.count || 1));
        if (plugins.activeId !== 'lottery') plugins.activate('lottery');
        if (lotteryTool && lotteryTool.draw) {
          return lotteryTool.draw(ctx, count);
        }
        return '抽籤工具尚未載入';
      }

      case 'lottery_reset': {
        const lotteryTool = plugins.getPlugin('lottery');
        if (plugins.activeId !== 'lottery') plugins.activate('lottery');
        if (lotteryTool && lotteryTool.reset) {
          return lotteryTool.reset(ctx);
        }
        return '已重置抽籤';
      }

      case 'lottery_set_norepeat': {
        const lotteryTool = plugins.getPlugin('lottery');
        if (lotteryTool && lotteryTool.setNoRepeat) {
          lotteryTool.setNoRepeat(Boolean(action.enabled));
        }
        if (plugins.activeId !== 'lottery') plugins.activate('lottery');
        else plugins.renderActive();
        const msg = action.enabled ? '已開啟不重複抽籤模式' : '已關閉不重複抽籤，可重複抽取';
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'switch_class': {
        const classes = store.getClasses();
        const hit = findClassByQuery(action.className, classes);
        if (!hit) {
          const msg = `找不到名為「${action.className}」的班級`;
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        store.setActiveClass(hit.class_id);
        const msg = `已切換至「${hit.class_name}」`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'switch_tab': {
        const targetPlugin = plugins.getPlugin(action.tabId);
        if (!targetPlugin) return `找不到頁面 ${action.tabId}`;
        plugins.activate(action.tabId);
        const msg = `已切換至「${targetPlugin.name}」`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'score_sort': {
        const scoreTool = plugins.getPlugin('score');
        if (scoreTool && scoreTool.setSort) {
          scoreTool.setSort(action.sortBy);
        }
        plugins.activate('score');
        const labelMap = { seat: '座號', score: '分數高到低', name: '姓名' };
        const msg = `加分板已改為依${labelMap[action.sortBy] || action.sortBy}排序`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'score_filter_group': {
        const scoreTool = plugins.getPlugin('score');
        const students = store.getStudentsByClass();
        let targetGroup = 'ALL';
        if (action.group && action.group !== 'ALL') {
          const matched = findStudentsByGroup(action.group, students, pyUtil);
          if (matched.length === 0) {
            const msg = `找不到「${action.group}」`;
            voice.speak(msg);
            ctx.toast(msg, 'warning');
            return msg;
          }
          targetGroup = matched[0].group_name;
        }
        if (scoreTool && scoreTool.setGroupFilter) {
          scoreTool.setGroupFilter(targetGroup);
        }
        plugins.activate('score');
        const msg = targetGroup === 'ALL' ? '已顯示全部組別' : `已篩選只顯示「${targetGroup}」`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'query_student_score': {
        const students = store.getStudentsByClass();
        const hit = pyUtil.findStudentByQuery(action.target, students);
        if (!hit) {
          const msg = `找不到「${action.target}」`;
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        const score = store.getStudentScore(hit.student.student_id);
        const msg = `${hit.student.seat_no}號 ${hit.student.name} 目前是 ${score} 分`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'query_top_student': {
        const students = store.getStudentsByClass();
        const scoresMap = store.getScoresMap();
        if (students.length === 0) return '目前沒有學生資料';
        const sorted = students
          .map((s) => ({ ...s, score: scoresMap.get(s.student_id) || 0 }))
          .sort((a, b) => b.score - a.score);
        const topScore = sorted[0].score;
        const leaders = sorted.filter((s) => s.score === topScore).slice(0, 3);
        const names = leaders.map((s) => s.name).join('、');
        const msg = `目前最高分是 ${names}，共 ${topScore} 分`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'query_lottery_remaining': {
        const lotteryTool = plugins.getPlugin('lottery');
        const info = lotteryTool && lotteryTool.getPoolStats ? lotteryTool.getPoolStats(ctx) : null;
        if (!info) return '無法取得抽籤狀態';
        const msg = `目前還有 ${info.remaining} 位同學尚未抽過（全班共 ${info.total} 人）`;
        voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'undo': {
        const res = store.undoLastScore();
        if (res) {
          const msg = `已復原 ${res.original.name} 的 ${res.original.delta > 0 ? '+' : ''}${res.original.delta} 分`;
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        const msg = '目前沒有可復原的紀錄';
        voice.speak(msg);
        ctx.toast(msg, 'warning');
        return msg;
      }

      case 'sync_cloud': {
        if (!ctx.api.isConfigured()) {
          const msg = '目前為本機模式，尚未設定 GAS 試算表網址';
          voice.speak(msg);
          ctx.toast(msg, 'warning');
          return msg;
        }
        if (ctx.syncCloud) ctx.syncCloud();
        const msg = '正在與 Google 試算表同步資料';
        voice.speak(msg);
        return msg;
      }

      case 'set_tts': {
        const enabled = Boolean(action.enabled);
        store.saveSettings({ ttsEnabled: enabled });
        if (ctx.syncSettingsUi) ctx.syncSettingsUi();
        const msg = enabled ? '已開啟語音播報' : '已關閉語音播報';
        if (enabled) voice.speak(msg);
        ctx.toast(msg, 'success');
        return msg;
      }

      case 'stop_listening': {
        voice.speak('好的，先暫停語音監聽');
        setTimeout(() => voice.stopAll(), 900);
        return '已暫停語音監聽';
      }

      default:
        return null;
    }
  }

  /**
   * 第一層：強化版本地自然口語意圖解析（毫秒回應、涵蓋所有網頁操作）
   */
  function parseLocalIntent(rawCommand, ctx) {
    const pyUtil = ctx.pinyinUtil;
    const text = stripFillerWords(rawCommand);
    if (!text) return null;

    // 1. 復原指令
    if (/^(?:取消|復原|撤銷|還原|退回|算錯了|弄錯了)/.test(text)) {
      return { type: 'undo' };
    }

    // 2. 語音控制 / 同步
    if (/^(?:停止監聽|關閉麥克風|不要聽了|休息|暫停語音)/.test(text)) {
      return { type: 'stop_listening' };
    }
    if (/(?:關閉語音播報|不要說話|安靜模式|靜音)/.test(text)) {
      return { type: 'set_tts', enabled: false };
    }
    if (/(?:開啟語音播報|打開語音播報|恢復聲音|取消靜音)/.test(text)) {
      return { type: 'set_tts', enabled: true };
    }
    if (/(?:同步試算表|重新同步|雲端同步|同步資料|上傳資料)/.test(text)) {
      return { type: 'sync_cloud' };
    }

    // 3. 查詢指令（幾分 / 第一名 / 抽籤剩餘）
    const queryScoreMatch = text.match(/^(.+?)(?:現在|目前)?(?:有|得|是)?幾分/);
    if (queryScoreMatch) {
      return { type: 'query_student_score', target: queryScoreMatch[1].trim() };
    }
    if (/(?:第一名是誰|誰最高分|最高分是誰|誰分數最高|領先的是誰)/.test(text)) {
      return { type: 'query_top_student' };
    }
    if (/(?:還剩幾個人|剩幾人沒抽|還有幾個人沒抽|抽籤剩幾人)/.test(text)) {
      return { type: 'query_lottery_remaining' };
    }

    // 4. 抽籤相關指令（容忍非常口語的表達：「我要抽籤」「抽一個上台」「點位同學」）
    if (/(?:重置|重新|清空|歸零).{0,3}抽籤/.test(text)) {
      return { type: 'lottery_reset' };
    }
    if (/(?:開啟|打開)不重複抽籤/.test(text)) {
      return { type: 'lottery_set_norepeat', enabled: true };
    }
    if (/(?:關閉|取消)不重複抽籤|可以重複抽/.test(text)) {
      return { type: 'lottery_set_norepeat', enabled: false };
    }
    const drawCountMatch = text.match(/(?:抽|點)(?:出|選)?([一二兩三四五六七八九十\d]+)(?:位|個|名|人)/);
    if (drawCountMatch) {
      const count = pyUtil.parseChineseNumber(drawCountMatch[1]) || 1;
      return { type: 'lottery_draw', count };
    }
    if (/(?:抽籤|抽人|隨機抽|抽同學|抽學生|點一位|點一個|抽一位|抽一個|抽個人|點個人)/.test(text)) {
      return { type: 'lottery_draw', count: 1 };
    }

    // 5. 班級切換（「切到七年乙班」「換成乙班」「切換班級到七年甲班」）
    const switchClassMatch = text.match(/^(?:切換|切|換|轉|改)(?:班級)?(?:到|成|至|為)?(.+班.*)$/);
    if (switchClassMatch) {
      return { type: 'switch_class', className: switchClassMatch[1].trim() };
    }

    // 6. 加分板排序與組別篩選
    if (/(?:依|照|按).{0,2}(?:分數|總分|高低|排名)|分數高低排/.test(text)) {
      return { type: 'score_sort', sortBy: 'score' };
    }
    if (/(?:依|照|按).{0,2}座號/.test(text)) {
      return { type: 'score_sort', sortBy: 'seat' };
    }
    if (/(?:依|照|按).{0,2}姓名/.test(text)) {
      return { type: 'score_sort', sortBy: 'name' };
    }
    if (/(?:顯示|看)(?:全部|所有)組別|取消篩選/.test(text)) {
      return { type: 'score_filter_group', group: 'ALL' };
    }
    const filterGroupMatch = text.match(/^(?:只看|篩選|顯示)(第?[一二兩三四五六七八九十\d]+組)$/);
    if (filterGroupMatch) {
      return { type: 'score_filter_group', group: filterGroupMatch[1] };
    }

    // 7. 切換網頁工具分頁（「打開統計」「我要看排行榜」「切到名單」「回到加分板」「開抽籤機」）
    if (/(?:加分板|積分板|分數板)/.test(text) && !/(加|扣|減)[一二兩三四五六七八九十\d]+/.test(text)) {
      return { type: 'switch_tab', tabId: 'score' };
    }
    if (/^(?:打開|開啟|切到|切換到|看|去|進入)?抽籤(?:機|頁面|板)$/.test(text)) {
      return { type: 'switch_tab', tabId: 'lottery' };
    }
    if (/(?:班級管理|學生名單|匯入名單|打開名單|看名單|名單管理)/.test(text)) {
      return { type: 'switch_tab', tabId: 'roster' };
    }
    if (/(?:統計|排行榜|紀錄|記錄|報表|流水帳)/.test(text)) {
      return { type: 'switch_tab', tabId: 'stats' };
    }

    // 8. 全班加扣分（「全班都加一分」「全班表現很好各加兩分」）
    const allScoreMatch = text.match(/^(?:全班|大家|所有人|每個人).*?(加|扣|減)(?:上|個|了)?([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/);
    if (allScoreMatch) {
      const num = pyUtil.parseChineseNumber(allScoreMatch[2]) || 1;
      return {
        type: 'score_all',
        delta: allScoreMatch[1] === '加' ? num : -num,
        reason: allScoreMatch[3] || '',
      };
    }

    // 9. 組別加扣分（「第一組每人加兩分」「幫第2組扣1分」）
    const groupScoreMatch = text.match(/^(第?[一二兩三四五六七八九十\d]+組).*?(加|扣|減)(?:上|個|了)?([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/);
    if (groupScoreMatch) {
      const num = pyUtil.parseChineseNumber(groupScoreMatch[3]) || 1;
      return {
        type: 'score_group',
        group: groupScoreMatch[1],
        delta: groupScoreMatch[2] === '加' ? num : -num,
        reason: groupScoreMatch[4] || '',
      };
    }

    // 10. 單人加扣分（支援口語：「王小名加上兩分」「給5號加一分」「王小明答對了加1分」「王小明加分」預設+1）
    const singleScoreMatch = text.match(/^(?:幫|給|替|讓|把)?(.+?)(?:答對了|表現不錯|表現很好|很棒|回答正確|的)?(加|扣|減)(?:上|個|了)?([一二兩三四五六七八九十\d]+)分?(?:[，,\s]*(.+))?$/);
    if (singleScoreMatch) {
      const num = pyUtil.parseChineseNumber(singleScoreMatch[3]);
      if (num && num > 0) {
        return {
          type: 'score_student',
          target: singleScoreMatch[1].trim(),
          delta: singleScoreMatch[2] === '加' ? num : -num,
          reason: singleScoreMatch[4] || '',
        };
      }
    }
    // 簡短說「王小明加分」「5號扣分」預設 ±1
    const shortScoreMatch = text.match(/^(?:幫|給|替|讓|把)?(.+?)(加分|扣分)$/);
    if (shortScoreMatch) {
      return {
        type: 'score_student',
        target: shortScoreMatch[1].trim(),
        delta: shortScoreMatch[2] === '加分' ? 1 : -1,
        reason: '',
      };
    }

    return null;
  }

  function tryLocalDispatch(rawCommand, ctx) {
    const intent = parseLocalIntent(rawCommand, ctx);
    if (!intent) return { handled: false };
    const message = executeAction(intent, ctx);
    return { handled: true, pluginId: 'smart-nlu', message };
  }

  /**
   * 第二層：選配 Gemini AI 智慧解析（支援超自由口語與一次多動作）
   */
  async function tryGeminiDispatch(rawCommand, ctx) {
    const apiKey = String(ctx.store.settings.geminiApiKey || '').trim();
    if (!apiKey) return { handled: false };

    const students = ctx.store.getStudentsByClass();
    const classes = ctx.store.getClasses();
    const activeClass = ctx.store.getActiveClass();

    const prompt = `你是台灣教室網頁版「課堂小幫手」的語音指令解析器。
請把老師說的話轉換成 JSON 格式的可執行動作陣列，回傳結構必須為：{"actions":[...],"reply":"簡短中文回覆"}。

目前班級：${activeClass ? activeClass.class_name : ''}
所有班級：${classes.map((c) => c.class_name).join('、')}
目前班級學生名單：${students.map((s) => `${s.seat_no}號 ${s.name}(${s.group_name || '無組別'})`).join('、')}

允許的 action 物件格式：
- {"type":"score_student","target":"學生姓名或座號","delta":整數,"reason":"選填原因"}
- {"type":"score_group","group":"組別名稱","delta":整數,"reason":"選填原因"}
- {"type":"score_all","delta":整數,"reason":"選填原因"}
- {"type":"lottery_draw","count":整數}
- {"type":"lottery_reset"}
- {"type":"lottery_set_norepeat","enabled":true或false}
- {"type":"switch_class","className":"班級名稱"}
- {"type":"switch_tab","tabId":"score"|"lottery"|"roster"|"stats"}
- {"type":"score_sort","sortBy":"seat"|"score"|"name"}
- {"type":"score_filter_group","group":"ALL"或組別名稱}
- {"type":"query_student_score","target":"學生姓名或座號"}
- {"type":"query_top_student"}
- {"type":"query_lottery_remaining"}
- {"type":"undo"}
- {"type":"sync_cloud"}
- {"type":"set_tts","enabled":true或false}
- {"type":"stop_listening"}

注意：
1. 請自動修正中文同音錯字，對應到上述學生名單或班級名稱。
2. 若老師的話與課堂工具操作無關，回傳 {"actions":[],"reply":""}。
老師說的話：「${rawCommand}」`;

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      const rawJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJson) return { handled: false };

      const parsed = JSON.parse(rawJson);
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      if (actions.length === 0) return { handled: false };

      const messages = [];
      for (const act of actions) {
        const m = executeAction(act, ctx);
        if (m) messages.push(m);
      }
      return {
        handled: true,
        pluginId: 'gemini-ai',
        message: `🤖 AI 理解並執行：${messages.join('；')}`,
      };
    } catch (err) {
      return {
        handled: false,
        error: `AI 解析失敗：${err.message}`,
      };
    }
  }

  TeacherApp.smartNlu = {
    parseWakeWords,
    matchWakeWord,
    stripFillerWords,
    parseLocalIntent,
    tryLocalDispatch,
    tryGeminiDispatch,
  };
})(window);
