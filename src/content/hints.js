// Drishti 2.0 — Numbered Link Hints Engine (src/content/hints.js)
//
// Role:
//   • Overlays numbered badges [1, 2, 3...] over all visible clickable elements.
//   • Enables hands-free link clicking via voice ("Click 4") or keyboard (Alt+L).
//   • Solves spatial eye-tracking inaccuracy by replacing microscopic link targets with direct ID selection.

(() => {
  "use strict";

  const NS = (window.Drishti = window.Drishti || {});

  const CONTAINER_ID = "drishti-hints-container";
  const MAX_HINTS = 45; // Avoid overwhelming the screen

  class HintsEngine {
    constructor(options = {}) {
      this.options = options;
      this.active = false;
      this.hintsMap = new Map(); // number -> { element, badgeEl }
      this.container = null;
      this.autoHideTimer = null;
      this.toast = options.toast || ((msg) => console.log("[Drishti Hints]", msg));
    }

    _getContainer() {
      let el = document.getElementById(CONTAINER_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = CONTAINER_ID;
        el.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          pointer-events: none;
          z-index: 2147483646;
          font-family: system-ui, -apple-system, sans-serif;
        `;
        (document.body || document.documentElement).appendChild(el);
      }
      return el;
    }

    show() {
      this.hide(); // Clear existing

      const candidates = this._findClickableElements();
      if (candidates.length === 0) {
        this.toast("🔗 No clickable links visible in current view.");
        return 0;
      }

      this.container = this._getContainer();
      this.active = true;

      // Sort candidate elements by visual reading order (top-to-bottom, left-to-right)
      candidates.sort((a, b) => {
        const ra = a.rect;
        const rb = b.rect;
        // Group by roughly 25px vertical bands
        if (Math.abs(ra.top - rb.top) > 25) {
          return ra.top - rb.top;
        }
        return ra.left - rb.left;
      });

      const displayList = candidates.slice(0, MAX_HINTS);

      displayList.forEach((item, index) => {
        const num = index + 1;
        const badge = document.createElement("div");
        badge.className = "drishti-hint-badge";
        badge.textContent = num;
        badge.style.cssText = `
          position: fixed;
          left: ${Math.max(4, Math.min(window.innerWidth - 36, item.rect.left))}px;
          top: ${Math.max(4, Math.min(window.innerHeight - 28, item.rect.top - 4))}px;
          background: #ffe600;
          color: #111111;
          font-weight: 800;
          font-size: 13px;
          line-height: 1;
          padding: 3px 6px;
          border-radius: 4px;
          border: 1.5px solid #000000;
          box-shadow: 0 2px 6px rgba(0,0,0,0.5);
          pointer-events: none;
          z-index: 2147483646;
          letter-spacing: -0.3px;
          transition: transform 100ms;
        `;

        this.container.appendChild(badge);
        this.hintsMap.set(num, { element: item.element, badgeEl: badge });
      });

      this.toast(`🔗 ${displayList.length} links numbered. Say "Click [number]" or just the number!`, 4000);

      // Auto-hide after 16 seconds of inactivity
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = setTimeout(() => {
        if (this.active) this.hide();
      }, 16000);

      return displayList.length;
    }

    click(number) {
      if (!this.active || this.hintsMap.size === 0) {
        // If hints aren't open yet, show them and advise
        this.show();
        return false;
      }

      const num = parseInt(number, 10);
      const target = this.hintsMap.get(num);

      if (!target) {
        this.toast(`⚠️ No link #${number}. (Available: 1 to ${this.hintsMap.size})`);
        return false;
      }

      const { element, badgeEl } = target;

      // Flash badge green to give visual feedback before firing
      badgeEl.style.background = "#2ecc71";
      badgeEl.style.color = "#ffffff";
      badgeEl.style.transform = "scale(1.25)";

      this.toast(`🎯 Selected link #${num}`);

      setTimeout(() => {
        this.hide();

        try {
          // Focus if input, else click
          if (
            element.tagName === "INPUT" ||
            element.tagName === "TEXTAREA" ||
            element.isContentEditable
          ) {
            element.focus();
          }
          element.click();
        } catch (err) {
          console.warn("[Drishti Hints] Click error:", err);
        }
      }, 160);

      return true;
    }

    hide() {
      clearTimeout(this.autoHideTimer);
      this.active = false;
      this.hintsMap.clear();
      if (this.container) {
        this.container.innerHTML = "";
      }
    }

    toggle() {
      if (this.active) {
        this.hide();
        this.toast("🔗 Link hints hidden");
        return false;
      } else {
        const count = this.show();
        return count > 0;
      }
    }

    _findClickableElements() {
      const selector = [
        "a[href]",
        "button",
        "input:not([type='hidden'])",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[role='menuitem']",
        "[role='tab']",
        "[tabindex]:not([tabindex='-1'])",
      ].join(", ");

      const raw = document.querySelectorAll(selector);
      const visible = [];

      for (let i = 0; i < raw.length; i++) {
        const el = raw[i];

        // Never badge Drishti's own sidebar or overlay elements
        if (el.closest && el.closest("#drishti-host")) continue;
        if (el.closest && el.closest(`#${CONTAINER_ID}`)) continue;

        const rect = el.getBoundingClientRect();

        // Must have non-trivial size
        if (rect.width < 10 || rect.height < 10) continue;

        // Must be currently inside the visible viewport
        if (
          rect.bottom < 15 ||
          rect.top > window.innerHeight - 15 ||
          rect.right < 10 ||
          rect.left > window.innerWidth - 10
        ) {
          continue;
        }

        // Must not be visually hidden
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          continue;
        }

        visible.push({ element: el, rect });
      }

      return visible;
    }
  }

  NS.HintsEngine = HintsEngine;
})();
