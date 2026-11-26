/**
 * 全域資料狀態管理（支援多班級、學生名單、加扣分流水帳、抽籤紀錄、Undo 復原）
 * 所有工具插件共享此 Store，確保資料一致。
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  const STORAGE_KEY = 'ta_state_v1';
  const SETTINGS_KEY = 'ta_settings_v1';

  function createDefaultData() {
    const class1Id = 'C_DEMO_701';
    const class2Id = 'C_DEMO_702';
    return {
      activeClassId: class1Id,
      classes: [
        { class_id: class1Id, class_name: '七年甲班（範例）', created_at: new Date().toISOString() },
        { class_id: class2Id, class_name: '七年乙班（範例）', created_at: new Date().toISOString() },
      ],
      students: [
        { student_id: `${class1Id}_1140101`, class_id: class1Id, seat_no: 1, student_no: '1140101', name: '王小明', group_name: '第一組', alias: '小明' },
        { student_id: `${class1Id}_1140102`, class_id: class1Id, seat_no: 2, student_no: '1140102', name: '陳怡君', group_name: '第一組', alias: '怡君' },
        { student_id: `${class1Id}_1140103`, class_id: class1Id, seat_no: 3, student_no: '1140103', name: '林志豪', group_name: '第一組', alias: '志豪' },
        { student_id: `${class1Id}_1140104`, class_id: class1Id, seat_no: 4, student_no: '1140104', name: '張雅婷', group_name: '第二組', alias: '雅婷' },
        { student_id: `${class1Id}_1140105`, class_id: class1Id, seat_no: 5, student_no: '1140105', name: '黃柏翰', group_name: '第二組', alias: '柏翰' },
        { student_id: `${class1Id}_1140106`, class_id: class1Id, seat_no: 6, student_no: '1140106', name: '李佩珊', group_name: '第二組', alias: '佩珊' },
        { student_id: `${class2Id}_1140201`, class_id: class2Id, seat_no: 1, student_no: '1140201', name: '吳承恩', group_name: '第一組', alias: '承恩' },
        { student_id: `${class2Id}_1140202`, class_id: class2Id, seat_no: 2, student_no: '1140202', name: '許芷若', group_name: '第一組', alias: '芷若' },
        { student_id: `${class2Id}_1140203`, class_id: class2Id, seat_no: 3, student_no: '1140203', name: '蔡宗翰', group_name: '第二組', alias: '宗翰' },
      ],
      scoreLogs: [],
      toolLogs: [],
    };
  }

  function createDefaultSettings() {
    return {
      gasUrl: '',
      gasToken: '',
      wakeWord: '小幫手',
      requireWakeWord: true,
      ttsEnabled: true,
      defaultReason: '課堂表現',
    };
  }

  class Store {
    constructor() {
      this.state = this._loadState();
      this.settings = this._loadSettings();
      this.undoStack = [];
      this.listeners = new Set();
    }

    _loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.classes) && parsed.classes.length > 0) {
            return parsed;
          }
        }
      } catch (_e) {
        // fallback to default
      }
      return createDefaultData();
    }

    _loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          return Object.assign(createDefaultSettings(), JSON.parse(raw));
        }
      } catch (_e) {
        // fallback
      }
      return createDefaultSettings();
    }

    _saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (_e) {
        // ignore
      }
    }

    saveSettings(partial) {
      this.settings = Object.assign({}, this.settings, partial);
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      } catch (_e) {
        // ignore
      }
      this.emit('settings', this.settings);
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit(eventType, detail) {
      for (const fn of this.listeners) {
        fn(eventType, detail);
      }
    }

    // ====== 班級查詢與管理 ======
    getClasses() {
      return this.state.classes;
    }

    getActiveClassId() {
      const exists = this.state.classes.some((c) => c.class_id === this.state.activeClassId);
      if (!exists && this.state.classes.length > 0) {
        this.state.activeClassId = this.state.classes[0].class_id;
      }
      return this.state.activeClassId;
    }

    getActiveClass() {
      const id = this.getActiveClassId();
      return this.state.classes.find((c) => c.class_id === id) || null;
    }

    setActiveClass(classId) {
      if (this.state.classes.some((c) => c.class_id === classId)) {
        this.state.activeClassId = classId;
        this._saveState();
        this.emit('classChanged', classId);
      }
    }

    addClass(className) {
      const cleanName = String(className || '').trim();
      if (!cleanName) throw new Error('請輸入班級名稱');

      const newClass = {
        class_id: `C_${Date.now().toString(36).toUpperCase()}`,
        class_name: cleanName,
        created_at: new Date().toISOString(),
      };
      this.state.classes.push(newClass);
      this.state.activeClassId = newClass.class_id;
      this._saveState();

      TeacherApp.api.enqueue('upsertClass', newClass);
      this.emit('classAdded', newClass);
      return newClass;
    }

    deleteClass(classId) {
      if (this.state.classes.length <= 1) {
        throw new Error('至少需要保留一個班級');
      }
      this.state.classes = this.state.classes.filter((c) => c.class_id !== classId);
      this.state.students = this.state.students.filter((s) => s.class_id !== classId);
      if (this.state.activeClassId === classId) {
        this.state.activeClassId = this.state.classes[0].class_id;
      }
      this._saveState();

      TeacherApp.api.enqueue('deleteClass', { class_id: classId });
      this.emit('classDeleted', classId);
    }

    // ====== 學生查詢與匯入 ======
    getStudentsByClass(classId = this.getActiveClassId()) {
      const list = this.state.students.filter((s) => s.class_id === classId);
      return list.sort((a, b) => (parseInt(a.seat_no, 10) || 999) - (parseInt(b.seat_no, 10) || 999));
    }

    getStudentScore(studentId) {
      return this.state.scoreLogs
        .filter((l) => l.student_id === studentId)
        .reduce((sum, l) => sum + Number(l.delta || 0), 0);
    }

    getScoresMap(classId = this.getActiveClassId()) {
      const map = new Map();
      for (const s of this.getStudentsByClass(classId)) {
        map.set(s.student_id, 0);
      }
      for (const log of this.state.scoreLogs) {
        if (log.class_id === classId) {
          map.set(log.student_id, (map.get(log.student_id) || 0) + Number(log.delta || 0));
        }
      }
      return map;
    }

    /**
     * 批次匯入某班級學生名單（包含座號、學號、姓名、組別、別名）
     * @param {'merge'|'replace'} mode
     */
    importStudents(classId, rows, mode = 'merge') {
      const normalized = rows
        .filter((r) => r && String(r.name || '').trim())
        .map((r, idx) => {
          const seatNo = parseInt(r.seat_no, 10) || idx + 1;
          const studentNo = String(r.student_no || '').trim() || `${seatNo}`.padStart(2, '0');
          return {
            student_id: `${classId}_${studentNo}`,
            class_id: classId,
            seat_no: seatNo,
            student_no: studentNo,
            name: String(r.name).trim(),
            group_name: String(r.group_name || '').trim(),
            alias: String(r.alias || '').trim(),
          };
        });

      if (normalized.length === 0) {
        throw new Error('沒有可匯入的有效學生資料');
      }

      if (mode === 'replace') {
        this.state.students = this.state.students
          .filter((s) => s.class_id !== classId)
          .concat(normalized);
      } else {
        // merge：以 student_id 或同班級同座號更新
        const others = this.state.students.filter((s) => s.class_id !== classId);
        const current = this.state.students.filter((s) => s.class_id === classId);
        const byId = new Map(current.map((s) => [s.student_id, s]));

        for (const item of normalized) {
          byId.set(item.student_id, item);
        }
        this.state.students = others.concat(Array.from(byId.values()));
      }

      this._saveState();
      const finalClassStudents = this.getStudentsByClass(classId);

      TeacherApp.api.enqueue('importStudents', {
        class_id: classId,
        mode,
        students: normalized,
      });

      this.emit('studentsUpdated', { classId, count: finalClassStudents.length });
      return normalized.length;
    }

    upsertSingleStudent(classId, studentData) {
      return this.importStudents(classId, [studentData], 'merge');
    }

    deleteStudent(studentId) {
      this.state.students = this.state.students.filter((s) => s.student_id !== studentId);
      this._saveState();
      TeacherApp.api.enqueue('deleteStudent', { student_id: studentId });
      this.emit('studentsUpdated', { classId: this.getActiveClassId() });
    }

    // ====== 加扣分與復原 ======
    addScore(studentId, delta, reason, source = 'manual') {
      const student = this.state.students.find((s) => s.student_id === studentId);
      if (!student) throw new Error('找不到學生資料');

      const log = {
        log_id: `L_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        class_id: student.class_id,
        student_id: student.student_id,
        seat_no: student.seat_no,
        student_no: student.student_no,
        name: student.name,
        delta: Number(delta),
        reason: reason || this.settings.defaultReason || '課堂表現',
        source,
      };

      this.state.scoreLogs.unshift(log);
      if (source !== 'undo') {
        this.undoStack.push(log);
        if (this.undoStack.length > 30) this.undoStack.shift();
      }
      this._saveState();

      TeacherApp.api.enqueue('addScore', log);
      this.emit('scoreChanged', log);
      return log;
    }

    addBatchScore(studentIds, delta, reason, source = 'manual') {
      const logs = [];
      for (const id of studentIds) {
        logs.push(this.addScore(id, delta, reason, source));
      }
      return logs;
    }

    canUndo() {
      return this.undoStack.length > 0;
    }

    undoLastScore() {
      const last = this.undoStack.pop();
      if (!last) return null;
      const reverseLog = this.addScore(
        last.student_id,
        -Number(last.delta),
        `復原：${last.reason}`,
        'undo'
      );
      this.emit('undoExecuted', { original: last, reverse: reverseLog });
      return { original: last, reverse: reverseLog };
    }

    // ====== 通用工具紀錄（抽籤、未來擴充工具共用） ======
    addToolLog(toolId, action, detail) {
      const entry = {
        log_id: `T_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        class_id: this.getActiveClassId(),
        tool_id: toolId,
        action,
        detail,
      };
      this.state.toolLogs.unshift(entry);
      if (this.state.toolLogs.length > 300) {
        this.state.toolLogs = this.state.toolLogs.slice(0, 300);
      }
      this._saveState();

      TeacherApp.api.enqueue('addToolLog', {
        ...entry,
        detail_json: JSON.stringify(detail || {}),
      });
      this.emit('toolLogAdded', entry);
      return entry;
    }

    getScoreLogsByClass(classId = this.getActiveClassId()) {
      return this.state.scoreLogs.filter((l) => l.class_id === classId);
    }

    getToolLogsByClass(classId = this.getActiveClassId()) {
      return this.state.toolLogs.filter((l) => l.class_id === classId);
    }

    // ====== 從雲端 GAS 覆寫載入 ======
    hydrateFromCloud(cloudData) {
      const classes = Array.isArray(cloudData.classes) ? cloudData.classes : [];
      const students = Array.isArray(cloudData.students) ? cloudData.students : [];
      const scoreLogs = Array.isArray(cloudData.scoreLogs) ? cloudData.scoreLogs : [];
      const toolLogs = Array.isArray(cloudData.toolLogs) ? cloudData.toolLogs : [];

      if (classes.length > 0) {
        this.state.classes = classes;
        if (!classes.some((c) => c.class_id === this.state.activeClassId)) {
          this.state.activeClassId = classes[0].class_id;
        }
      }
      this.state.students = students.map((s) => ({
        ...s,
        seat_no: parseInt(s.seat_no, 10) || 0,
      }));
      this.state.scoreLogs = scoreLogs
        .map((l) => ({ ...l, delta: Number(l.delta || 0) }))
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      this.state.toolLogs = toolLogs.map((t) => {
        let detail = t.detail;
        if (!detail && t.detail_json) {
          try {
            detail = JSON.parse(t.detail_json);
          } catch (_e) {
            detail = { raw: t.detail_json };
          }
        }
        return { ...t, detail };
      });

      this._saveState();
      this.emit('hydrated', this.state);
    }
  }

  TeacherApp.store = new Store();
})(window);
