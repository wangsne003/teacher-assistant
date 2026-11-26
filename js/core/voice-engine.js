/**
 * 語音互動引擎：
 * - Web Speech API 語音辨識（支援喚醒詞模式 & 按住說話 Push-to-Talk）
 * - SpeechSynthesis 語音播報（TTS）
 * - Web Audio API 輕量合成音效（無需外部 MP3 檔案）
 */
(function (global) {
  const TeacherApp = (global.TeacherApp = global.TeacherApp || {});

  const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;

  class VoiceEngine {
    constructor() {
      this.supported = Boolean(SpeechRecognition);
      this.recognition = null;
      this.isContinuous = false;
      this.isPushToTalk = false;
      this.isListening = false;
      this.onCommandCallback = null;
      this.onStatusCallback = null;
      this.audioCtx = null;
    }

    init({ onCommand, onStatus }) {
      this.onCommandCallback = onCommand;
      this.onStatusCallback = onStatus;
    }

    _ensureRecognition() {
      if (!this.supported) return null;
      if (this.recognition) return this.recognition;

      const rec = new SpeechRecognition();
      rec.lang = 'zh-TW';
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => {
        this.isListening = true;
        this._notify({ listening: true, text: '🎙️ 正在聆聽語音指令...' });
      };

      rec.onresult = (event) => {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interim += transcript;
          }
        }

        if (interim) {
          this._notify({ listening: true, text: `聽到：「${interim}」...` });
        }

        if (finalText) {
          this._handleTranscript(finalText.trim(), this.isPushToTalk);
        }
      };

      rec.onerror = (event) => {
        if (event.error === 'not-allowed') {
          this.isContinuous = false;
          this.isPushToTalk = false;
          this._notify({
            listening: false,
            error: '麥克風權限被拒絕，請在瀏覽器網址列允許麥克風存取（建議透過 https 或 localhost 開啟）。',
          });
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          this._notify({ listening: this.isListening, text: `語音辨識狀態：${event.error}` });
        }
      };

      rec.onend = () => {
        this.isListening = false;
        // 若仍在持續監聽模式，自動無縫重啟（Chrome 單次收音約 60 秒會自動停止）
        if (this.isContinuous) {
          setTimeout(() => {
            if (this.isContinuous && !this.isListening) {
              try {
                rec.continuous = true;
                rec.start();
              } catch (_e) {
                // ignore already started
              }
            }
          }, 250);
        } else {
          this._notify({ listening: false });
        }
      };

      this.recognition = rec;
      return rec;
    }

    _handleTranscript(rawText, bypassWakeWord) {
      const settings = TeacherApp.store.settings;
      const wakeWord = (settings.wakeWord || '小幫手').trim();
      const requireWake = settings.requireWakeWord && !bypassWakeWord;

      let commandText = rawText;

      if (requireWake && wakeWord) {
        // 允許喚醒詞出現在句子中（例如「好，小幫手幫王小明加一分」），亦容錯「小幫手/幫手」
        const idx = rawText.indexOf(wakeWord);
        if (idx === -1) {
          this._notify({
            listening: this.isListening,
            text: `（略過未含喚醒詞「${wakeWord}」的語句：「${rawText}」）`,
          });
          return;
        }
        commandText = rawText.slice(idx + wakeWord.length).replace(/^[，,、。\s]+/, '').trim();
      }

      if (!commandText) {
        this.speak('我在，請說指令');
        this._notify({ listening: this.isListening, text: `已喚醒「${wakeWord}」，請說指令...`, matched: true });
        return;
      }

      if (this.onCommandCallback) {
        this.onCommandCallback(commandText, rawText);
      }
    }

    toggleContinuous() {
      if (!this.supported) {
        this._notify({
          listening: false,
          error: '此瀏覽器不支援 Web Speech API，請改用桌面版 Chrome 或 Edge。',
        });
        return false;
      }

      if (this.isContinuous) {
        this.stopAll();
        return false;
      }

      const rec = this._ensureRecognition();
      this.isContinuous = true;
      this.isPushToTalk = false;
      rec.continuous = true;
      try {
        rec.start();
      } catch (_e) {
        // ignore
      }
      return true;
    }

    startPushToTalk() {
      if (!this.supported) {
        this._notify({
          listening: false,
          error: '此瀏覽器不支援語音辨識，可使用右側文字指令框測試。',
        });
        return;
      }
      if (this.isContinuous) return; // 已在持續監聽中

      const rec = this._ensureRecognition();
      this.isPushToTalk = true;
      rec.continuous = false;
      try {
        rec.start();
      } catch (_e) {
        // ignore
      }
    }

    stopPushToTalk() {
      if (!this.isPushToTalk) return;
      this.isPushToTalk = false;
      if (this.recognition && this.isListening) {
        try {
          this.recognition.stop();
        } catch (_e) {
          // ignore
        }
      }
    }

    stopAll() {
      this.isContinuous = false;
      this.isPushToTalk = false;
      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (_e) {
          // ignore
        }
      }
      this._notify({ listening: false, text: '語音監聽已暫停。' });
    }

    speak(text) {
      if (!TeacherApp.store.settings.ttsEnabled) return;
      if (!global.speechSynthesis || !text) return;

      try {
        global.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-TW';
        utter.rate = 1.08;
        global.speechSynthesis.speak(utter);
      } catch (_e) {
        // ignore TTS failures
      }
    }

    playSound(type) {
      try {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (!AudioCtx) return;
        if (!this.audioCtx) this.audioCtx = new AudioCtx();
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'plus') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12);
          gain.gain.setValueAtTime(0.16, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
          osc.start(now);
          osc.stop(now + 0.25);
        } else if (type === 'minus') {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(340, now);
          osc.frequency.exponentialRampToValueAtTime(220, now + 0.16);
          gain.gain.setValueAtTime(0.16, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          osc.start(now);
          osc.stop(now + 0.23);
        } else if (type === 'win') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(587.33, now);
          osc.frequency.setValueAtTime(783.99, now + 0.1);
          osc.frequency.setValueAtTime(1046.5, now + 0.2);
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
          osc.start(now);
          osc.stop(now + 0.46);
        }
      } catch (_e) {
        // ignore audio errors
      }
    }

    _notify(payload) {
      if (this.onStatusCallback) this.onStatusCallback(payload);
    }
  }

  TeacherApp.voice = new VoiceEngine();
})(window);
