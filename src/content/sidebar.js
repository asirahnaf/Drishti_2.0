// Drishti 2.0 — Shadow-DOM sidebar (plan §4, §8)
//
// The control surface: Up/Down + 6 action buttons, each a large gaze zone.
// Lives in a Shadow DOM so the host page's CSS can't touch it and vice-versa.
// This module only DRAWS and exposes zone rects + a dwell-progress hook; it does
// not decide timing (that's dwell.js) or perform actions (that's Step 4+).

(() => {
  "use strict";
  const NS = (window.Drishti = window.Drishti || {});

  // 4 large essential targets: Up, Share, Audio, Down. Each takes 25% of sidebar height.
  const BUTTONS = [
    { id: "up", label: "Up", glyph: "▲", hint: "Scroll up" },
    { id: "share", label: "Share", glyph: "↗", hint: "Share / copy link" },
    { id: "audio", label: "Audio", glyph: "🔊", hint: "Read aloud / talk" },
    { id: "down", label: "Down", glyph: "▼", hint: "Scroll down" },
  ];

  const RING_R = 44;
  const RING_C = 2 * Math.PI * RING_R; // circumference for stroke-dashoffset math

  // All UI lives inside the shadow root, so these rules can't leak to the page
  // and the page's rules can't reach in (plan §8: isolate UI in a Shadow DOM).
  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed; top: 0; right: 0;
      width: 108px; height: 100vh;
      display: flex; flex-direction: column;
      gap: 6px; padding: 8px 8px;
      box-sizing: border-box;
      background: rgba(12, 14, 20, 0.82);
      backdrop-filter: blur(4px);
      z-index: 2147483647;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      user-select: none;
    }
    .btn {
      position: relative; flex: 1 1 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 2px;
      border: 2px solid rgba(255,255,255,0.18);
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      color: #f2f5f8; cursor: pointer;
      transition: background 120ms, border-color 120ms;
    }
    .btn:hover, .btn.hovering {
      background: rgba(64, 196, 255, 0.16);
      border-color: rgba(64, 196, 255, 0.9);
    }
    .btn.fired { background: rgba(64, 255, 148, 0.28); }
    .glyph { font-size: 26px; line-height: 1; }
    .label { font-size: 12px; font-weight: 600; letter-spacing: 0.2px; }
    .ring {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 76%; height: auto;
      aspect-ratio: 1 / 1;
      max-height: 80%;
      pointer-events: none;
    }
    .ring-track { fill: none; stroke: rgba(255,255,255,0.10); stroke-width: 5; }
    .ring-fill {
      fill: none; stroke: #40c4ff; stroke-width: 5; stroke-linecap: round;
      transform: rotate(-90deg); transform-origin: 50% 50%;
      stroke-dasharray: ${RING_C.toFixed(3)}px;
      stroke-dashoffset: ${RING_C.toFixed(3)}px;
    }
    .toast {
      position: fixed; bottom: 18px; right: 124px;
      max-width: 320px; padding: 10px 14px;
      background: rgba(12,14,20,0.94); color: #f2f5f8;
      border: 1px solid rgba(64,196,255,0.5); border-radius: 10px;
      font-size: 13px; line-height: 1.35;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      opacity: 0; transform: translateY(6px); transition: opacity 140ms, transform 140ms;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .header-row {
      display: flex; gap: 4px; flex: 0 0 auto; width: 100%;
    }
    .gaze-toggle, .voice-toggle {
      flex: 1 1 0; height: 28px;
      display: flex; align-items: center; justify-content: center; gap: 4px;
      border: 2px solid rgba(255,255,255,0.18); border-radius: 9px;
      background: rgba(255,255,255,0.06); color: #f2f5f8;
      font: 600 10.5px system-ui, sans-serif; cursor: pointer;
      transition: background 120ms, border-color 120ms;
      padding: 0 2px;
    }
    .gaze-toggle.on { border-color: #2ecc71; background: rgba(46,204,113,0.18); }
    .gaze-toggle .dot { width: 7px; height: 7px; border-radius: 50%; background: #888; }
    .gaze-toggle.on .dot { background: #2ecc71; }
    .voice-toggle.on { border-color: #38bdf8; background: rgba(56,189,248,0.20); }
    .voice-toggle .dot { width: 7px; height: 7px; border-radius: 50%; background: #888; }
    .voice-toggle.on .dot { background: #38bdf8; animation: pulse 1.2s infinite; }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.7; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.7; }
    }
    .aac-toggle {
      flex: 0 0 auto; height: 28px; width: 100%;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      border: 2px solid rgba(255,255,255,0.18); border-radius: 9px;
      background: rgba(255,255,255,0.06); color: #f2f5f8;
      font: 600 11px system-ui, sans-serif; cursor: pointer;
      transition: background 120ms, border-color 120ms, box-shadow 120ms;
    }
    .aac-toggle.on {
      border-color: #c084fc;
      background: rgba(192, 132, 252, 0.22);
      box-shadow: 0 0 10px rgba(192, 132, 252, 0.35);
    }
    .group-wrap {
      flex: 1 1 0; display: flex; flex-direction: column; gap: 5px; width: 100%; min-height: 0;
    }
    .btn.alert {
      border-color: rgba(239, 68, 68, 0.7);
      background: rgba(239, 68, 68, 0.16);
      color: #fca5a5;
    }
    .btn.alert:hover, .btn.alert.hovering {
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.35);
    }
    .gaze-cursor {
      position: fixed;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: rgba(64, 196, 255, 0.45);
      border: 2px solid #ffffff;
      box-shadow: 0 0 8px rgba(64, 196, 255, 0.8);
      pointer-events: none;
      z-index: 2147483647;
      display: none;
      transform: translate(-50%, -50%);
    }
  `;
  class Sidebar {
    /** @param {HTMLElement} host  the #drishti-host node from content.js */
    constructor(host) {
      this.root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
      if (!this.root) throw new Error("[Drishti] host cannot host a shadow root");
      this.buttons = new Map(); // id -> { el, ringFill }
      this.isAacOpen = false;
      this._render();
    }

    _createButtonEl(b) {
      const el = document.createElement("div");
      el.className = "btn";
      el.dataset.id = b.id;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `${b.label} — ${b.hint}`);
      el.title = b.hint;

      // Confirm ring (SVG), fills as dwell progresses.
      el.innerHTML = `
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="ring-track" cx="50" cy="50" r="${RING_R}"></circle>
          <circle class="ring-fill" cx="50" cy="50" r="${RING_R}"></circle>
        </svg>
        <span class="glyph" aria-hidden="true">${b.glyph}</span>
        <span class="label">${b.label}</span>
      `;
      return el;
    }

    _render() {
      const style = document.createElement("style");
      style.textContent = STYLE;

      const wrap = document.createElement("div");
      wrap.className = "wrap";

      // 1. Header row with Gaze and Voice side-by-side
      const headerRow = document.createElement("div");
      headerRow.className = "header-row";

      const gazeBtn = document.createElement("button");
      gazeBtn.className = "gaze-toggle";
      gazeBtn.type = "button";
      gazeBtn.setAttribute("aria-label", "Toggle eye-gaze control");
      gazeBtn.innerHTML = `<span class="dot"></span><span class="gaze-label">Gaze off</span>`;
      gazeBtn.addEventListener("click", () => this._onGazeToggle?.());
      this.gazeBtn = gazeBtn;
      headerRow.appendChild(gazeBtn);

      const voiceBtn = document.createElement("button");
      voiceBtn.className = "voice-toggle";
      voiceBtn.type = "button";
      voiceBtn.setAttribute("aria-label", "Toggle voice command control");
      voiceBtn.innerHTML = `<span class="dot"></span><span class="voice-label">Voice off</span>`;
      voiceBtn.addEventListener("click", () => this._onVoiceToggle?.());
      this.voiceBtn = voiceBtn;
      headerRow.appendChild(voiceBtn);
      wrap.appendChild(headerRow);

      // 2. AAC Quick Talk toggle button
      const aacBtn = document.createElement("button");
      aacBtn.className = "aac-toggle";
      aacBtn.type = "button";
      aacBtn.setAttribute("aria-label", "Toggle AAC quick speech phrase menu");
      aacBtn.innerHTML = `<span class="aac-label">🗣️ Quick Talk</span>`;
      aacBtn.addEventListener("click", () => this.toggleAac());
      this.aacBtn = aacBtn;
      wrap.appendChild(aacBtn);

      // 3. Navigation Buttons Group (Default)
      const navGroup = document.createElement("div");
      navGroup.className = "group-wrap nav-group";
      for (const b of BUTTONS) {
        const el = this._createButtonEl(b);
        navGroup.appendChild(el);
        this.buttons.set(b.id, { el, ringFill: el.querySelector(".ring-fill") });
      }
      wrap.appendChild(navGroup);
      this.navGroup = navGroup;

      // 4. AAC Phrase Tiles Group (Collapsible Drawer)
      const aacPhrases = window.Drishti?.AAC_PHRASES || [];
      const aacGroup = document.createElement("div");
      aacGroup.className = "group-wrap aac-group";
      aacGroup.style.display = "none";
      for (const p of aacPhrases) {
        const el = this._createButtonEl(p);
        if (p.alert) el.classList.add("alert");
        aacGroup.appendChild(el);
        this.buttons.set(p.id, { el, ringFill: el.querySelector(".ring-fill") });
      }
      wrap.appendChild(aacGroup);
      this.aacGroup = aacGroup;

      this.root.append(style, wrap);

      // Toast for visible action feedback (copied link, reading aloud, etc.).
      this.toastEl = document.createElement("div");
      this.toastEl.className = "toast";
      this.root.append(this.toastEl);

      // Visual gaze feedback cursor
      this.gazeCursor = document.createElement("div");
      this.gazeCursor.className = "gaze-cursor";
      this.root.append(this.gazeCursor);
    }

    /** Zones for the dwell engine: id + a live getRect() (recomputed each hit-test). */
    getZones() {
      const activeList = this.isAacOpen
        ? (window.Drishti?.AAC_PHRASES || [])
        : BUTTONS;

      return activeList.map((b) => ({
        id: b.id,
        action: b.id,
        getRect: () => {
          const btnObj = this.buttons.get(b.id);
          if (!btnObj?.el) return null;
          const r = btnObj.el.getBoundingClientRect();
          // Expand horizontal hitbox to cover the right 35% of the screen (Fitts' Law)
          // Safe reading area remains on the left 65% of the viewport
          const triggerLeft = Math.min(r.left - 450, window.innerWidth * 0.65);
          return {
            left: triggerLeft,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        },
      }));
    }

    /** Reflect dwell state: highlight the hovered button and fill its ring. */
    renderDwell({ zoneId, progress }) {
      for (const [id, { el, ringFill }] of this.buttons) {
        const active = id === zoneId;
        el.classList.toggle("hovering", active);
        const offset = active ? RING_C * (1 - progress) : RING_C;
        ringFill.style.strokeDashoffset = `${offset.toFixed(3)}px`;
      }
    }

    /** Move and show/hide the visual gaze cursor dot. */
    updateGazeCursor(x, y, show) {
      if (!this.gazeCursor) return;
      if (show) {
        this.gazeCursor.style.display = "block";
        this.gazeCursor.style.left = `${x}px`;
        this.gazeCursor.style.top = `${y}px`;
      } else {
        this.gazeCursor.style.display = "none";
      }
    }

    /** Brief green flash on fire, so the user sees the action landed. */
    flashFire(zoneId) {
      const b = this.buttons.get(zoneId);
      if (!b) return;
      b.el.classList.add("fired");
      setTimeout(() => b.el.classList.remove("fired"), 260);
    }

    /** Register the gaze toggle handler (called from content.js). */
    onGazeToggle(fn) {
      this._onGazeToggle = fn;
    }

    /** Reflect gaze on/off in the toggle button. */
    setGazeState(on) {
      if (!this.gazeBtn) return;
      this.gazeBtn.classList.toggle("on", !!on);
      const label = this.gazeBtn.querySelector(".gaze-label");
      if (label) label.textContent = on ? "Gaze on" : "Gaze off";
    }

    /** Register the voice toggle handler (called from content.js). */
    onVoiceToggle(fn) {
      this._onVoiceToggle = fn;
    }

    /** Reflect voice on/off in the toggle button. */
    setVoiceState(on) {
      if (!this.voiceBtn) return;
      this.voiceBtn.classList.toggle("on", !!on);
      const label = this.voiceBtn.querySelector(".voice-label");
      if (label) label.textContent = on ? "Voice on" : "Voice off";
    }

    /** Register the AAC phrase toggle handler (called from content.js). */
    onAacToggle(fn) {
      this._onAacToggle = fn;
    }

    /** Open or close AAC phrase drawer. */
    setAacOpen(open) {
      this.isAacOpen = !!open;
      if (this.navGroup) this.navGroup.style.display = this.isAacOpen ? "none" : "flex";
      if (this.aacGroup) this.aacGroup.style.display = this.isAacOpen ? "flex" : "none";
      if (this.aacBtn) {
        this.aacBtn.classList.toggle("on", this.isAacOpen);
        const label = this.aacBtn.querySelector(".aac-label");
        if (label) label.textContent = this.isAacOpen ? "🗣️ Talk on" : "🗣️ Quick Talk";
      }
      this._onAacToggle?.(this.isAacOpen);
    }

    /** Toggle AAC phrase drawer. */
    toggleAac() {
      this.setAacOpen(!this.isAacOpen);
      return this.isAacOpen;
    }

    /** Show a short message near the sidebar; auto-hides. */
    toast(msg, ms = 2200) {
      const el = this.toastEl;
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => el.classList.remove("show"), ms);
    }
  }

  NS.Sidebar = Sidebar;
  NS.SIDEBAR_BUTTONS = BUTTONS;
})();
