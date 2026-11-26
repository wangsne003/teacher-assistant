/**
 * GAS 後端通訊層 + 背景同步佇列（Optimistic UI）
 * 注意：POST 統一使用 text/plain;charset=utf-8 以避開 GAS 不支援 CORS preflight (OPTIONS) 的限制。
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  const QUEUE_KEY = 'ta_sync_queue_v1';

  class ApiClient {
    constructor() {
      this.gasUrl = '';
      this.token = '';
      this.queue = this._loadQueue();
      this.isFlushing = false;
      this.listeners = new Set();
    }

    configure(gasUrl, token) {
      this.gasUrl = String(gasUrl || '').trim();
      this.token = String(token || '').trim();
      this._emitStatus();
    }

    isConfigured() {
      return Boolean(this.gasUrl);
    }

    onStatusChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    _emitStatus(overrideState, detail) {
      let state = overrideState;
      if (!state) {
        if (!this.isConfigured()) {
          state = 'local';
        } else if (this.queue.length > 0) {
          state = 'pending';
        } else {
          state = 'ok';
        }
      }
      for (const fn of this.listeners) {
        fn({ state, pendingCount: this.queue.length, detail });
      }
    }

    _loadQueue() {
      try {
        const raw = localStorage.getItem(QUEUE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (_e) {
        return [];
      }
    }

    _saveQueue() {
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
      } catch (_e) {
        // ignore storage quota errors
      }
    }

    async fetchBootstrap() {
      if (!this.isConfigured()) {
        throw new Error('尚未設定 GAS 網址');
      }
      const sep = this.gasUrl.includes('?') ? '&' : '?';
      const url = `${this.gasUrl}${sep}action=bootstrap&token=${encodeURIComponent(this.token)}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'GAS 回傳錯誤');
      this._emitStatus('ok');
      return data;
    }

    async postDirect(action, payload) {
      if (!this.isConfigured()) {
        return { ok: true, localOnly: true };
      }
      const res = await fetch(this.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          token: this.token,
          action,
          payload,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'GAS 寫入失敗');
      return data;
    }

    /**
     * 排入背景同步佇列（前端畫面先即時更新，背景陸續寫入 GAS）
     */
    enqueue(action, payload) {
      if (!this.isConfigured()) return;
      this.queue.push({
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        action,
        payload,
        retries: 0,
      });
      this._saveQueue();
      this._emitStatus('pending');
      this.flushQueue();
    }

    async flushQueue() {
      if (!this.isConfigured() || this.isFlushing || this.queue.length === 0) return;
      this.isFlushing = true;
      this._emitStatus('pending');

      try {
        while (this.queue.length > 0) {
          const item = this.queue[0];
          try {
            await this.postDirect(item.action, item.payload);
            this.queue.shift();
            this._saveQueue();
            this._emitStatus(this.queue.length > 0 ? 'pending' : 'ok');
          } catch (err) {
            item.retries += 1;
            this._saveQueue();
            this._emitStatus('error', err.message);
            // 稍後重試（避免阻塞）
            if (item.retries <= 3) {
              setTimeout(() => this.flushQueue(), 4000 * item.retries);
            }
            break;
          }
        }
      } finally {
        this.isFlushing = false;
      }
    }
  }

  TeacherApp.api = new ApiClient();
})(window);
