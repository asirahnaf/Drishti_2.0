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
          if (this.running) this.onGaze(d.x, d.y);
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
    calibrate() {
      return new Promise((resolve) => {
        this._removeOverlay();

        const overlay = document.createElement("div");
        overlay.id = "drishti-calibration";
        overlay.style.cssText = [
          "position:fixed", "inset:0", "z-index:2147483646",
          "background:rgba(8,10,16,0.72)", "backdrop-filter:blur(2px)",
        ].join(";");

        const help = document.createElement("div");
        help.textContent =
          "Calibrate: look at each dot and click it (5 clicks each). Remaining: 9";
        help.style.cssText = [
          "position:absolute", "top:16px", "left:50%", "transform:translateX(-50%)",
          "color:#fff", "font:600 15px system-ui,sans-serif",
          "background:rgba(12,14,20,0.9)", "padding:8px 14px", "border-radius:10px",
        ].join(";");
        overlay.appendChild(help);

        const cols = [0.1, 0.5, 0.9];
        const rows = [0.12, 0.5, 0.88];
        const points = [];
        for (const ry of rows) for (const cx of cols) points.push({ cx, ry });

        let remaining = points.length;
        points.forEach(({ cx, ry }) => {
          const dot = document.createElement("button");
          let clicks = 0;
          dot.style.cssText = [
            "position:absolute",
            `left:${cx * 100}%`, `top:${ry * 100}%`, "transform:translate(-50%,-50%)",
            "width:34px", "height:34px", "border-radius:50%",
            "border:3px solid #fff", "background:#e74c3c", "cursor:pointer",
            "opacity:0.45", "transition:opacity 120ms,background 120ms",
          ].join(";");
          dot.addEventListener("click", () => {
            clicks++;
            dot.style.opacity = String(0.45 + clicks * 0.11);
            // Forward the point the user is looking at (dot center in viewport px).
            const r = dot.getBoundingClientRect();
            this._post("calibrate", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
            if (clicks >= 5) {
              dot.style.background = "#2ecc71";
              dot.disabled = true;
              remaining--;
              help.textContent =
                remaining > 0
                  ? `Calibrate: look at each dot and click it. Remaining: ${remaining}`
                  : "Calibration complete — you can look to control now.";
              if (remaining === 0) {
                setTimeout(() => {
                  this._removeOverlay();
                  this.toast("Gaze ready — look at a button to activate it", 4000);
                  resolve(true);
                }, 700);
              }
            }
          });
          overlay.appendChild(dot);
        });

        (document.body || document.documentElement).appendChild(overlay);
        this._overlay = overlay;
      });
    }

    _removeOverlay() {
      if (this._overlay) {
        this._overlay.remove();
        this._overlay = null;
      }
    }
  }

  NS.GazeController = GazeController;
})();
