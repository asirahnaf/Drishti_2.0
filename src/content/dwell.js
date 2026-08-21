// Drishti 2.0 — Dwell state machine (plan §4)
//
//   IDLE ──point enters zone──▶ HOVER ──dwell 750ms──▶ CONFIRM(fill ring) ──▶ FIRE
//     ▲                           │                                            │
//     └────────point leaves───────┘◀──────────── cooldown 400ms ──────────────┘
//
// Design goal: input-agnostic. It consumes a stream of (x, y) VIEWPORT points and
// hit-tests them against registered zone rectangles. In Step 2 those points come
// from the mouse; in Step 3 they come from WebGazer — nothing else changes.
//
// It runs its own requestAnimationFrame tick using the LAST known point, so dwell
// keeps progressing even when the pointer is perfectly still (mouse stopped, or a
// steady gaze). Movement events only update the point; the tick drives the timing.

(() => {
  "use strict";
  const NS = (window.Drishti = window.Drishti || {});

  const STATE = { IDLE: "IDLE", HOVER: "HOVER", COOLDOWN: "COOLDOWN" };

  class DwellEngine {
    /**
     * @param {object} opts
     * @param {number} opts.dwellMs     ms of steady dwell before firing
     * @param {number} opts.cooldownMs  ms lockout after a fire
     * @param {(info:object)=>void} opts.onState  called every tick with {state, zoneId, progress}
     * @param {(zone:object)=>void} opts.onFire   called once when a zone fires
     */
    constructor({ dwellMs = 750, cooldownMs = 400, onState, onFire }) {
      this.dwellMs = dwellMs;
      this.cooldownMs = cooldownMs;
      this.onState = onState || (() => {});
      this.onFire = onFire || (() => {});

      this.zones = []; // [{ id, action, getRect: () => DOMRect }]
      this.point = null; // { x, y } last known viewport point
      this.state = STATE.IDLE;
      this.zoneId = null; // zone currently being dwelled
      this.enterAt = 0; // performance.now() when HOVER began
      this.cooldownUntil = 0;

      this._running = false;
      this._tick = this._tick.bind(this);
    }

    setZones(zones) {
      this.zones = zones;
    }

    /** Feed a viewport point (mouse now, gaze later). */
    update(x, y) {
      this.point = { x, y };
    }

    /** Point left the tracked surface entirely (e.g. mouse off-window). */
    clearPoint() {
      this.point = null;
    }

    start() {
      if (this._running) return;
      this._running = true;
      this.lastTickTime = performance.now();
      requestAnimationFrame(this._tick);
    }

    stop() {
      this._running = false;
      this._reset(STATE.IDLE);
    }

    _reset(state) {
      this.state = state;
      this.zoneId = null;
      this.progress = 0;
      this.lastTickTime = 0;
    }

    _zoneAt(x, y) {
      let closestZone = null;
      let minDistanceY = Infinity;

      for (const z of this.zones) {
        const r = z.getRect();
        if (!r) continue;
        
        // 1. Check if x is within the expanded horizontal range of this button
        if (x >= r.left && x <= r.right) {
          // 2. Calculate vertical distance to the button's center
          const centerY = r.top + (r.bottom - r.top) / 2;
          const distY = Math.abs(y - centerY);
          
          if (distY < minDistanceY) {
            minDistanceY = distY;
            closestZone = z;
          }
        }
      }

      // 3. Safety threshold: only accept the closest button if the vertical distance
      // is within a reasonable range (at most 1.5 times the button's height)
      // to prevent triggering if they look completely off-screen.
      if (closestZone) {
        const r = closestZone.getRect();
        const height = r.bottom - r.top;
        if (minDistanceY <= height * 1.5) {
          return closestZone;
        }
      }

      return null;
    }

    _tick(now) {
      if (!this._running) return;

      const dt = this.lastTickTime ? (now - this.lastTickTime) : 16;
      this.lastTickTime = now;

      // Cooldown: ignore all input until it elapses.
      if (this.state === STATE.COOLDOWN) {
        if (now >= this.cooldownUntil) {
          this._reset(STATE.IDLE);
        }
        this._emit(0);
        return requestAnimationFrame(this._tick);
      }

      const p = this.point;
      const zone = p ? this._zoneAt(p.x, p.y) : null;

      if (zone) {
        if (zone.id !== this.zoneId) {
          // Switched to a new zone
          this.zoneId = zone.id;
          this.state = STATE.HOVER;
          this.progress = 0;
        }

        // Accumulate progress
        this.progress = Math.min(1, this.progress + dt / this.dwellMs);

        if (p) {
          console.warn(`[Drishti/dwell] Point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is IN zone: ${zone.id}, progress: ${this.progress.toFixed(2)}`);
        }

        if (this.progress >= 1) {
          // FIRE
          this.onFire(zone);
          this.state = STATE.COOLDOWN;
          this.cooldownUntil = now + this.cooldownMs;
          this.zoneId = null;
          this.progress = 0;
          this._emit(0);
        } else {
          this._emit(this.progress);
        }
      } else {
        // No zone: slowly decay progress (drain over 500ms)
        if (this.progress > 0) {
          this.progress = Math.max(0, this.progress - dt / 500);
          this._emit(this.progress);
          
          if (p && Math.random() < 0.02) {
            console.warn(`[Drishti/dwell] Point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is OUT of zones. Draining progress: ${this.progress.toFixed(2)}`);
          }
        } else {
          if (this.state !== STATE.IDLE) {
            this.state = STATE.IDLE;
            this.zoneId = null;
          }
          this._emit(0);
          
          if (p && Math.random() < 0.02) {
            console.warn(`[Drishti/dwell] Point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is OUT of zones. Idle.`);
          }
        }
      }

      return requestAnimationFrame(this._tick);
    }

    _emit(progress) {
      this.onState({ state: this.state, zoneId: this.zoneId, progress });
    }
  }

  NS.DwellEngine = DwellEngine;
  NS.DWELL_STATE = STATE;
})();
