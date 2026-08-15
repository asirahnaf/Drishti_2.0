// Drishti 2.0 — Gaze frame worker (runs at chrome-extension:// origin)
//
// Why this file exists (the Step 3 rebuild):
//   WebGazer downloads a MediaPipe FaceMesh model and injects helper <script>/WASM
//   into the DOM at runtime. Loaded as a content script it inherited the HOST page's
//   origin + CSP, so:
//     • its relative model path "./mediapipe/face_mesh" resolved against the page
//       (e.g. en.wikipedia.org/wiki/Mediapipe/... → 404), and
//     • the host page's CSP blocked the injected TF/MediaPipe scripts.
//   Running WebGazer *here*, inside an extension-origin iframe, fixes both: the
//   relative path resolves to chrome-extension://…/src/vendor/mediapipe/face_mesh
//   (bundled), and the CSP is our own (manifest content_security_policy.extension_pages).
//
// This frame is an invisible, click-through, full-viewport overlay the content
// script injects. Full-viewport matters: WebGazer clamps predictions to this
// window's innerWidth/innerHeight, so matching the page viewport keeps gaze coords
// in viewport space with no rescaling. Coords are posted to the parent (content
// script), which feeds the SAME dwell engine the mouse uses.

(() => {
  "use strict";

  const ext = typeof chrome !== "undefined" ? chrome : browser;
  const EXT_ORIGIN = new URL(ext.runtime.getURL("")).origin;
  const NS = "drishti-gaze";

  let wg = null;
  let running = false;

  function post(msg) {
    // Parent is the host web page; its origin varies, so target "*" and let the
    // content script validate by event.origin === our extension origin + ns tag.
    window.parent.postMessage({ ns: NS, ...msg }, "*");
  }

  function webgazer() {
    return typeof window.webgazer !== "undefined" ? window.webgazer : null;
  }

  async function start(opts = {}) {
    if (running) {
      post({ evt: "ready" });
      return;
    }
    wg = webgazer();
    if (!wg) {
      post({ evt: "error", message: "webgazer.js failed to load in the gaze frame" });
      return;
    }

    // Preflight the camera OURSELVES first, so we get the exact DOMException name
    // instead of WebGazer's vague "No stream" / "Permission denied". This is the
    // same getUserMedia WebGazer will use, just with precise error reporting.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      // Release the probe stream immediately; WebGazer opens its own.
      probe.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const name = (err && err.name) || "Error";
      const message = (err && err.message) || String(err);
      // NotAllowedError → OS/Edge block or denied; NotFoundError → no camera device;
      // NotReadableError → camera busy/held by another app.
      post({ evt: "error", name, message: `${name}: ${message}` });
      return;
    }

    try {
      // Point the FaceMesh solution at our BUNDLED assets (absolute extension URL).
      // WebGazer's locateFile does: solutionPath.replace(/\/+$/,'') + '/' + filename,
      // so this yields chrome-extension://<id>/src/vendor/mediapipe/face_mesh/<file>.
      wg.params.faceMeshSolutionPath = ext.runtime.getURL("src/vendor/mediapipe/face_mesh");
      // Persist regression data across sessions so calibration isn't lost on reload.
      wg.saveDataAcrossSessions(true);

      // We draw our own UI. Keep WebGazer's overlays off; optional tiny video pip
      // only if the parent asked for it (helps the user center their face).
      wg.showPredictionPoints(false);
      wg.showFaceOverlay(false);
      wg.showFaceFeedbackBox(false);
      wg.showVideoPreview(!!opts.preview);
      document.documentElement.classList.toggle("show", !!opts.preview);

      wg.setGazeListener((data) => {
        if (!data || !running) return;
        // WebGazer returns viewport-space pixels (this frame == full viewport).
        const x = data.x;
        const y = data.y;
        if (Number.isFinite(x) && Number.isFinite(y)) post({ evt: "gaze", x, y });
      });

      // Start WebGazer. On first run this loads the FaceMesh model, so it can take
      // a few seconds. begin() resolves once the video pipeline is up.
      console.info("[Drishti/frame] webgazer.begin() …");
      await wg.begin();

      // begin() can resolve before the tracker's model is actually ready to emit
      // predictions. Poll isReady() briefly so we don't declare "ready" too early.
      if (typeof wg.isReady === "function") {
        const t0 = Date.now();
        while (!wg.isReady() && Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      console.info("[Drishti/frame] webgazer ready:", typeof wg.isReady === "function" ? wg.isReady() : "n/a");

      running = true;
      post({ evt: "ready" });
    } catch (err) {
      running = false;
      const name = (err && err.name) || "";
      const message =
        (err && (err.message || err.name)) || "camera/model unavailable";
      // Log the FULL error to the frame console so we can see model/WASM failures.
      console.error("[Drishti/frame] webgazer.begin() failed:", err);
      // Common cases: NotAllowedError (permission denied), NotFoundError (no cam),
      // NotReadableError (cam busy), or a model/WASM load failure. Surface it.
      post({ evt: "error", name, message: String(message) });
      try { wg.end(); } catch (_) {}
    }
  }

  function calibrate(x, y) {
    if (!wg || !running) return;
    // Correlate current eye features with the on-page point the user is looking at.
    // The content script sends viewport-pixel coords of the dot it clicked.
    try { wg.recordScreenPosition(x, y, "click"); } catch (_) {}
  }

  function preview(on) {
    if (!wg) return;
    try {
      wg.showVideoPreview(!!on);
      document.documentElement.classList.toggle("show", !!on);
    } catch (_) {}
  }

  function stop() {
    if (!wg) return;
    try {
      wg.clearGazeListener();
      wg.pause();
      wg.end(); // releases the camera + removes WebGazer's video element
    } catch (_) {}
    running = false;
    document.documentElement.classList.remove("show");
    post({ evt: "stopped" });
  }

  // Commands from the content script (parent). Validate source + ns; the parent is
  // the web page so we can't pin its origin, but only our content script knows to
  // target this frame with the ns tag.
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.ns !== NS || !d.cmd) return;
    switch (d.cmd) {
      case "start":     start(d.opts || {}); break;
      case "calibrate": calibrate(d.x, d.y); break;
      case "preview":   preview(d.on); break;
      case "stop":      stop(); break;
    }
  });

  // Tell the parent we're loaded and ready to receive "start".
  post({ evt: "loaded" });
})();
