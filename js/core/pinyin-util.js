/**
 * 中文語音辨識輔助工具：
 * 1. 中文數字轉阿拉伯數字（支援「一、兩、三、十、十五、二十三」）
 * 2. 姓名同音字模糊比對（優先使用 pinyin-pro 無聲調拼音，離線自動降級）
 * 3. 座號與學號解析比對
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  const CN_NUM_MAP = {
    零: 0, 〇: 0,
    一: 1, 壹: 1,
    二: 2, 兩: 2, 两: 2, 貳: 2,
    三: 3, 參: 3,
    四: 4, 肆: 4,
    五: 5, 伍: 5,
    六: 6, 陸: 6,
    七: 7, 柒: 7,
    八: 8, 捌: 8,
    九: 9, 玖: 9,
  };

  /**
   * 將中文數字或阿拉伯數字字串轉為整數，失敗回傳 null
   */
  function parseChineseNumber(raw) {
    if (raw === undefined || raw === null) return null;
    const str = String(raw).trim();
    if (!str) return null;

    if (/^\d+$/.test(str)) {
      return parseInt(str, 10);
    }

    // 處理十位數：十、十一、二十、二十五
    if (str.includes('十')) {
      const [tensPart, onesPart] = str.split('十');
      const tens = tensPart === '' ? 1 : (CN_NUM_MAP[tensPart] ?? null);
      const ones = onesPart === '' ? 0 : (CN_NUM_MAP[onesPart] ?? null);
      if (tens !== null && ones !== null) {
        return tens * 10 + ones;
      }
    }

    // 單字或連續位數
    if (str.length === 1 && CN_NUM_MAP[str] !== undefined) {
      return CN_NUM_MAP[str];
    }

    // 處理語音連唸數字，如「一二」-> 12
    let digits = '';
    for (const ch of str) {
      if (CN_NUM_MAP[ch] !== undefined) {
        digits += String(CN_NUM_MAP[ch]);
      } else {
        return null;
      }
    }
    return digits ? parseInt(digits, 10) : null;
  }

  /**
   * 將中文字串轉成無聲調、不含空格的標準化拼音（若未載入 pinyin-pro 則回傳原小寫字串）
   */
  function toPlainPinyin(text) {
    const clean = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!clean) return '';
    if (global.pinyinPro && typeof global.pinyinPro.pinyin === 'function') {
      try {
        return global.pinyinPro
          .pinyin(clean, { toneType: 'none', type: 'array' })
          .join('')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
      } catch (_e) {
        return clean;
      }
    }
    return clean;
  }

  /**
   * Levenshtein 編輯距離
   */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[a.length][b.length];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
  }

  /**
   * 在學生名單中以「精準姓名 -> 座號 -> 學號 -> 別名 -> 拼音同音字」順序尋找最符合的學生
   */
  function findStudentByQuery(rawQuery, students) {
    if (!rawQuery || !Array.isArray(students) || students.length === 0) return null;

    const query = String(rawQuery)
      .trim()
      .replace(/同學|小朋友|學生/g, '')
      .replace(/[，。！？、\s]/g, '');
    if (!query) return null;

    // 1. 座號比對（例如：「5號」、「五號」、「05號」、「座號12」）
    const seatMatch = query.match(/^(?:座號)?([一二兩三四五六七八九十\d]+)號?$/);
    if (seatMatch) {
      const seatNum = parseChineseNumber(seatMatch[1]);
      if (seatNum !== null) {
        const bySeat = students.find((s) => parseInt(s.seat_no, 10) === seatNum);
        if (bySeat) return { student: bySeat, matchType: 'seat', score: 1 };
      }
    }

    // 2. 學號精準比對
    const byStudentNo = students.find(
      (s) => s.student_no && String(s.student_no).trim().toLowerCase() === query.toLowerCase()
    );
    if (byStudentNo) return { student: byStudentNo, matchType: 'student_no', score: 1 };

    // 3. 姓名完全符合
    const exactName = students.find((s) => s.name === query);
    if (exactName) return { student: exactName, matchType: 'exact', score: 1 };

    // 4. 別名完全符合（支援以逗號或頓號分隔多個別名）
    const exactAlias = students.find((s) => {
      if (!s.alias) return false;
      const aliases = String(s.alias)
        .split(/[,，、;；\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      return aliases.includes(query);
    });
    if (exactAlias) return { student: exactAlias, matchType: 'alias', score: 0.98 };

    // 5. 拼音同音字與模糊相似度比對
    const queryPy = toPlainPinyin(query);
    let best = null;
    let bestScore = 0;

    for (const s of students) {
      const candidates = [s.name];
      if (s.alias) {
        candidates.push(
          ...String(s.alias)
            .split(/[,，、;；\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)
        );
      }

      for (const cand of candidates) {
        const candPy = toPlainPinyin(cand);
        // 拼音完全相同（例如「王小明」vs「王小名」）
        if (queryPy && candPy && queryPy === candPy) {
          return { student: s, matchType: 'homophone', score: 0.96 };
        }

        // 只叫名字後兩字（例如叫「小明」對應「王小明」）
        if (cand.length >= 3 && query.length === 2) {
          const tailPy = toPlainPinyin(cand.slice(-2));
          if (tailPy && tailPy === queryPy) {
            if (0.9 > bestScore) {
              bestScore = 0.9;
              best = s;
            }
          }
        }

        const pySim = similarity(queryPy, candPy);
        const charSim = similarity(query, cand);
        const combined = Math.max(pySim, charSim);
        if (combined > bestScore) {
          bestScore = combined;
          best = s;
        }
      }
    }

    // 相似度門檻 0.68 避免把完全無關的人誤認
    if (best && bestScore >= 0.68) {
      return { student: best, matchType: 'fuzzy', score: bestScore };
    }

    return null;
  }

  TeacherApp.pinyinUtil = {
    parseChineseNumber,
    toPlainPinyin,
    findStudentByQuery,
  };
})(window);
