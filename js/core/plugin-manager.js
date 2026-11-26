/**
 * 插件管理器 & 指令路由器（讓未來新增工具極度容易）
 *
 * 每個工具插件只要呼叫：
 * TeacherApp.plugins.register({
 *   id: 'my-tool',
 *   name: '工具名稱',
 *   icon: '⏱️',
 *   order: 50,
 *   commands: [
 *     { pattern: /倒數(\d+)分鐘/, description: '倒數 N 分鐘', handler(match, ctx) { ... } }
 *   ],
 *   render(container, ctx) { ... }
 * })
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  class PluginManager {
    constructor() {
      this.plugins = [];
      this.activeId = null;
      this.tabContainer = null;
      this.viewportContainer = null;
      this.contextFactory = null;
    }

    register(plugin) {
      if (!plugin || !plugin.id) throw new Error('插件必須包含 id');
      const existsIdx = this.plugins.findIndex((p) => p.id === plugin.id);
      if (existsIdx >= 0) {
        this.plugins[existsIdx] = plugin;
      } else {
        this.plugins.push(plugin);
      }
      this.plugins.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }

    mount(tabContainer, viewportContainer, contextFactory) {
      this.tabContainer = tabContainer;
      this.viewportContainer = viewportContainer;
      this.contextFactory = contextFactory;

      if (!this.activeId && this.plugins.length > 0) {
        this.activeId = this.plugins[0].id;
      }
      this.renderTabs();
      this.renderActive();
    }

    renderTabs() {
      if (!this.tabContainer) return;
      this.tabContainer.innerHTML = '';
      for (const p of this.plugins) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tool-tab ${p.id === this.activeId ? 'active' : ''}`;
        btn.innerHTML = `<span>${p.icon || '🧰'}</span><span>${p.name}</span>`;
        btn.addEventListener('click', () => this.activate(p.id));
        this.tabContainer.appendChild(btn);
      }
    }

    activate(pluginId) {
      if (!this.plugins.some((p) => p.id === pluginId)) return;
      this.activeId = pluginId;
      this.renderTabs();
      this.renderActive();
    }

    renderActive() {
      if (!this.viewportContainer) return;
      const plugin = this.plugins.find((p) => p.id === this.activeId);
      if (!plugin) return;
      const ctx = this.contextFactory();
      plugin.render(this.viewportContainer, ctx);
    }

    getPlugin(pluginId) {
      return this.plugins.find((p) => p.id === pluginId) || null;
    }

    /**
     * 將語音或文字指令路由至智慧 NLU / 工具插件 / 選配 Gemini AI
     * @returns {Promise<{ handled: boolean, pluginId?: string, message?: string, error?: string }>}
     */
    async dispatchCommand(commandText) {
      const clean = String(commandText || '').trim();
      if (!clean) return { handled: false };

      const ctx = this.contextFactory();

      // 第一層：強化版本地自然口語 NLU（涵蓋全網頁指令與自然句型）
      if (TeacherApp.smartNlu) {
        const localRes = TeacherApp.smartNlu.tryLocalDispatch(clean, ctx);
        if (localRes.handled) return localRes;
      }

      // 第二層：遍歷各工具插件自訂的語音指令規則（同時自動去除口語開頭「我要/幫我/請」方便未來新插件）
      const stripped = TeacherApp.smartNlu ? TeacherApp.smartNlu.stripFillerWords(clean) : clean;
      for (const plugin of this.plugins) {
        if (!Array.isArray(plugin.commands)) continue;
        for (const cmd of plugin.commands) {
          const match = clean.match(cmd.pattern) || stripped.match(cmd.pattern);
          if (match) {
            const result = cmd.handler(match, ctx);
            if (cmd.autoSwitch !== false && this.activeId !== plugin.id) {
              this.activate(plugin.id);
            } else {
              this.renderActive();
            }
            return {
              handled: true,
              pluginId: plugin.id,
              message: typeof result === 'string' ? result : '指令執行完成',
            };
          }
        }
      }

      // 第三層：若使用者已設定 Gemini API Key，自動啟用 AI 理解複雜口語
      if (TeacherApp.smartNlu && ctx.store.settings.geminiApiKey) {
        return await TeacherApp.smartNlu.tryGeminiDispatch(clean, ctx);
      }

      return { handled: false };
    }
  }

  TeacherApp.plugins = new PluginManager();
})(window);
