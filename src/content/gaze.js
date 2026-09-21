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
     * @param {(x:number,y:number)=>void} opts.onGaze  viewport gaze coords
     * @param {(msg:string, ms?:number)=>void} opts.toast  user-facing status
     */
    constructor({ onGaze, onGesture, onCalibComplete, toast }) {
      this.onGaze = onGaze || (() => {});
      this.onGesture = onGesture || (() => {});
      this.onCalibComplete = onCalibComplete || (() => {});
      this.toast = toast || (() => {});
      this.running = false;
      this.iframe = null;
      this._frameReady = null; // Promise resolved when frame posts {evt:'loaded'}
      this._extOrigin = new URL(ext.runtime.getURL("")).origin;
      this._overlay = null;
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
            this.onGaze(d.x, d.y);
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

    /** Turn gaze ON: load frame, start camera+model, then calibrate. */
    async enable() {
      if (this.running) return true;
      this.toast("Starting camera for gaze…", 3000);

      try {
        await this._ensureFrame();
      } catch (err) {
        console.error("[Drishti] gaze frame load failed:", err);
        this.toast("Gaze engine could not load — mouse still works", 6000);
        return false;
      }

      // Kick off WebGazer in the frame and wait for ready/error. Preview on so the
      // user can see a small camera pip while aligning their face for calibration.
      const outcome = await new Promise((resolve) => {
        this._startWaiters = { resolve };
        this._post("start", { opts: { preview: true } });
        // Safety net: model download / permission dialog can be slow.
        setTimeout(() => {
          if (this._startWaiters) {
            this._startWaiters.resolve(new Error("timed out starting camera"));
            this._startWaiters = null;
          }
        }, 30000);
      });

      if (outcome instanceof Error) {
        console.error("[Drishti] WebGazer failed to start:", outcome.camName || "", outcome.message);
        const name = outcome.camName || "";
        let m;
        if (name === "NotAllowedError" || /denied|NotAllowed/i.test(outcome.message)) {
          m = "Camera blocked. Check Windows camera privacy + Edge site camera setting — mouse still works";
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          m = "No camera found. Connect a webcam (or DroidCam) — mouse still works";
        } else if (name === "NotReadableError") {
          m = "Camera is in use by another app. Close it and retry — mouse still works";
        } else {
          m = "Camera/gaze unavailable — mouse still works";
        }
        this.toast(m, 7000);
        return false;
      }

      this.running = true;
      await this.calibrate();
      // Calibration done — hide the video pip for privacy during normal use.
      this._post("preview", { on: false });
      return true;
    }

    /** Turn gaze OFF and release the camera. */
    async disable() {
      if (!this.running) return;
      this._post("stop");
      this.running = false;
      this._removeOverlay();
      this.toast("Gaze off — mouse control active");
    }

    async toggle() {
      return this.running ? (await this.disable(), false) : await this.enable();
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

        const cols = [0.1, 0.5, 0.9];
        const rows = [0.12, 0.5, 0.88];
        const points = [];
        for (const ry of rows) for (const cx of cols) points.push({ cx, ry });

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

        // Automatic calibration runner: settles on the dot, collects samples, and advances
        const runCalibrationForPoint = (index) => {
          if (index >= points.length) {
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

          help.textContent = `Calibrate: keep head still & look directly at the dot center (${index + 1}/${points.length})`;

          const dotObj = dots[index];
          const r = dotObj.dot.getBoundingClientRect();
          const dotX = r.left + r.width / 2;
          const dotY = r.top + r.height / 2;

          // 1. Settle phase (650ms): ensures user's saccade completes and eyes stabilize before recording
          this._calibTimer = setTimeout(() => {
            let samples = 0;
            const totalSamples = 15; // 15 samples * 50ms = 750ms of clean steady fixation data

            this._calibInterval = setInterval(() => {
              this._post("calibrate", { x: dotX, y: dotY });
              samples++;

              const progress = samples / totalSamples;
              const offset = (125.664 * (1 - progress)).toFixed(2);
              dotObj.ringFill.style.strokeDashoffset = `${offset}px`;

              if (samples >= totalSamples) {
                clearInterval(this._calibInterval);
                this._calibInterval = null;

                // Completed state for this dot
                dotObj.dot.className = "drishti-dot completed";
                dotObj.ringFill.style.stroke = "#2ecc71";

                // Brief pause before moving to the next dot
                this._calibTimer = setTimeout(() => {
                  runCalibrationForPoint(index + 1);
                }, 200);
              }
            }, 50);
          }, 650);
        };

        // Manual skip/advance override (Spacebar or click)
        const advanceImmediately = () => {
          if (activePointIndex >= points.length) return;
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

        // Kick off automatic progression starting from dot 0
        this._calibTimer = setTimeout(() => {
          runCalibrationForPoint(0);
        }, 500);
      });
    }

    _removeOverlay() {
      this._isCalibrating = false;
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
