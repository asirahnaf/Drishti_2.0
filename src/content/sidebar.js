// Drishti 2.0 — Shadow-DOM sidebar (plan §4, §8)
//
// The control surface: Up/Down + 6 action buttons, each a large gaze zone.
// Lives in a Shadow DOM so the host page's CSS can't touch it and vice-versa.
// This module only DRAWS and exposes zone rects + a dwell-progress hook; it does
// not decide timing (that's dwell.js) or perform actions (that's Step 4+).

(() => {
  "use strict";
  const NS = (window.Drishti = window.Drishti || {});

  // 8 targets: Up/Down scroll + the six §4 actions. `action` is the id fired.
  const BUTTONS = [
    { id: "up", label: "Up", glyph: "▲", hint: "Scroll up" },
    { id: "like", label: "Like", glyph: "♥", hint: "Like current item" },
    { id: "comment", label: "Comment", glyph: "💬", hint: "Voice comment" },
    { id: "share", label: "Share", glyph: "↗", hint: "Share / copy link" },
    { id: "audio", label: "Audio", glyph: "🔊", hint: "Read aloud / talk" },
    { id: "muc", label: "Reply", glyph: "★", hint: "Most-used comment" },
    { id: "mul", label: "React", glyph: "👍", hint: "Most-used reaction" },
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
    .ring { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .ring-track { fill: none; stroke: rgba(255,255,255,0.10); stroke-width: 5; }
    .ring-fill {
      fill: none; stroke: #40c4ff; stroke-width: 5; stroke-linecap: round;
      transform: rotate(-90deg); transform-origin: 50% 50%;
      stroke-dasharray: ${RING_C.toFixed(3)};
      stroke-dashoffset: ${RING_C.toFixed(3)};
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
    .gaze-toggle {
      flex: 0 0 auto; height: 34px;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      border: 2px solid rgba(255,255,255,0.18); border-radius: 10px;
      background: rgba(255,255,255,0.06); color: #f2f5f8;
      font: 600 12px system-ui, sans-serif; cursor: pointer;
    }
    .gaze-toggle.on { border-color: #2ecc71; background: rgba(46,204,113,0.18); }
    .gaze-toggle .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
    .gaze-toggle.on .dot { background: #2ecc71; }
  `;
  class Sidebar {
    /** @param {HTMLElement} host  the #drishti-host node from content.js */
    constructor(host) {
      this.root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
      if (!this.root) throw new Error("[Drishti] host cannot host a shadow root");
      this.buttons = new Map(); // id -> { el, ringFill }
      this._render();
    }

    _render() {
      const style = document.createElement("style");
      style.textContent = STYLE;

      const wrap = document.createElement("div");
      wrap.className = "wrap";

      // Gaze on/off toggle at the top. Mouse-clickable (it's a real control, not a
      // dwell zone) so the user can enable gaze before calibration exists.
      const gazeBtn = document.createElement("button");
      gazeBtn.className = "gaze-toggle";
      gazeBtn.type = "button";
      gazeBtn.setAttribute("aria-label", "Toggle eye-gaze control");
      gazeBtn.innerHTML = `<span class="dot"></span><span class="gaze-label">Gaze off</span>`;
      gazeBtn.addEventListener("click", () => this._onGazeToggle?.());
      this.gazeBtn = gazeBtn;
      wrap.appendChild(gazeBtn);

      for (const b of BUTTONS) {
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

        wrap.appendChild(el);
        this.buttons.set(b.id, { el, ringFill: el.querySelector(".ring-fill") });
      }

      this.root.append(style, wrap);

      // Toast for visible action feedback (copied link, reading aloud, etc.).
      this.toastEl = document.createElement("div");
      this.toastEl.className = "toast";
      this.root.append(this.toastEl);
    }

    /** Zones for the dwell engine: id + a live getRect() (recomputed each hit-test). */
    getZones() {
      return BUTTONS.map((b) => ({
        id: b.id,
        action: b.id,
        getRect: () => this.buttons.get(b.id).el.getBoundingClientRect(),
      }));
    }

    /** Reflect dwell state: highlight the hovered button and fill its ring. */
    renderDwell({ zoneId, progress }) {
      for (const [id, { el, ringFill }] of this.buttons) {
        const active = id === zoneId;
        el.classList.toggle("hovering", active);
        const offset = active ? RING_C * (1 - progress) : RING_C;
        ringFill.style.strokeDashoffset = offset.toFixed(3);
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
