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
      // 720p HD resolution gives 4x pixel density over pupils/irises for sharp sub-pixel tracking
      wg.params.camConstraints = {
        video: {
          width: { min: 640, ideal: 1280, max: 1920 },
          height: { min: 480, ideal: 720, max: 1080 },
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
      wg.params.refineLandmarks = true;

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
        if (!running) return;

        // Head Motion Mode: 3D head pitch & yaw derived from rigid facial landmarks
        if (trackingMode === "head") {
          const head = computeHeadPoseCoords();
          if (head) {
            post({ evt: "gaze", x: head.x, y: head.y, mode: "head" });
            return;
          }
        }

        // When calibrating: stream live gaze coordinates for calibration cursor
        if (isCalibrating) {
          if (data && Number.isFinite(data.x) && Number.isFinite(data.y)) {
            const clampedX = Math.max(0, Math.min(window.innerWidth, data.x));
            const clampedY = Math.max(0, Math.min(window.innerHeight, data.y));
            post({ evt: "calibGaze", x: clampedX, y: clampedY });
          }
          return;
        }

        if (!data) return;
        // WebGazer returns viewport-space pixels (this frame == full viewport).
        const x = data.x;
        const y = data.y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const clampedX = Math.max(-100, Math.min(window.innerWidth + 100, x));
          const clampedY = Math.max(-100, Math.min(window.innerHeight + 100, y));
          post({ evt: "gaze", x: clampedX, y: clampedY, mode: "gaze" });
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

  let isCalibrating = false;
  let prevHead = null;
  let prevIris = null;

  function evaluateCalibrationFixation() {
    if (!wg || !running) return;
    const tracker = wg.getTracker();
    if (!tracker) return;
    const positions = tracker.getPositions();

    if (!positions || positions.length < 468) {
      post({ evt: "calibFixation", stable: false, reason: "No face detected" });
      prevHead = null;
      prevIris = null;
      return;
    }

    // 1. Blink / Eye Openness detection via EAR (Eye Aspect Ratio)
    // Left eye: upper lid 159, lower lid 145, outer 33, inner 133
    const p159 = positions[159], p145 = positions[145], p33 = positions[33], p133 = positions[133];
    const leftH = Math.hypot(p159[0] - p145[0], p159[1] - p145[1]);
    const leftW = Math.hypot(p33[0] - p133[0], p33[1] - p133[1]) || 1;
    const earLeft = leftH / leftW;

    // Right eye: upper lid 386, lower lid 374, outer 263, inner 362
    const p386 = positions[386], p374 = positions[374], p263 = positions[263], p362 = positions[362];
    const rightH = Math.hypot(p386[0] - p374[0], p386[1] - p374[1]);
    const rightW = Math.hypot(p263[0] - p362[0], p263[1] - p362[1]) || 1;
    const earRight = rightH / rightW;

    const ear = (earLeft + earRight) / 2;
    if (ear < 0.125) {
      post({ evt: "calibFixation", stable: false, reason: "Blinking" });
      return;
    }

    // 2. Head Movement detection (Nose bridge landmark 168 or nose tip landmark 1)
    const head = positions[168] || positions[1];
    let headDelta = 0;
    if (prevHead) {
      headDelta = Math.hypot(head[0] - prevHead[0], head[1] - prevHead[1]);
    }
    prevHead = [head[0], head[1]];

    if (headDelta > 4.5) {
      post({ evt: "calibFixation", stable: false, reason: "Head moving" });
      return;
    }

    // 3. Iris / Eye Fixation Stability
    let irisDelta = 0;
    if (positions.length > 468) {
      // MediaPipe attention mesh with iris landmarks:
      // Left iris center: 468, Right iris center: 473
      const p468 = positions[468], p473 = positions[473];
      const normIrisLX = (p468[0] - p33[0]) / leftW;
      const normIrisLY = (p468[1] - p159[1]) / (leftH || 1);
      const normIrisRX = (p473[0] - p362[0]) / rightW;
      const normIrisRY = (p473[1] - p386[1]) / (rightH || 1);
      const curIris = [(normIrisLX + normIrisRX) / 2, (normIrisLY + normIrisRY) / 2];

      if (prevIris) {
        irisDelta = Math.hypot(curIris[0] - prevIris[0], curIris[1] - prevIris[1]);
      }
      prevIris = curIris;

      if (irisDelta > 0.045) {
        post({ evt: "calibFixation", stable: false, reason: "Eyes moving" });
        return;
      }
    } else {
      // 468-point mesh fallback: eye centers relative to nose bridge
      const eyeMidX = (p33[0] + p133[0] + p263[0] + p362[0]) / 4;
      const eyeMidY = (p159[1] + p145[1] + p386[1] + p374[1]) / 4;
      const relX = eyeMidX - head[0];
      const relY = eyeMidY - head[1];

      if (prevIris) {
        irisDelta = Math.hypot(relX - prevIris[0], relY - prevIris[1]);
      }
      prevIris = [relX, relY];

      if (irisDelta > 2.5) {
        post({ evt: "calibFixation", stable: false, reason: "Eyes moving" });
        return;
      }
    }

    post({ evt: "calibFixation", stable: true, reason: "Eyes steady" });
  }

  async function onCalibStart() {
    console.info("[Drishti/frame] Calibration started: stopping gesture loop & clearing old regression data");
    isCalibrating = true;
    prevHead = null;
    prevIris = null;
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
    isCalibrating = false;
    prevHead = null;
    prevIris = null;
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

  // --- Head Pose Kinematics (Pitch & Yaw via 3D FaceMesh Landmarks) ---
  let trackingMode = "gaze"; // "gaze" or "head"
  let neutralYaw = null;
  let neutralPitch = null;
  let lastRawHeadYaw = 0;
  let lastRawHeadPitch = 0;

  function computeHeadPoseCoords() {
    if (!wg || !running) return null;
    const tracker = wg.getTracker();
    if (!tracker) return null;
    const positions = tracker.getPositions();
    if (!positions || positions.length < 468) return null;

    // Landmark 1: Nose tip
    // Landmark 168: Nose bridge (midpoint between eyes)
    // Landmark 33: Outer left eye corner
    // Landmark 263: Outer right eye corner
    // Landmark 152: Chin bottom
    const p1 = positions[1];
    const p168 = positions[168];
    const p33 = positions[33];
    const p263 = positions[263];
    const p152 = positions[152];

    if (!p1 || !p168 || !p33 || !p263 || !p152) return null;

    // 1. Horizontal Head Yaw: Scale-invariant offset of nose tip relative to eye midpoint
    const midEyeX = (p33[0] + p263[0]) / 2;
    const faceW = Math.hypot(p263[0] - p33[0], p263[1] - p33[1]) || 1;
    const rawYaw = (p1[0] - midEyeX) / faceW;

    // 2. Vertical Head Pitch: Scale-invariant distance from nose bridge to nose tip
    const faceH = Math.hypot(p152[0] - p168[0], p152[1] - p168[1]) || 1;
    const rawPitch = (p1[1] - p168[1]) / faceH;

    lastRawHeadYaw = rawYaw;
    lastRawHeadPitch = rawPitch;

    // Auto-anchor neutral reference on initial face capture
    if (neutralYaw === null || neutralPitch === null) {
      neutralYaw = rawYaw;
      neutralPitch = rawPitch;
    }

    const deltaYaw = rawYaw - neutralYaw;
    const deltaPitch = rawPitch - neutralPitch;

    // Sensitivity gains: ±12° head turn and ±10° nod covers the full viewport
    const GAIN_YAW = 4.2;
    const GAIN_PITCH = 4.8;

    const targetX = (window.innerWidth / 2) + (deltaYaw * window.innerWidth * GAIN_YAW);
    const targetY = (window.innerHeight / 2) + (deltaPitch * window.innerHeight * GAIN_PITCH);

    return {
      x: Math.max(-50, Math.min(window.innerWidth + 50, targetX)),
      y: Math.max(-50, Math.min(window.innerHeight + 50, targetY)),
    };
  }

  function recenterHeadPose() {
    if (Number.isFinite(lastRawHeadYaw) && Number.isFinite(lastRawHeadPitch) && lastRawHeadPitch !== 0) {
      neutralYaw = lastRawHeadYaw;
      neutralPitch = lastRawHeadPitch;
      console.info(`[Drishti/frame] Head pose re-centered to neutral: yaw=${neutralYaw.toFixed(3)}, pitch=${neutralPitch.toFixed(3)}`);
      post({ evt: "toast", msg: "🎯 Head pose re-centered to neutral", ms: 2000 });
    } else {
      neutralYaw = null;
      neutralPitch = null;
    }
  }

  // --- Two-Stage Audio Processing: Decibel Gate + RNNoise Neural VAD ---
  let audioCtx = null;
  let audioStream = null;
  let audioSource = null;
  let scriptNode = null;
  let silentGain = null;
  let rnnModule = null;
  let rnnState = null;
  let rnnInPtr = null;
  let rnnOutPtr = null;
  let isAudioRunning = false;

  async function initRNNoise() {
    if (rnnModule) return rnnModule;
    if (typeof window.createRNNWasmModule !== "function") {
      console.warn("[Drishti/frame] createRNNWasmModule not found in frame");
      return null;
    }
    try {
      const wasmUrl = ext.runtime.getURL("src/vendor/rnnoise/rnnoise.wasm");
      const resp = await fetch(wasmUrl);
      if (!resp.ok) throw new Error(`RNNoise WASM fetch failed: ${resp.status}`);
      const wasmBinary = new Uint8Array(await resp.arrayBuffer());

      // Isolate global Module during initialization to prevent cross-library collisions
      const savedModule = window.Module;
      window.Module = undefined;
      if (typeof self !== "undefined") self.Module = undefined;

      try {
        rnnModule = await window.createRNNWasmModule({ wasmBinary });
      } finally {
        if (savedModule) window.Module = savedModule;
      }

      rnnInPtr = rnnModule._malloc(480 * 4);
      rnnOutPtr = rnnModule._malloc(480 * 4);
      rnnState = rnnModule._rnnoise_create(null);
      console.info("[Drishti/frame] RNNoise WASM initialized successfully!");
      return rnnModule;
    } catch (err) {
      console.error("[Drishti/frame] RNNoise initialization failed:", err);
      return null;
    }
  }

  async function startAudioProcessor() {
    if (isAudioRunning) {
      post({ evt: "audioReady" });
      return;
    }
    try {
      await initRNNoise();

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn("[Drishti/frame] Web Audio API not supported in this frame");
        return;
      }

      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioCtx = new AudioContextClass({ sampleRate: 48000 });
      audioSource = audioCtx.createMediaStreamSource(audioStream);

      // Buffer size 512 samples (~10.6ms at 48kHz), 1 input, 1 output
      scriptNode = audioCtx.createScriptProcessor(512, 1, 1);

      const sampleQueue = [];
      const tempFloat32 = new Float32Array(480);
      const DB_GATE_THRESHOLD = -44; // dB: normal speech is -30 to -15 dB; ambient room noise is < -50 dB
      const HANGOVER_MS = 350;       // ms: speech continuity hold time to bridge word pauses
      let lastGateOpenTime = 0;
      let lastPostTime = 0;
      let lastReportedSpeech = false;
      let smoothedVad = 0;

      scriptNode.onaudioprocess = (e) => {
        if (!isAudioRunning) return;
        const input = e.inputBuffer.getChannelData(0);

        // 1. Stage 1: Fast Decibel / RMS Energy Gate
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) {
          sumSq += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSq / input.length);
        const dB = rms > 1e-5 ? 20 * Math.log10(rms) : -100;

        const now = performance.now();
        if (dB >= DB_GATE_THRESHOLD) {
          lastGateOpenTime = now;
        }
        const gateOpen = (now - lastGateOpenTime) < HANGOVER_MS;

        // 2. Queue samples for RNNoise (480-sample blocks at 48kHz = 10ms frames)
        for (let i = 0; i < input.length; i++) {
          sampleQueue.push(input[i]);
        }

        let latestVad = smoothedVad;
        if (rnnModule && rnnState && gateOpen) {
          while (sampleQueue.length >= 480) {
            const frame = sampleQueue.splice(0, 480);
            for (let i = 0; i < 480; i++) {
              // Scale browser Float32 [-1.0, 1.0] to 16-bit PCM scale [-32768, 32767]
              tempFloat32[i] = frame[i] * 32767;
            }
            rnnModule.HEAPF32.set(tempFloat32, rnnInPtr / 4);
            const prob = rnnModule._rnnoise_process_frame(rnnState, rnnOutPtr, rnnInPtr);
            // Exponential moving average for smooth, chatter-free speech presence
            smoothedVad = (smoothedVad * 0.35) + (prob * 0.65);
            latestVad = smoothedVad;
          }
        } else {
          // Discard sample backlog when gate is closed to prevent latency buildup
          if (sampleQueue.length > 960) {
            sampleQueue.splice(0, sampleQueue.length - 480);
          }
          smoothedVad = smoothedVad * 0.6; // decay toward zero
          latestVad = smoothedVad;
        }

        // Stage 2: Neural VAD threshold (>= 0.65 confidence)
        const isSpeech = gateOpen && (latestVad >= 0.65);

        // State dispatch: immediate on transition, throttled to ~120ms during continuous speech/silence
        const stateChanged = (isSpeech !== lastReportedSpeech);
        if (stateChanged || (now - lastPostTime > 120)) {
          lastReportedSpeech = isSpeech;
          lastPostTime = now;
          post({
            evt: "audioState",
            gateOpen,
            isSpeech,
            vadProb: Math.round(latestVad * 100) / 100,
            dB: Math.round(dB),
          });
        }
      };

      audioSource.connect(scriptNode);

      // Connect scriptNode to destination via zero-gain node to keep the Web Audio clock active
      silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      scriptNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      isAudioRunning = true;
      console.info("[Drishti/frame] Audio processor active with RNNoise neural VAD + Decibel gate");
      post({ evt: "audioReady" });
    } catch (err) {
      console.error("[Drishti/frame] Audio processor start error:", err);
      post({ evt: "audioError", error: String(err?.message || err) });
    }
  }

  function stopAudioProcessor() {
    isAudioRunning = false;
    if (scriptNode) {
      try { scriptNode.disconnect(); } catch (_) {}
      scriptNode = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch (_) {}
      silentGain = null;
    }
    if (audioSource) {
      try { audioSource.disconnect(); } catch (_) {}
      audioSource = null;
    }
    if (audioStream) {
      try {
        audioStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      audioStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    if (rnnModule && rnnState) {
      try {
        rnnModule._rnnoise_destroy(rnnState);
        rnnState = rnnModule._rnnoise_create(null);
      } catch (_) {}
    }
    console.info("[Drishti/frame] Audio processor stopped");
    post({ evt: "audioStopped" });
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
      case "startAudio":    startAudioProcessor(); break;
      case "stopAudio":     stopAudioProcessor(); break;
      case "setTrackingMode":
        trackingMode = d.mode === "head" ? "head" : "gaze";
        neutralYaw = null;
        neutralPitch = null;
        console.info(`[Drishti/frame] Tracking mode switched to: ${trackingMode}`);
        break;
      case "recenter":
        recenterHeadPose();
        break;
      case "preview":       preview(d.on); break;
      case "stop":          stop(); break;
    }
  });

  // Tell the parent we're loaded and ready to receive "start".
  post({ evt: "loaded" });
})();
