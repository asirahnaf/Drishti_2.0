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
    constructor({ onGaze, toast }) {
      this.onGaze = onGaze || (() => {});
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
          if (this.running) {
            if (Math.random() < 0.05) { // throttle logs
              console.warn(`[Drishti/gaze] Received gaze: x=${d.x.toFixed(1)}, y=${d.y.toFixed(1)}`);
            }
            this.onGaze(d.x, d.y);
          }
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

        const overlay = document.createElement("div");
        overlay.id = "drishti-calibration";
        overlay.style.cssText = [
          "position:fixed", "inset:0", "z-index:2147483646",
          "background:rgba(8,10,16,0.72)", "backdrop-filter:blur(2px)",
        ].join(";");

        // Inject styles for active, inactive, and completed states + pulse animation.
        const style = document.createElement("style");
        style.textContent = `
          @keyframes drishti-pulse {
            0% { transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); }
            70% { transform: translate(-50%, -50%) scale(1.25); box-shadow: 0 0 0 10px rgba(231, 76, 60, 0); }
            100% { transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); }
          }
          .drishti-dot {
            position: absolute;
            width: 34px; height: 34px; border-radius: 50%;
            border: 3px solid #fff; cursor: pointer;
            transition: opacity 150ms, background-color 150ms, transform 150ms;
            box-sizing: border-box;
          }
          .drishti-dot.active {
            background-color: #e74c3c;
            opacity: 1;
            animation: drishti-pulse 1.4s infinite;
            z-index: 10;
          }
          .drishti-dot.inactive {
            background-color: rgba(127, 140, 141, 0.4);
            border-color: rgba(255, 255, 255, 0.3);
            opacity: 0.25;
            cursor: not-allowed;
            pointer-events: none;
            transform: translate(-50%, -50%) scale(0.95);
          }
          .drishti-dot.completed {
            background-color: #2ecc71;
            border-color: #fff;
            opacity: 0.8;
            cursor: not-allowed;
            pointer-events: none;
            transform: translate(-50%, -50%) scale(0.9);
          }
        `;
        overlay.appendChild(style);

        const help = document.createElement("div");
        help.textContent =
          "Calibrate: look at the active pulsing dot and click it (or press Spacebar) 3 times. Remaining: 9";
        help.style.cssText = [
          "position:absolute", "top:16px", "left:50%", "transform:translateX(-50%)",
          "color:#fff", "font:600 15px system-ui,sans-serif",
          "background:rgba(12,14,20,0.9)", "padding:8px 14px", "border-radius:10px",
          "text-align:center", "box-shadow: 0 4px 12px rgba(0,0,0,0.3)"
        ].join(";");
        overlay.appendChild(help);

        const cols = [0.1, 0.5, 0.95];
        const rows = [0.12, 0.5, 0.88];
        const points = [];
        for (const ry of rows) for (const cx of cols) points.push({ cx, ry });

        let activePointIndex = 0;
        const dots = [];

        const updateActiveDot = () => {
          dots.forEach((dot, i) => {
            dot.className = "drishti-dot";
            if (i === activePointIndex) {
              dot.classList.add("active");
              dot.disabled = false;
            } else if (i < activePointIndex) {
              dot.classList.add("completed");
              dot.disabled = true;
            } else {
              dot.classList.add("inactive");
              dot.disabled = true;
            }
          });
        };

        points.forEach(({ cx, ry }, index) => {
          const dot = document.createElement("button");
          dot.style.left = `${cx * 100}%`;
          dot.style.top = `${ry * 100}%`;
          dot.style.transform = "translate(-50%,-50%)";
          
          let clicks = 0;
          let isSampling = false;
          dot.addEventListener("click", () => {
            if (index !== activePointIndex || isSampling) return;
            isSampling = true;
            clicks++;
            
            // Visual feedback: shrink the dot to show progress
            dot.style.transform = `translate(-50%,-50%) scale(${1 - clicks * 0.15})`;
            dot.style.opacity = String(0.7 + clicks * 0.08);
            
            const r = dot.getBoundingClientRect();
            const dotX = r.left + r.width / 2;
            const dotY = r.top + r.height / 2;

            // Temporal Calibration Sampling:
            // Send 10 coordinates spaced 50ms apart while the user looks at the dot.
            // This provides 10 distinct eye feature samples to the regression solver.
            let samples = 0;
            const interval = setInterval(() => {
              this._post("calibrate", { x: dotX, y: dotY });
              samples++;
              
              if (samples >= 10) {
                clearInterval(interval);
                isSampling = false;
                
                if (clicks >= 3) {
                  activePointIndex++;
                  help.textContent =
                    activePointIndex < points.length
                      ? `Calibrate: look at the active pulsing dot and click it (or press Spacebar) 3 times. Remaining: ${points.length - activePointIndex}`
                      : "Calibration complete — you can look to control now.";
                  
                  updateActiveDot();
                  
                  if (activePointIndex === points.length) {
                    setTimeout(() => {
                      this._removeOverlay();
                      this.toast("Gaze ready — look at a button to activate it", 4000);
                      resolve(true);
                    }, 700);
                  }
                }
              }
            }, 50);
          });
          overlay.appendChild(dot);
          dots.push(dot);
        });

        const onKeyDown = (e) => {
          if (e.code === "Space") {
            e.preventDefault();
            const activeDot = dots[activePointIndex];
            if (activeDot) {
              activeDot.click();
            }
          }
        };

        this._onKeyDown = onKeyDown;
        window.addEventListener("keydown", onKeyDown);

        updateActiveDot();
        (document.body || document.documentElement).appendChild(overlay);
        this._overlay = overlay;
      });
    }

    _removeOverlay() {
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
