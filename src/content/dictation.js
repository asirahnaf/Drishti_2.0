// Drishti 2.0 — Social Media Voice Dictation & Gaze Confirmation Guardrail (src/content/dictation.js)
//
// Role:
//   • Detects focus on editable input fields, textareas, and contenteditables across social media & the web.
//   • Dictates user speech into the active input field with live preview.
//   • Crucial Safety Guardrail: Displays a floating [Confirm & Send] button with a 1.5s gaze/hover dwell lock
//     before sending, preventing accidental posts or typos.

(() => {
  "use strict";

  const NS = (window.Drishti = window.Drishti || {});

  const DWELL_SEND_MS = 1500;
  const RING_R = 24;
  const RING_C = 2 * Math.PI * RING_R; // ~150.796

  class DictationEngine {
    constructor(options = {}) {
      this.options = options;
      this.sidebar = options.sidebar || null;
      this.voiceEngine = options.voiceEngine || null;
      this.toast = options.toast || ((m) => console.log("[Drishti Dictation]", m));

      this.activeInput = null;
      this.isActive = false;
      this.guardrailEl = null;

      // Dwell confirmation state
      this.hoveringSend = false;
      this.dwellStartTime = 0;
      this.dwellProgress = 0;
      this._animFrame = null;
      this._lastFiredTime = 0;

      this._initUI();
      this._bindFocusListeners();
    }

    _initUI() {
      if (!this.sidebar?.root) return;

      const style = document.createElement("style");
      style.textContent = `
        .drishti-guardrail {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(30px);
          opacity: 0;
          pointer-events: none;
          width: min(580px, 90vw);
          background: rgba(13, 17, 28, 0.96);
          backdrop-filter: blur(12px);
          border: 2px solid #38bdf8;
          border-radius: 16px;
          padding: 12px 18px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.65), 0 0 20px rgba(56, 189, 248, 0.25);
          display: flex;
          flex-direction: column;
          gap: 10px;
          z-index: 2147483647;
          font-family: system-ui, -apple-system, sans-serif;
          user-select: none;
          transition: transform 180ms ease-out, opacity 180ms ease-out;
        }
        .drishti-guardrail.visible {
          transform: translateX(-50%) translateY(0);
          opacity: 1;
          pointer-events: auto;
        }
        .guardrail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #94a3b8;
          font-size: 12px;
          font-weight: 600;
        }
        .guardrail-status {
          display: flex;
          align-items: center;
          gap: 7px;
          color: #38bdf8;
          font-size: 13px;
        }
        .guardrail-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #38bdf8;
          animation: dictation-pulse 1.2s infinite;
        }
        @keyframes dictation-pulse {
          0% { transform: scale(0.85); opacity: 0.6; }
          50% { transform: scale(1.25); opacity: 1; }
          100% { transform: scale(0.85); opacity: 0.6; }
        }
        .guardrail-preview {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 8px 12px;
          color: #f8fafc;
          font-size: 14px;
          line-height: 1.4;
          max-height: 70px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-style: italic;
        }
        .guardrail-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .guardrail-btn {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border-radius: 10px;
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          transition: background 120ms, border-color 120ms, transform 120ms;
        }
        .guardrail-btn-clear {
          flex: 0 0 auto;
          padding: 8px 14px;
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.08);
          color: #cbd5e1;
        }
        .guardrail-btn-clear:hover {
          background: rgba(239, 68, 68, 0.2);
          border-color: #ef4444;
          color: #fca5a5;
        }
        .guardrail-btn-close {
          flex: 0 0 auto;
          padding: 8px 14px;
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.08);
          color: #94a3b8;
        }
        .guardrail-btn-close:hover {
          background: rgba(255, 255, 255, 0.16);
          color: #f8fafc;
        }
        .guardrail-btn-send {
          flex: 1 1 0;
          padding: 10px 16px;
          border: 2px solid #22c55e;
          background: rgba(34, 197, 94, 0.20);
          color: #ffffff;
          box-shadow: 0 0 12px rgba(34, 197, 94, 0.3);
          font-size: 14px;
        }
        .guardrail-btn-send:hover, .guardrail-btn-send.hovering {
          background: rgba(34, 197, 94, 0.35);
          box-shadow: 0 0 18px rgba(34, 197, 94, 0.5);
        }
        .guardrail-btn-send.fired {
          background: #22c55e !important;
          color: #0f172a !important;
          transform: scale(0.98);
        }
        .send-ring {
          width: 32px;
          height: 32px;
          flex-shrink: 0;
        }
        .send-ring-track {
          fill: none;
          stroke: rgba(255, 255, 255, 0.15);
          stroke-width: 4;
        }
        .send-ring-fill {
          fill: none;
          stroke: #22c55e;
          stroke-width: 4;
          stroke-linecap: round;
          transform: rotate(-90deg);
          transform-origin: 50% 50%;
          stroke-dasharray: ${RING_C.toFixed(3)}px;
          stroke-dashoffset: ${RING_C.toFixed(3)}px;
          transition: stroke-dashoffset 60ms linear;
        }
      `;
      this.sidebar.root.appendChild(style);

      const card = document.createElement("div");
      card.className = "drishti-guardrail";
      card.innerHTML = `
        <div class="guardrail-header">
          <div class="guardrail-status">
            <span class="guardrail-dot"></span>
            <span>🎙️ Dictation Mode: Speak your text</span>
          </div>
          <span>Gaze/Dwell on Confirm to Send</span>
        </div>
        <div class="guardrail-preview" id="guardrail-preview-text">"Speak now to type..."</div>
        <div class="guardrail-actions">
          <button type="button" class="guardrail-btn guardrail-btn-clear" id="guardrail-clear">✕ Clear</button>
          <button type="button" class="guardrail-btn guardrail-btn-send" id="guardrail-send">
            <svg class="send-ring" viewBox="0 0 60 60" aria-hidden="true">
              <circle class="send-ring-track" cx="30" cy="30" r="${RING_R}"></circle>
              <circle class="send-ring-fill" cx="30" cy="30" r="${RING_R}"></circle>
            </svg>
            <span>✓ Confirm & Send</span>
          </button>
          <button type="button" class="guardrail-btn guardrail-btn-close" id="guardrail-close">Close</button>
        </div>
      `;

      this.sidebar.root.appendChild(card);
      this.guardrailEl = card;
      this.previewEl = card.querySelector("#guardrail-preview-text");
      this.sendBtn = card.querySelector("#guardrail-send");
      this.ringFill = card.querySelector(".send-ring-fill");

      // Button click fallbacks
      card.querySelector("#guardrail-clear")?.addEventListener("click", () => this.clearText());
      card.querySelector("#guardrail-close")?.addEventListener("click", () => this.close());
      this.sendBtn?.addEventListener("click", () => this.confirmAndSend());
    }

    _bindFocusListeners() {
      document.addEventListener("focusin", (e) => {
        const target = e.target;
        if (this._isEditable(target)) {
          this.activate(target);
        }
      }, { passive: true });
    }

    _isEditable(el) {
      if (!el || el.disabled || el.readOnly) return false;
      if (el.closest && el.closest("#drishti-host")) return false;

      if (el.tagName === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      if (el.tagName === "INPUT") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        const textTypes = ["text", "search", "email", "url", "tel"];
        return textTypes.includes(type);
      }
      return false;
    }

    activate(inputEl) {
      this.activeInput = inputEl;
      this.isActive = true;

      if (this.guardrailEl) {
        this.guardrailEl.classList.add("visible");
        this.updatePreview();
      }

      // Instruct voice engine to switch into Dictation Mode
      this.voiceEngine?.setDictationMode(true);
      this.toast("🎙️ Dictation active: Speak comment or message", 2500);
    }

    close() {
      this.isActive = false;
      this.hoveringSend = false;
      this._resetDwell();

      if (this.guardrailEl) {
        this.guardrailEl.classList.remove("visible");
      }

      this.voiceEngine?.setDictationMode(false);
    }

    updatePreview() {
      if (!this.previewEl || !this.activeInput) return;
      const text = this.activeInput.value || this.activeInput.innerText || "";
      this.previewEl.textContent = text.trim() ? `"${text.trim()}"` : '"Speak now to type..."';
    }

    insertDictatedText(spokenText) {
      if (!this.activeInput || !spokenText) return;
      const el = this.activeInput;
      el.focus();

      // Framework-safe insertion for React, Vue, Angular, and standard DOM
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const proto =
          el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        const currentVal = el.value || "";
        const nextVal = currentVal ? `${currentVal} ${spokenText}` : spokenText;

        if (setter) {
          setter.call(el, nextVal);
        } else {
          el.value = nextVal;
        }

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        try {
          document.execCommand("insertText", false, ` ${spokenText}`);
        } catch (e) {
          el.innerText = `${el.innerText || ""} ${spokenText}`;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      this.updatePreview();
      this.toast(`✍️ Typed: "${spokenText}"`, 2000);
    }

    clearText() {
      if (!this.activeInput) return;
      const el = this.activeInput;
      el.focus();

      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const proto =
          el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(el, "");
        } else {
          el.value = "";
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.innerText = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }

      this.updatePreview();
      this.toast("✕ Input cleared");
    }

    confirmAndSend() {
      const now = Date.now();
      if (now - this._lastFiredTime < 1500) return;
      this._lastFiredTime = now;

      if (!this.activeInput) return;
      const el = this.activeInput;

      // Visual flash
      if (this.sendBtn) {
        this.sendBtn.classList.add("fired");
        setTimeout(() => this.sendBtn?.classList.remove("fired"), 300);
      }

      this.toast("✅ Message Confirmed & Sent!", 2500);

      // Trigger standard send / submit actions
      this._dispatchSend(el);

      setTimeout(() => {
        this.close();
      }, 200);
    }

    _dispatchSend(el) {
      // 1. Look for explicit submit/comment buttons (YouTube, Reddit, Twitter, WhatsApp Web)
      const form = el.form || el.closest("form");
      const submitBtn =
        form?.querySelector('button[type="submit"], input[type="submit"]') ||
        document.querySelector(
          'button[aria-label*="send" i], button[aria-label*="comment" i], button[aria-label*="post" i], button[aria-label*="reply" i], [data-testid="tweetButtonInline"], [data-testid="tweetButton"], ytd-button-renderer#submit-button button'
        );

      if (submitBtn && submitBtn.offsetParent !== null && typeof submitBtn.click === "function") {
        submitBtn.click();
        return;
      }

      // 2. Dispatch Enter (or Ctrl+Enter for multiline textareas)
      const isTextarea = el.tagName === "TEXTAREA" || el.isContentEditable;
      const enterEventOpts = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        ctrlKey: isTextarea,
      };

      el.dispatchEvent(new KeyboardEvent("keydown", enterEventOpts));
      el.dispatchEvent(new KeyboardEvent("keypress", enterEventOpts));
      el.dispatchEvent(new KeyboardEvent("keyup", enterEventOpts));

      // 3. Fallback form requestSubmit
      if (form && typeof form.requestSubmit === "function") {
        try {
          form.requestSubmit();
        } catch (e) {
          /* best effort */
        }
      }
    }

    /** Update mouse or gaze pointer position for dwell ring on Confirm & Send button */
    updatePointer(x, y) {
      if (!this.isActive || !this.sendBtn) return;

      const rect = this.sendBtn.getBoundingClientRect();
      const isInside =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      const now = performance.now();

      if (isInside) {
        if (!this.hoveringSend) {
          this.hoveringSend = true;
          this.dwellStartTime = now;
          this.sendBtn.classList.add("hovering");
        }

        const elapsed = now - this.dwellStartTime;
        this.dwellProgress = Math.min(1, elapsed / DWELL_SEND_MS);

        if (this.ringFill) {
          const offset = RING_C * (1 - this.dwellProgress);
          this.ringFill.style.strokeDashoffset = `${offset.toFixed(3)}px`;
        }

        if (this.dwellProgress >= 1) {
          this._resetDwell();
          this.confirmAndSend();
        }
      } else {
        if (this.hoveringSend) {
          this._resetDwell();
        }
      }
    }

    _resetDwell() {
      this.hoveringSend = false;
      this.dwellStartTime = 0;
      this.dwellProgress = 0;
      if (this.sendBtn) this.sendBtn.classList.remove("hovering");
      if (this.ringFill) {
        this.ringFill.style.strokeDashoffset = `${RING_C.toFixed(3)}px`;
      }
    }
  }

  NS.DictationEngine = DictationEngine;
})();
