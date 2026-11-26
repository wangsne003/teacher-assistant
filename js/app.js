/**
 * 應用程式主入口：負責組裝 Store、ApiClient、VoiceEngine、PluginManager 與頁頂 UI 事件
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  function createToolContext() {
    return {
      store: TeacherApp.store,
      api: TeacherApp.api,
      voice: TeacherApp.voice,
      pinyinUtil: TeacherApp.pinyinUtil,
      plugins: TeacherApp.plugins,
      toast: showToast,
      syncSettingsUi,
      syncCloud: async () => {
        await TeacherApp.api.flushQueue();
        await pullFromCloud(false);
      },
    };
  }

  function renderClassSelect() {
    const select = document.getElementById('classSelect');
    const classes = TeacherApp.store.getClasses();
    const activeId = TeacherApp.store.getActiveClassId();
    select.innerHTML = '';
    for (const c of classes) {
      const opt = document.createElement('option');
      opt.value = c.class_id;
      opt.textContent = c.class_name;
      if (c.class_id === activeId) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function updateUndoButton() {
    const btn = document.getElementById('btnUndo');
    if (btn) btn.disabled = !TeacherApp.store.canUndo();
  }

  function updateSyncBadge({ state, pendingCount, detail }) {
    const badge = document.getElementById('syncBadge');
    const text = document.getElementById('syncText');
    const refreshBtn = document.getElementById('btnRefreshCloud');
    if (!badge || !text) return;

    badge.className = `sync-badge sync-${state}`;
    if (state === 'local') {
      text.textContent = '本機模式';
      refreshBtn.classList.add('hidden');
    } else if (state === 'ok') {
      text.textContent = '已同步試算表';
      refreshBtn.classList.remove('hidden');
    } else if (state === 'pending') {
      text.textContent = `同步中 (${pendingCount})`;
      refreshBtn.classList.remove('hidden');
    } else if (state === 'error') {
      text.textContent = `同步異常 (${pendingCount})`;
      badge.title = detail || 'GAS 同步失敗，點擊「同步」或檢查設定';
      refreshBtn.classList.remove('hidden');
    }
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  function syncSettingsUi() {
    const s = TeacherApp.store.settings;
    document.getElementById('chkWakeWord').checked = Boolean(s.requireWakeWord);
    document.getElementById('wakeWordDisplay').textContent = s.wakeWord || '小幫手, 麥克';
    document.getElementById('chkTtsEnabled').checked = Boolean(s.ttsEnabled);

    document.getElementById('inputGasUrl').value = s.gasUrl || '';
    document.getElementById('inputGasToken').value = s.gasToken || '';
    document.getElementById('inputWakeWord').value = s.wakeWord || '小幫手, 麥克';
    document.getElementById('inputDefaultReason').value = s.defaultReason || '課堂表現';
    const geminiEl = document.getElementById('inputGeminiKey');
    if (geminiEl) geminiEl.value = s.geminiApiKey || '';
  }

  async function pullFromCloud(silent = false) {
    if (!TeacherApp.api.isConfigured()) return;
    try {
      const data = await TeacherApp.api.fetchBootstrap();
      TeacherApp.store.hydrateFromCloud(data);
      if (!silent) showToast('已從 Google 試算表載入最新資料', 'success');
    } catch (err) {
      if (!silent) showToast(`雲端載入失敗：${err.message}`, 'error');
    }
  }

  function init() {
    const store = TeacherApp.store;
    const api = TeacherApp.api;
    const voice = TeacherApp.voice;
    const plugins = TeacherApp.plugins;

    // 1. 套用設定與同步狀態監聽
    api.onStatusChange(updateSyncBadge);
    api.configure(store.settings.gasUrl, store.settings.gasToken);
    syncSettingsUi();
    renderClassSelect();
    updateUndoButton();

    // 2. 掛載工具插件
    plugins.mount(
      document.getElementById('toolTabs'),
      document.getElementById('toolViewport'),
      createToolContext
    );

    // 3. 監聽 Store 變更自動重繪
    store.subscribe((eventType) => {
      if (['classChanged', 'classAdded', 'classDeleted', 'hydrated'].includes(eventType)) {
        renderClassSelect();
      }
      updateUndoButton();
      plugins.renderActive();
    });

    // 4. 班級切換與新增班級
    document.getElementById('classSelect').addEventListener('change', (e) => {
      store.setActiveClass(e.target.value);
      const cls = store.getActiveClass();
      if (cls) showToast(`已切換至「${cls.class_name}」`, 'success');
    });

    document.getElementById('btnQuickAddClass').addEventListener('click', () => {
      document.getElementById('inputNewClassName').value = '';
      openModal('addClassModal');
      document.getElementById('inputNewClassName').focus();
    });

    document.getElementById('btnConfirmAddClass').addEventListener('click', () => {
      const name = document.getElementById('inputNewClassName').value;
      try {
        const cls = store.addClass(name);
        closeModal('addClassModal');
        showToast(`已建立班級「${cls.class_name}」`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 5. 語音引擎整合
    const transcriptEl = document.getElementById('voiceTranscript');
    const voiceBtn = document.getElementById('btnVoiceToggle');
    const voiceBtnLabel = document.getElementById('voiceBtnLabel');

    async function handleCommand(cmdText, rawSpoken) {
      if (store.settings.geminiApiKey) {
        transcriptEl.textContent = `⏳ 正在理解指令「${rawSpoken || cmdText}」...`;
      }
      const res = await plugins.dispatchCommand(cmdText);
      if (res.handled) {
        transcriptEl.textContent = `✅ 指令「${rawSpoken || cmdText}」→ ${res.message}`;
        transcriptEl.classList.add('matched');
      } else {
        const extra = res.error ? `（${res.error}）` : '';
        transcriptEl.textContent = `❓ 聽懂了「${cmdText}」，但沒有對應的網頁指令${extra}`;
        transcriptEl.classList.remove('matched');
        showToast(`未識別指令：「${cmdText}」`, 'warning');
      }
    }

    voice.init({
      onCommand: (cmdText, rawText) => handleCommand(cmdText, rawText),
      onStatus: ({ listening, text, error, matched }) => {
        if (listening !== undefined) {
          voiceBtn.classList.toggle('listening', Boolean(listening));
          voiceBtnLabel.textContent = listening ? '停止語音監聽' : '開啟語音監聽';
        }
        if (error) {
          transcriptEl.textContent = `⚠️ ${error}`;
          transcriptEl.classList.remove('matched');
          showToast(error, 'error');
        } else if (text) {
          transcriptEl.textContent = text;
          transcriptEl.classList.toggle('matched', Boolean(matched));
        }
      },
    });

    voiceBtn.addEventListener('click', () => voice.toggleContinuous());

    // 按住說話按鈕
    const pttBtn = document.getElementById('btnPushToTalk');
    pttBtn.addEventListener('mousedown', () => voice.startPushToTalk());
    pttBtn.addEventListener('mouseup', () => voice.stopPushToTalk());
    pttBtn.addEventListener('mouseleave', () => voice.stopPushToTalk());
    pttBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      voice.startPushToTalk();
    });
    pttBtn.addEventListener('touchend', () => voice.stopPushToTalk());

    // 鍵盤空白鍵「按住說話」（焦點不在輸入框時生效）
    let spaceHeld = false;
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || spaceHeld) return;
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;
      e.preventDefault();
      spaceHeld = true;
      voice.startPushToTalk();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && spaceHeld) {
        spaceHeld = false;
        voice.stopPushToTalk();
      }
    });

    // 快速開關：喚醒詞 / 語音播報
    document.getElementById('chkWakeWord').addEventListener('change', (e) => {
      store.saveSettings({ requireWakeWord: e.target.checked });
    });
    document.getElementById('chkTtsEnabled').addEventListener('change', (e) => {
      store.saveSettings({ ttsEnabled: e.target.checked });
    });

    // 文字模擬指令框（支援直接輸入帶喚醒暱稱的句子，如「麥克我要抽籤」「麥可幫王小名加一分」）
    document.getElementById('cmdSimulateForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('cmdSimulateInput');
      const raw = input.value.trim();
      if (!raw) return;
      const wakeSetting = store.settings.wakeWord || '小幫手, 麥克';
      const wakeHit = TeacherApp.smartNlu
        ? TeacherApp.smartNlu.matchWakeWord(raw, wakeSetting)
        : { matched: false, commandText: raw };
      const cleaned = wakeHit.matched ? wakeHit.commandText : raw;
      if (!cleaned && wakeHit.matched) {
        voice.speak('我在，請說指令');
        transcriptEl.textContent = `已喚醒「${wakeHit.matchedAlias}」，請說指令...`;
        transcriptEl.classList.add('matched');
      } else {
        handleCommand(cleaned, raw);
      }
      input.value = '';
    });

    // 語音指令小抄
    const helpBtn = document.getElementById('btnVoiceHelp');
    if (helpBtn) {
      helpBtn.addEventListener('click', () => openModal('voiceHelpModal'));
    }

    // 復原按鈕
    document.getElementById('btnUndo').addEventListener('click', () => {
      handleCommand('復原', '復原');
    });

    // 6. GAS 與設定彈窗
    document.getElementById('btnOpenSettings').addEventListener('click', () => {
      syncSettingsUi();
      document.getElementById('gasTestResult').classList.add('hidden');
      openModal('settingsModal');
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    document.getElementById('btnSaveSettings').addEventListener('click', () => {
      const gasUrl = document.getElementById('inputGasUrl').value.trim();
      const gasToken = document.getElementById('inputGasToken').value.trim();
      const wakeWord = document.getElementById('inputWakeWord').value.trim() || '小幫手, 麥克';
      const defaultReason = document.getElementById('inputDefaultReason').value.trim() || '課堂表現';
      const geminiEl = document.getElementById('inputGeminiKey');
      const geminiApiKey = geminiEl ? geminiEl.value.trim() : '';

      store.saveSettings({ gasUrl, gasToken, wakeWord, defaultReason, geminiApiKey });
      api.configure(gasUrl, gasToken);
      syncSettingsUi();
      closeModal('settingsModal');
      showToast('設定已儲存', 'success');

      if (api.isConfigured()) {
        api.flushQueue();
      }
    });

    document.getElementById('btnTestGas').addEventListener('click', async () => {
      const url = document.getElementById('inputGasUrl').value.trim();
      const token = document.getElementById('inputGasToken').value.trim();
      const resBox = document.getElementById('gasTestResult');
      resBox.classList.remove('hidden', 'ok', 'err');
      resBox.textContent = '連線測試中...';

      api.configure(url, token);
      try {
        const data = await api.fetchBootstrap();
        resBox.classList.add('ok');
        resBox.textContent = `✅ 連線成功！試算表目前有 ${data.classes.length} 個班級、${data.students.length} 位學生、${data.scoreLogs.length} 筆加分紀錄。`;
      } catch (err) {
        resBox.classList.add('err');
        resBox.textContent = `❌ 連線失敗：${err.message}`;
      }
    });

    document.getElementById('btnPullFromGas').addEventListener('click', async () => {
      const url = document.getElementById('inputGasUrl').value.trim();
      const token = document.getElementById('inputGasToken').value.trim();
      store.saveSettings({ gasUrl: url, gasToken: token });
      api.configure(url, token);
      await pullFromCloud(false);
    });

    document.getElementById('btnPushLocalToGas').addEventListener('click', async () => {
      const url = document.getElementById('inputGasUrl').value.trim();
      const token = document.getElementById('inputGasToken').value.trim();
      if (!url) {
        showToast('請先填入 GAS Web App 網址', 'warning');
        return;
      }
      store.saveSettings({ gasUrl: url, gasToken: token });
      api.configure(url, token);
      try {
        await api.postDirect('syncAllClassesAndStudents', {
          classes: store.state.classes,
          students: store.state.students,
        });
        showToast('已成功將本機班級與學生名單上傳至 Google 試算表！', 'success');
      } catch (err) {
        showToast(`上傳失敗：${err.message}`, 'error');
      }
    });

    document.getElementById('btnRefreshCloud').addEventListener('click', async () => {
      await api.flushQueue();
      await pullFromCloud(false);
    });

    // 若已設定 GAS，啟動時自動背景同步最新雲端資料
    if (api.isConfigured()) {
      api.flushQueue().then(() => pullFromCloud(true));
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
