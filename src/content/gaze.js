// Drishti 2.0 — Gaze controller (content-script side, plan §3 gaze loop, §2 calibration)
//
// The eye-tracking engine (WebGazer + MediaPipe FaceMesh) does NOT run here anymore.
// It runs in an extension-origin iframe (src/gaze/frame.html) so its relative model
// path and injected scripts live under a chrome-extension:// origin + our CSP,
// instead of the host page's (which caused the 404 + CSP failures in the first cut).
//
// This controller:
//   • injects that invisible, click-through, full-viewport iframe once
//   • starts/stops it and relays gaze coords → onGaze(x, y) (the SAME dwell input
//     the mouse uses, so hover → ring → fire is identical)
//   • runs the on-page 9-dot calibration overlay and forwards each look-point to
//     the frame via recordScreenPosition (the frame can't see the page's clicks)
//
// Public API is unchanged (enable/disable/toggle/constructor), so content.js —
// which wires the sidebar toggle and dwell — needs no changes.

(() => {
  "use strict";
  const NS = (window.Drishti = window.Drishti || {});
  const MSG_NS = "drishti-gaze";

  const ext =
    window.Drishti?.platform?.ext ||
    (typeof chrome !== "undefined" ? chrome : browser);

  class GazeController {
    /**
     * @param {object} opts
     * @param {(x:number,y:number,mode?:string)=>void} opts.onGaze  viewport gaze coords
     * @param {(gesture:string, score:number)=>void} opts.onGesture hand gesture recognition
     * @param {()=>void} opts.onCalibComplete calibration finished
     * @param {(state:object)=>void} opts.onAudioState audio gate and RNNoise VAD state
     * @param {string} [opts.trackingMode] "gaze" or "head"
     * @param {(msg:string, ms?:number)=>void} opts.toast  user-facing status
     */
    constructor({ onGaze, onGesture, onCalibComplete, onAudioState, trackingMode = "gaze", toast }) {
      this.onGaze = onGaze || (() => {});
      this.onGesture = onGesture || (() => {});
      this.onCalibComplete = onCalibComplete || (() => {});
      this.onAudioState = onAudioState || (() => {});
      this.trackingMode = trackingMode; // "gaze" or "head"
      this.recenterOffsetX = 0;
      this.recenterOffsetY = 0;
      this.lastRawX = window.innerWidth / 2;
      this.lastRawY = window.innerHeight / 2;
      this.toast = toast || (() => {});
      this.running = false;
      this.iframe = null;
      this._frameReady = null; // Promise resolved when frame posts {evt:'loaded'}
      this._extOrigin = new URL(ext.runtime.getURL("")).origin;
      this._overlay = null;
      this._onCalibFixation = null;
      this._onCalibGaze = null;
      this._onMessage = this._onMessage.bind(this);
      this._startWaiters = null; // {resolve} for the pending start() round-trip
    }

    /** Inject the extension-origin gaze iframe (once) and wait for it to load. */
    _ensureFrame() {
      if (this._frameReady) return this._frameReady;

      window.addEventListener("message", this._onMessage);

      this._frameReady = new Promise((resolve, reject) => {
        const iframe = document.createElement("iframe");
        iframe.id = "drishti-gaze-frame";
        iframe.src = ext.runtime.getURL("src/gaze/frame.html");
        iframe.allow = "camera; microphone";
        // Full viewport so WebGazer's coord clamping == the visible viewport.
        // Invisible + click-through: it must never intercept the user's input.
        iframe.style.cssText = [
          "position:fixed", "inset:0",
          "width:100vw", "height:100vh",
          "border:0", "margin:0", "padding:0",
          "background:transparent",
          "pointer-events:none",
          "z-index:2147483645", // just under the sidebar (…647) + calibration (…646)
        ].join(";");
        this._loadTimer = setTimeout(
          () => reject(new Error("gaze frame did not load")),
          10000
        );
        this._resolveLoaded = resolve;
        (document.body || document.documentElement).appendChild(iframe);
        this.iframe = iframe;
      });
      return this._frameReady;
    }

    _post(cmd, extra = {}) {
      if (!this.iframe?.contentWindow) return;
      this.iframe.contentWindow.postMessage(
        { ns: MSG_NS, cmd, ...extra },
        this._extOrigin
      );
    }

    _onMessage(e) {
      // Only trust our extension-origin frame with the right namespace.
      if (e.origin !== this._extOrigin) return;
      if (e.source !== this.iframe?.contentWindow) return;
      const d = e.data;
      if (!d || d.ns !== MSG_NS || !d.evt) return;

      switch (d.evt) {
        case "loaded":
          clearTimeout(this._loadTimer);
          this._resolveLoaded?.(true);
          break;
        case "gaze":
          if (this.running && !this._isCalibrating) {
            this.lastRawX = d.x;
            this.lastRawY = d.y;
            const finalX = Math.max(0, Math.min(window.innerWidth, d.x + this.recenterOffsetX));
            const finalY = Math.max(0, Math.min(window.innerHeight, d.y + this.recenterOffsetY));
            this.onGaze(finalX, finalY, d.mode);
          }
          break;
        case "calibGaze":
          if (this._isCalibrating && this._onCalibGaze) {
            this._onCalibGaze(d.x, d.y);
          }
          break;
        case "calibFixation":
          if (this._isCalibrating && this._onCalibFixation) {
            this._onCalibFixation(d);
          }
          break;
        case "calibSample":
          // Frame reports current calibration sample count
          break;
        case "gesture":
          if (this.running && this.onGesture) {
            this.onGesture(d.gesture, d.score);
          }
          break;
        case "audioState":
          if (this.onAudioState) {
            this.onAudioState(d);
          }
          break;
        case "audioReady":
          console.info("[Drishti GazeBridge] Audio processor ready in frame");
          break;
        case "audioError":
          console.warn("[Drishti GazeBridge] Audio processor error in frame:", d.error);
          break;
        case "audioStopped":
          break;
        case "status":
          console.info(`[Drishti] ${d.msg}`);
          break;
        case "toast":
          console.log(`[Drishti Toast] ${d.msg}`);
          this.toast(d.msg, d.ms);
          break;
        case "ready":
          this._startWaiters?.resolve(true);
          this._startWaiters = null;
          break;
        case "error": {
          const e = new Error(d.message || "gaze error");
          e.camName = d.name || ""; // DOMException name from the frame's preflight
          this._startWaiters?.resolve(e);
          this._startWaiters = null;
          break;
        }
        case "stopped":
          /* acknowledged in disable() */
          break;
      }
    }

    /** Turn gaze/head tracking ON: load frame, start camera+model. */
    async enable() {
      if (this.running) return true;
      const isHead = this.trackingMode === "head";
      this.toast(isHead ? "Starting camera for head tracking…" : "Starting camera for gaze…", 3000);

      try {
        await this._ensureFrame();
      } catch (err) {
        console.error("[Drishti] tracking frame load failed:", err);
        this.toast("Tracking engine could not load — mouse still works", 6000);
        return false;
      }

      // Configure tracking mode in the frame
      this._post("setTrackingMode", { mode: this.trackingMode });

      // Kick off WebGazer in the frame. Preview on for eye gaze calibration.
      const outcome = await new Promise((resolve) => {
        this._startWaiters = { resolve };
        this._post("start", { opts: { preview: !isHead } });
        // Safety net: model download / permission dialog can be slow.
        setTimeout(() => {
          if (this._startWaiters) {
            this._startWaiters.resolve(new Error("timed out starting camera"));
            this._startWaiters = null;
          }
        }, 30000);
      });

      if (outcome instanceof Error) {
        console.error("[Drishti] Tracking failed to start:", outcome.camName || "", outcome.message);
        const name = outcome.camName || "";
        let m;
        if (name === "NotAllowedError" || /denied|NotAllowed/i.test(outcome.message)) {
          m = "Camera blocked. Check Windows camera privacy + Edge site camera setting — mouse still works";
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          m = "No camera found. Connect a webcam (or DroidCam) — mouse still works";
        } else if (name === "NotReadableError") {
          m = "Camera is in use by another app. Close it and retry — mouse still works";
        } else {
          m = "Camera tracking unavailable — mouse still works";
        }
        this.toast(m, 7000);
        return false;
      }

      this.running = true;
      this.recenterOffsetX = 0;
      this.recenterOffsetY = 0;

      // In Head Motion Mode: zero 9-point calibration needed! Starts instantly from current neutral pose.
      if (isHead) {
        this._post("preview", { on: false });
        this.toast("👤 Head Motion Active — tilt/turn head to steer", 4000);
        return true;
      }

      // In Eye Gaze Mode: run 9-dot calibration
      await this.calibrate();
      this._post("preview", { on: false });
      return true;
    }

    /** Turn tracking OFF and release the camera. */
    async disable() {
      if (!this.running) return;
      this._post("stop");
      this.running = false;
      this._removeOverlay();
      this.recenterOffsetX = 0;
      this.recenterOffsetY = 0;
      this.toast("Tracking off — mouse control active");
    }

    async toggle() {
      return this.running ? (await this.disable(), false) : await this.enable();
    }

    /** Switch tracking mode ("gaze" vs "head"). */
    setTrackingMode(mode) {
      this.trackingMode = mode === "head" ? "head" : "gaze";
      this.recenterOffsetX = 0;
      this.recenterOffsetY = 0;
      this._post("setTrackingMode", { mode: this.trackingMode });
    }

    /** Re-anchor tracking to the user's current posture (Opentrack zero). */
    recenter() {
      this._post("recenter");
      this.recenterOffsetX = (window.innerWidth / 2) - this.lastRawX;
      this.recenterOffsetY = (window.innerHeight / 2) - this.lastRawY;
      this.toast("🎯 Re-centered tracking to current posture", 2200);
    }

    /** Start audio processor (RNNoise neural filter + decibel gate) in the extension frame. */
    async startAudio() {
      try {
        await this._ensureFrame();
        this._post("startAudio");
      } catch (err) {
        console.warn("[Drishti] Could not start audio processor:", err);
      }
    }

    /** Stop audio processor in the extension frame. */
    stopAudio() {
      this._post("stopAudio");
    }

    /**
     * 9-dot calibration overlay (on the page, so points span the real viewport).
     * The user looks at each dot and clicks it 5×; each click forwards the dot's
     * viewport coords to the frame, which records the eye→screen sample.
     */
    /**
     * 9-dot calibration overlay (on the page, so points span the real viewport).
     * Guides the user sequentially through the 9 dots. The user looks at the active
     * pulsing dot and clicks it 5× (or presses Spacebar). Each click forwards the
     * dot's viewport coords to the frame.
     */
    calibrate() {
      return new Promise((resolve) => {
        this._removeOverlay();
        this._isCalibrating = true;
        this._post("calibStart");

        const overlay = document.createElement("div");
        overlay.id = "drishti-calibration";
        overlay.style.cssText = [
          "position:fixed", "inset:0", "z-index:2147483648",
          "background:rgba(8,10,16,0.72)", "backdrop-filter:blur(2px)",
        ].join(";");

        // Inject styles for active, inactive, completed states and circular progress ring.
        const style = document.createElement("style");
        style.textContent = `
          @keyframes drishti-core-pulse {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); }
            70% { transform: scale(1.15); box-shadow: 0 0 0 8px rgba(231, 76, 60, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); }
          }
          .drishti-dot {
            position: absolute;
            width: 50px; height: 50px;
            transform: translate(-50%, -50%);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            box-sizing: border-box;
            user-select: none;
            transition: opacity 200ms ease;
          }
          .drishti-dot-ring {
            position: absolute;
            inset: 0;
            width: 100%; height: 100%;
            transform: rotate(-90deg);
          }
          .drishti-dot-ring .ring-track {
            stroke: rgba(255, 255, 255, 0.18);
            stroke-width: 3.5;
            fill: none;
          }
          .drishti-dot-ring .ring-fill {
            stroke: #e74c3c;
            stroke-width: 3.5;
            fill: none;
            stroke-dasharray: 125.66px;
            stroke-dashoffset: 125.66px;
            stroke-linecap: round;
            transition: stroke-dashoffset 60ms linear, stroke 200ms;
          }
          .drishti-dot-core {
            width: 16px; height: 16px; border-radius: 50%;
            background: #e74c3c; border: 2px solid #ffffff;
            transition: background 200ms, transform 150ms;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5);
          }
          .drishti-dot.active .drishti-dot-core {
            animation: drishti-core-pulse 1.2s infinite;
          }
          .drishti-dot.inactive {
            opacity: 0.25;
            cursor: default;
          }
          .drishti-dot.inactive .drishti-dot-core {
            background: #7f8c8d;
            border-color: rgba(255,255,255,0.4);
          }
          .drishti-dot.completed {
            opacity: 0.85;
            cursor: default;
          }
          .drishti-dot.completed .drishti-dot-core {
            background: #2ecc71;
            border-color: #ffffff;
          }
          .drishti-dot.completed .ring-fill {
            stroke: #2ecc71 !important;
            stroke-dashoffset: 0px !important;
          }
          .drishti-calib-cursor {
            position: absolute;
            width: 26px; height: 26px;
            border-radius: 50%;
            background: rgba(56, 189, 248, 0.45);
            border: 2px solid #38bdf8;
            box-shadow: 0 0 16px rgba(56, 189, 248, 0.9);
            transform: translate(-50%, -50%);
            pointer-events: none;
            display: none;
            z-index: 2147483649;
            transition: left 40ms linear, top 40ms linear;
          }
        `;
        overlay.appendChild(style);

        const help = document.createElement("div");
        help.textContent =
          "Calibrate: look steadily at the active dot. Calibration advances automatically. (1/9)";
        help.style.cssText = [
          "position:absolute", "top:16px", "left:50%", "transform:translateX(-50%)",
          "color:#fff", "font:600 15px system-ui,sans-serif",
          "background:rgba(12,14,20,0.9)", "padding:8px 14px", "border-radius:10px",
          "text-align:center", "box-shadow: 0 4px 12px rgba(0,0,0,0.3)"
        ].join(";");
        overlay.appendChild(help);

        // Center-First Orthogonal Calibration Order (eliminates bias offset):
        // 1: Dead Center (neutral forward-looking baseline origin)
        // 2-5: Orthogonal cardinal axes (Top, Bottom, Left, Right)
        // 6-9: Corner quadrants (Top-Left, Top-Right, Bottom-Left, Bottom-Right)
        const points = [
          { cx: 0.50, ry: 0.50 }, // 1. Neutral Center
          { cx: 0.50, ry: 0.18 }, // 2. Top-Center
          { cx: 0.50, ry: 0.82 }, // 3. Bottom-Center
          { cx: 0.18, ry: 0.50 }, // 4. Mid-Left
          { cx: 0.82, ry: 0.50 }, // 5. Mid-Right
          { cx: 0.18, ry: 0.18 }, // 6. Top-Left
          { cx: 0.82, ry: 0.18 }, // 7. Top-Right
          { cx: 0.18, ry: 0.82 }, // 8. Bottom-Left
          { cx: 0.82, ry: 0.82 }, // 9. Bottom-Right
        ];

        let activePointIndex = 0;
        const dots = [];

        points.forEach(({ cx, ry }) => {
          const dot = document.createElement("div");
          dot.className = "drishti-dot inactive";
          dot.style.left = `${cx * 100}%`;
          dot.style.top = `${ry * 100}%`;

          dot.innerHTML = `
            <svg class="drishti-dot-ring" viewBox="0 0 48 48" aria-hidden="true">
              <circle class="ring-track" cx="24" cy="24" r="20"></circle>
              <circle class="ring-fill" cx="24" cy="24" r="20"></circle>
            </svg>
            <div class="drishti-dot-core"></div>
          `;

          const ringFill = dot.querySelector(".ring-fill");
          overlay.appendChild(dot);
          dots.push({ dot, ringFill, cx, ry });
        });

        const calibCursor = document.createElement("div");
        calibCursor.className = "drishti-calib-cursor";
        overlay.appendChild(calibCursor);

        // Interactive Gaze Dwell Calibration runner:
        // Dot 1: Neutral Center Anchor (clean forward eye baseline)
        // Dots 2-9: Live Gaze Cursor with magnetic assist — dwell on dot to lock!
        const runCalibrationForPoint = (index) => {
          if (index >= points.length) {
            this._onCalibGaze = null;
            calibCursor.style.display = "none";
            help.textContent = "Calibration complete — initializing gaze control...";
            this._calibTimer = setTimeout(() => {
              this._post("calibEnd");
              this._isCalibrating = false;
              this.onCalibComplete();
              this._removeOverlay();
              this.toast("Gaze ready — look at a button to activate it", 4000);
              resolve(true);
            }, 700);
            return;
          }

          activePointIndex = index;
          dots.forEach((d, i) => {
            if (i === index) {
              d.dot.className = "drishti-dot active";
            } else if (i < index) {
              d.dot.className = "drishti-dot completed";
            } else {
              d.dot.className = "drishti-dot inactive";
            }
          });

          const dotObj = dots[index];
          const r = dotObj.dot.getBoundingClientRect();
          const dotX = r.left + r.width / 2;
          const dotY = r.top + r.height / 2;

          dotObj.ringFill.style.strokeDashoffset = "125.66px";
          dotObj.ringFill.style.stroke = "#38ef7d";

          if (this._calibTimer) clearTimeout(this._calibTimer);
          if (this._calibInterval) clearInterval(this._calibInterval);

          // Dot 1 (Index 0): Neutral Center Anchor phase
          if (index === 0) {
            help.textContent = `Look steadily at the Center Dot to lock neutral eye baseline (1/${points.length})`;
            let step = 0;
            const TOTAL_STEPS = 20; // 20 * 65ms = 1300ms of clean initial anchor fixation

            // 450ms settle period so user fixates comfortably on center
            this._calibTimer = setTimeout(() => {
              this._calibInterval = setInterval(() => {
                this._post("calibrate", { x: dotX, y: dotY });
                step++;

                const progress = Math.min(1, step / TOTAL_STEPS);
                const offset = (125.664 * (1 - progress)).toFixed(2);
                dotObj.ringFill.style.strokeDashoffset = `${offset}px`;
                dotObj.ringFill.style.stroke = "#2ecc71";
                help.textContent = `Locking Center Dot... ${Math.round(progress * 100)}% (1/${points.length})`;

                if (step >= TOTAL_STEPS) {
                  clearInterval(this._calibInterval);
                  this._calibInterval = null;

                  dotObj.dot.className = "drishti-dot completed";
                  dotObj.ringFill.style.strokeDashoffset = "0px";
                  help.textContent = `Center locked! Guide your eye cursor onto Dot 2...`;

                  this._calibTimer = setTimeout(() => {
                    runCalibrationForPoint(1);
                  }, 400);
                }
              }, 65);
            }, 450);
            return;
          }

          // Dots 2-9: Live Gaze Cursor Dwell Phase
          help.textContent = `Move your gaze to Dot ${index + 1} — dwell on it to lock (${index + 1}/${points.length})`;
          let dwellFrames = 0;
          const DWELL_TARGET = 15; // ~500ms of sustained dwell inside target radius
          let dotCompleted = false;
          const pointStartTime = Date.now();

          this._onCalibGaze = (gx, gy) => {
            if (dotCompleted) return;

            // Distance between gaze cursor and target dot
            const dist = Math.hypot(gx - dotX, gy - dotY);
            const CAPTURE_RADIUS = 160; // Magnetic capture zone

            // Magnetic snap towards dot center when cursor gets close to keep eye fixated on target
            let displayX = gx;
            let displayY = gy;
            if (dist <= CAPTURE_RADIUS) {
              const pull = 0.40;
              displayX = (1 - pull) * gx + pull * dotX;
              displayY = (1 - pull) * gy + pull * dotY;
            }

            calibCursor.style.display = "block";
            calibCursor.style.left = `${displayX}px`;
            calibCursor.style.top = `${displayY}px`;

            // Wait 300ms saccade latency before accumulating dwell samples
            if (Date.now() - pointStartTime < 300) return;

            if (dist <= CAPTURE_RADIUS) {
              dwellFrames++;
              // Record ground-truth calibration sample while dwelling on the dot
              this._post("calibrate", { x: dotX, y: dotY });

              const progress = Math.min(1, dwellFrames / DWELL_TARGET);
              const offset = (125.664 * (1 - progress)).toFixed(2);
              dotObj.ringFill.style.strokeDashoffset = `${offset}px`;
              dotObj.ringFill.style.stroke = "#2ecc71";
              help.textContent = `Gaze locked on dot! ${Math.round(progress * 100)}% (${index + 1}/${points.length})`;

              if (dwellFrames >= DWELL_TARGET) {
                dotCompleted = true;
                this._onCalibGaze = null;

                dotObj.dot.className = "drishti-dot completed";
                dotObj.ringFill.style.stroke = "#2ecc71";
                dotObj.ringFill.style.strokeDashoffset = "0px";
                help.textContent = `Dot ${index + 1} locked! Moving to next...`;

                this._calibTimer = setTimeout(() => {
                  runCalibrationForPoint(index + 1);
                }, 350);
              }
            } else {
              // Gaze cursor is away from the target dot: dwell ring drains gently
              if (dwellFrames > 0) {
                dwellFrames = Math.max(0, dwellFrames - 0.35);
                const progress = dwellFrames / DWELL_TARGET;
                const offset = (125.664 * (1 - progress)).toFixed(2);
                dotObj.ringFill.style.strokeDashoffset = `${offset}px`;
              }
              help.textContent = `Look at Dot ${index + 1} — guide your cursor onto it (${index + 1}/${points.length})`;

              // Anti-deadlock: auto-advance if uncalibrated corner is offset after 4.5s
              if (Date.now() - pointStartTime > 4500) {
                advanceImmediately();
              }
            }
          };
        };

        // Manual skip/advance override (Spacebar or click)
        const advanceImmediately = () => {
          if (activePointIndex >= points.length) return;
          this._onCalibGaze = null;
          if (this._calibInterval) {
            clearInterval(this._calibInterval);
            this._calibInterval = null;
          }
          if (this._calibTimer) {
            clearTimeout(this._calibTimer);
            this._calibTimer = null;
          }
          const cur = dots[activePointIndex];
          if (cur) {
            const r = cur.dot.getBoundingClientRect();
            for (let k = 0; k < 6; k++) {
              this._post("calibrate", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }
            cur.dot.className = "drishti-dot completed";
            cur.ringFill.style.stroke = "#2ecc71";
            cur.ringFill.style.strokeDashoffset = "0px";
          }
          runCalibrationForPoint(activePointIndex + 1);
        };

        dots.forEach((d, i) => {
          d.dot.addEventListener("click", () => {
            if (i === activePointIndex) advanceImmediately();
          });
        });

        const onKeyDown = (e) => {
          if (e.code === "Space") {
            e.preventDefault();
            advanceImmediately();
          }
        };

        this._onKeyDown = onKeyDown;
        window.addEventListener("keydown", onKeyDown);

        (document.body || document.documentElement).appendChild(overlay);
        this._overlay = overlay;

        // Kick off fixation progression starting from dot 0
        this._calibTimer = setTimeout(() => {
          runCalibrationForPoint(0);
        }, 500);
      });
    }

    _removeOverlay() {
      this._isCalibrating = false;
      this._onCalibFixation = null;
      this._onCalibGaze = null;
      if (this._calibTimer) {
        clearTimeout(this._calibTimer);
        this._calibTimer = null;
      }
      if (this._calibInterval) {
        clearInterval(this._calibInterval);
        this._calibInterval = null;
      }
      if (this._overlay) {
        this._overlay.remove();
        this._overlay = null;
      }
      if (this._onKeyDown) {
        window.removeEventListener("keydown", this._onKeyDown);
        this._onKeyDown = null;
      }
    }
  }

  NS.GazeController = GazeController;
})();
