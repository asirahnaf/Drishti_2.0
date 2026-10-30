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

    try {
      localStorage.clear();
      if (typeof wg.clearData === "function") {
        wg.clearData();
      }
    } catch (e) {
      console.warn("[Drishti/frame] failed to clear stale webgazer data:", e);
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
      // Standard webcam resolution (640x480) gives rock-solid 30-60 fps with low latency
      wg.params.camConstraints = {
        video: {
          width: { min: 320, ideal: 640, max: 1280 },
          height: { min: 240, ideal: 480, max: 720 },
          facingMode: "user"
        }
      };

      // Point the FaceMesh solution at our BUNDLED assets (absolute extension URL).
      // WebGazer's locateFile does: solutionPath.replace(/\/+$/,'') + '/' + filename,
      // so this yields chrome-extension://<id>/src/vendor/mediapipe/face_mesh/<file>.
      wg.params.faceMeshSolutionPath = ext.runtime.getURL("src/vendor/mediapipe/face_mesh");
      // Do NOT persist regression data across sessions so each session starts with fresh calibration.
      wg.saveDataAcrossSessions(false);
      wg.params.dataWindowSize = 300;

      // Enable Kalman filter to stabilize eye pupil micro-jitter at the regression source
      try {
        if (typeof wg.applyKalmanFilter === "function") {
          wg.applyKalmanFilter(true);
        }
      } catch (e) {
        console.warn("[Drishti/frame] failed to enable Kalman filter:", e);
      }

      // Ensure iframe document never listens to mouse clicks or moves
      try {
        if (typeof wg.removeMouseEventListeners === "function") {
          wg.removeMouseEventListeners();
        }
      } catch (_) {}

      // We draw our own UI. Keep WebGazer's overlays off; video feed active
      // while visually hidden by the frame.html container styles (opacity 0 unless preview).
      wg.showPredictionPoints(false);
      wg.showFaceOverlay(false);
      wg.showFaceFeedbackBox(false);
      wg.showVideoPreview(true);
      document.documentElement.classList.toggle("show", !!opts.preview);

      wg.setGazeListener((data) => {
        if (!data || !running) return;
        // WebGazer returns viewport-space pixels (this frame == full viewport).
        const x = data.x;
        const y = data.y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const clampedX = Math.max(-100, Math.min(window.innerWidth + 100, x));
          const clampedY = Math.max(-100, Math.min(window.innerHeight + 100, y));
          post({ evt: "gaze", x: clampedX, y: clampedY });
        }
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

      // Pre-load gesture recognizer model in background so it's ready when calibration ends.
      // (Do NOT start gesture loop yet; it will be started upon calibration completion)
      initGestureRecognizer().then((gr) => {
        if (gr) {
          console.info("[Drishti/frame] Gesture recognizer pre-loaded and standing by.");
        }
      });
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

  let gestureRecognizer = null;
  let gestureInterval = null;

  async function initGestureRecognizer() {
    if (gestureRecognizer) return gestureRecognizer;
    if (typeof Vision === "undefined" || !Vision.FilesetResolver || !Vision.GestureRecognizer) {
      console.warn("[Drishti/frame] Vision library not loaded in frame");
      post({ evt: "toast", msg: "Vision library not loaded in frame", ms: 4000 });
      return null;
    }

    try {
      const wasmPath = ext.runtime.getURL("src/vendor/mediapipe/gesture_recognizer/wasm");
      const modelPath = ext.runtime.getURL("src/vendor/mediapipe/gesture_recognizer/gesture_recognizer.task");

      console.info("[Drishti/frame] Pre-fetching gesture model buffer...", modelPath);
      post({ evt: "toast", msg: "Loading Hand Gestures...", ms: 3000 });

      // Pre-fetch model bytes as Uint8Array buffer to avoid internal fetch issues
      const modelResp = await fetch(modelPath);
      if (!modelResp.ok) throw new Error(`Model fetch failed: ${modelResp.status}`);
      const modelBuffer = new Uint8Array(await modelResp.arrayBuffer());

      console.info("[Drishti/frame] Resolving WASM fileset...", wasmPath);
      const vision = await Vision.FilesetResolver.forVisionTasks(wasmPath);

      // Clear global Module to isolate Tasks Vision from WebGazer's FaceMesh Module
      const savedModule = window.Module;
      window.Module = undefined;
      if (typeof self !== "undefined") self.Module = undefined;

      try {
        gestureRecognizer = await Vision.GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetBuffer: modelBuffer,
          },
          runningMode: "VIDEO",
          numHands: 1,
        });
      } finally {
        if (savedModule) window.Module = savedModule;
      }

      console.info("[Drishti/frame] GestureRecognizer initialized successfully!");
      post({ evt: "toast", msg: "✋ Gestures Ready: Thumbs Up 👍 & Palm ✋", ms: 4000 });
      return gestureRecognizer;
    } catch (err) {
      console.error("[Drishti/frame] GestureRecognizer initialization failed:", err);
      post({ evt: "toast", msg: "Gesture setup error: " + (err?.message || err), ms: 6000 });
      return null;
    }
  }

  let gestureRunning = false;
  let lastGestureTime = 0;

  function startGestureLoop() {
    if (gestureInterval) clearInterval(gestureInterval);
    lastGestureTime = 0;

    // Run every 250ms (4 fps). Lightweight, responsive, and leaves full CPU for WebGazer.
    gestureInterval = setInterval(() => {
      if (!running || !gestureRecognizer || gestureRunning) return;

      const video = document.getElementById("webgazerVideoFeed");
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      gestureRunning = true;
      try {
        const nowMs = performance.now();
        const results = gestureRecognizer.recognizeForVideo(video, nowMs);

        if (results && results.gestures && results.gestures.length > 0) {
          const topGesture = results.gestures[0][0];
          const landmarks = results.landmarks && results.landmarks.length > 0 ? results.landmarks[0] : null;

          if (topGesture && topGesture.categoryName !== "None") {
            const name = topGesture.categoryName;
            const score = topGesture.score;

            // Hand Elevation Check:
            // Landmark 0 is the wrist. If wrist Y > 0.82, the hand is resting at the bottom
            // of the camera frame (e.g. typing on the laptop keyboard or resting on desk).
            // Requiring wrist Y <= 0.82 ensures the user has intentionally raised their hand.
            const wristY = landmarks && landmarks[0] ? landmarks[0].y : 0.5;
            const isHandRaised = wristY <= 0.82;

            if (isHandRaised && score >= 0.50) {
              if (name === "Thumb_Up" || name === "Open_Palm") {
                const now = Date.now();
                // 2.5 second cooldown between successful activations
                if (now - lastGestureTime > 2500) {
                  lastGestureTime = now;
                  console.info(`[Drishti/frame] Gesture fired: ${name} (${(score * 100).toFixed(0)}%, wristY: ${wristY.toFixed(2)})`);
                  post({ evt: "gesture", gesture: name, score });
                }
              }
            }
          }
        }
      } catch (err) {
        // Ignore single frame slips
      } finally {
        gestureRunning = false;
      }
    }, 250);
  }

  function stopGestureLoop() {
    if (gestureInterval) {
      clearInterval(gestureInterval);
      gestureInterval = null;
    }
    gestureRunning = false;
  }

  async function onCalibStart() {
    console.info("[Drishti/frame] Calibration started: stopping gesture loop & clearing old regression data");
    stopGestureLoop();
    if (wg && typeof wg.clearData === "function") {
      try {
        await wg.clearData();
      } catch (err) {
        console.warn("[Drishti/frame] Error clearing regression data:", err);
      }
    }
  }

  function onCalibEnd() {
    console.info("[Drishti/frame] Calibration ended: starting gesture loop");
    if (gestureRecognizer && running) {
      startGestureLoop();
    }
  }

  function calibrate(x, y) {
    if (!wg || !running) return;
    // Correlate current eye features with the on-page point the user is looking at.
    // The content script sends viewport-pixel coords of the active calibration dot.
    try {
      wg.recordScreenPosition(x, y, "click");
      const reg = wg.getRegression()?.[0];
      const count = reg?.getData()?.length || 0;
      post({ evt: "calibSample", count });
    } catch (_) {}
  }

  function preview(on) {
    if (!wg) return;
    try {
      wg.showVideoPreview(!!on);
      document.documentElement.classList.toggle("show", !!on);
    } catch (_) {}
  }

  function stop() {
    stopGestureLoop();
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
      case "start":         start(d.opts || {}); break;
      case "calibStart":    onCalibStart(); break;
      case "calibrate":     calibrate(d.x, d.y); break;
      case "calibEnd":      onCalibEnd(); break;
      case "startGestures": startGestureLoop(); break;
      case "stopGestures":  stopGestureLoop(); break;
      case "preview":       preview(d.on); break;
      case "stop":          stop(); break;
    }
  });

  // Tell the parent we're loaded and ready to receive "start".
  post({ evt: "loaded" });
})();
