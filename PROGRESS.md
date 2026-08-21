# Drishti 2.0 — Progress & Resume Notes

**Last worked:** 2026-08-21
**Resume at:** Step 3 (Gaze & Calibration) and Step 4 (DOM Actions) are fully **verified and operational**. Gaze tracking has been stabilized with 720p HD constraints, 10x temporal calibration sampling (3 clicks/dot), magnetic snapped visual cursors, and dwell hysteresis drainage. Next: Step 5 (audio/voice layer with SpeechSynthesis and SpeechRecognition supporting Bengali).

This tracks the §9 build order from `Drishti_2.0_Plan.md`. Open that plan for the
"why"; open this file for the "where we are".

---

## Locked decisions

- **Stack:** Vanilla JS, Manifest V3, **no build step** (load unpacked directly).
- **Browsers:** Chrome **+ Edge** both supported (same folder/code — see
  `src/content/platform.js` for the normalized `chrome`/`browser` handle).
- **MVP target sites:** YouTube (Tier 1) + **Mastodon** (Tier 2).
- **Dwell defaults:** 750 ms dwell, 400 ms cooldown (seeded in the service worker).
- **Gaze engine:** WebGazer 1.7.3 (vendored) + MediaPipe FaceMesh (bundled locally),
  runs in an **extension-origin iframe**, NOT in the page/content-script context.

---

## Build-order status (§9)

| Step | Item | Status |
|------|------|--------|
| 1 | Extension skeleton (MV3, service worker, content script) | ✅ Done |
| 2 | Shadow-DOM sidebar + dwell state machine (mouse-driven) | ✅ Done |
| 3 | **WebGazer integration + calibration** | ✅ Done (720p, temporal sampling, snapping) |
| 4 | DOM-independent actions (scroll, copy-link, read-aloud) | ✅ Done |
| 5 | Audio layer (SpeechRecognition voice input + Bengali) | ⬜ To do |
| 6 | Tier 1 + Tier 2 APIs (YouTube + Mastodon, OAuth) | ⬜ To do |
| 7 | Site adapters + graceful degradation + earcons + a11y fallback | ⬜ To do |
| 8 | Live Share (WebRTC): view-only → guided → assist | ⬜ To do |
| 9 | Python helper + first Tier 3 scrape adapter | ⬜ To do |
| 10 | Firefox port (Web Speech / getDisplayMedia / MV3 parity) | ⬜ To do |

---

## What works right now (verified by user)

Sidebar renders in Edge with all 8 buttons: **Up, Like, Comment, Share, Audio,
Reply, React, Down**. Dwell ring fills on all; green flash on fire.

- **Up / Down** — scroll the page.
- **Share** — copies page link to clipboard (toast confirms).
- **Audio** — reads the page aloud (SpeechSynthesis); dwell again to stop.
- **Like / Comment / Reply / React** — fire but only toast ("needs the site login —
  coming in a later step"); real actions land in Step 6.

Input is currently the **mouse**. Gaze (Step 3) is a drop-in swap — it feeds the
SAME `dwell.update(x, y)`.

---

## STEP 3 — what we built this session (the gaze rebuild)

The first gaze attempt loaded WebGazer as a content script; it failed because it
inherited the **host page's** origin + CSP. We rebuilt it to run in an
**extension-origin iframe** instead. Architecture now:

```
content.js ──(new GazeController)──> gaze.js
   gaze.js injects an invisible, click-through, FULL-VIEWPORT iframe:
      chrome-extension://<id>/src/gaze/frame.html
   frame.html loads:  preload.js → vendor/webgazer.js → frame.js
   frame.js runs WebGazer, gets gaze (x,y), postMessage → gaze.js → dwell.update(x,y)
   gaze.js also draws the on-page 9-dot calibration overlay; each click forwards the
      dot's viewport coords to the frame via recordScreenPosition().
```

Full viewport matters: WebGazer clamps predictions to its window's inner size, so a
full-viewport frame keeps gaze coords in viewport space (no rescaling).

### Bugs found & fixed this session (each was a separate layer):

1. **404 on face_mesh.binarypb + host-page CSP blocked injected scripts** →
   FIXED by moving WebGazer into the extension-origin iframe AND bundling the
   MediaPipe FaceMesh assets locally (7 files in `src/vendor/mediapipe/face_mesh/`).
   WebGazer's `faceMeshSolutionPath` is set to the bundled path via `getURL(...)`.
2. **WebGazer false alert "works only over https"** → its legacy guard doesn't
   recognize `chrome-extension:` as a secure context. FIXED by `src/gaze/preload.js`,
   which suppresses ONLY that specific alert (loads before webgazer.js).
3. **"Permission denied" / no camera prompt** → NOT the code. **Edge's global camera
   setting was set to Block** (`edge://settings/content/camera`). User switched it to
   "Ask before accessing" → camera now opens (white light comes on). Windows privacy,
   drivers ("HD Webcam" OK), and desktop-app consent were all already fine.
   (See memory note `edge-camera-blocked-globally`.)

### ✅ RESOLVED (2026-08-15) — was: THE LAST BLOCKER

**Fix applied (NOT the sandbox route):** the only real JS-eval site was MediaPipe's
emscripten `createNamedFunction`, which used `new Function(...)` purely to name a function
for stack traces. Patched both glue files (`face_mesh_solution_simd_wasm_bin.js` +
`face_mesh_solution_wasm_bin.js`) to emscripten's eval-free variant:
`return {[name]:function(){return body.apply(this,arguments)}}[name]`. No `unsafe-eval`
needed, so the manifest CSP is unchanged and the frame stays a normal extension-origin
page — **camera + `chrome.*` keep working** (sandboxing would have broken the camera via
an opaque origin). The other apparent eval sites are safe: `new WebAssembly.Function` is
covered by `wasm-unsafe-eval`, and WebGazer's lone `new Function("return this")` is dead
code on Chrome/Edge 116+ (guarded by a `globalThis` check + wrapped in try/catch).

Verify: reload the card → open frame DevTools (edge://extensions → Drishti → Inspect
views: frame.html) → enable gaze → the `EvalError … createNamedFunction` should be gone
and the 9-dot calibration should appear. If a *different* error shows, capture it.

Original error + the abandoned sandbox plan are kept below for history.

---

### (history) THE LAST BLOCKER (the sandbox plan we did NOT need):

Console error from the **frame's** DevTools (edge://extensions → Drishti → Inspect
views → frame.html):

```
EvalError: Evaluating a string as JavaScript violates the following CSP directive
because 'unsafe-eval' is not an allowed source of script: script-src 'self'
'wasm-unsafe-eval'
   at new Function (<anonymous>)
   at createNamedFunction (face_mesh_solution_simd_wasm_bin.js)
```

Meaning: MediaPipe's WASM glue uses `new Function(...)`, which needs `'unsafe-eval'`.
Our current CSP only grants `'wasm-unsafe-eval'`. **MV3 forbids `'unsafe-eval'` in
`content_security_policy.extension_pages`** (adding it there = the yellow-icon
manifest error). Camera works; model init dies at this eval → brief video flash,
then "camera/gaze unavailable".

**THE FIX (planned, not yet applied): make the gaze frame a SANDBOXED page.**
Sandboxed extension pages get a separate CSP where `'unsafe-eval'` IS allowed.
Steps:
1. In `manifest.json`, add:
   ```json
   "sandbox": {
     "pages": ["src/gaze/frame.html"]
   },
   "content_security_policy": {
     "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
     "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; object-src 'self'"
   }
   ```
   (Keep `frame.html` in `web_accessible_resources` too — it must be loadable as an
   iframe src.)
2. **Sandbox caveat:** a sandboxed page has a `null`/opaque origin and CANNOT call
   privileged `chrome.*` APIs. The frame currently uses `chrome.runtime.getURL(...)`
   in TWO places (frame.js lines ~24 and ~71) to build the extension origin and the
   `faceMeshSolutionPath`. In a sandbox these will fail. Fix options:
   - Have `gaze.js` pass the extension base URL + solution path INTO the frame via
     the initial `postMessage` (`start` command already carries `opts` — add
     `extBase` / `solutionPath` there), and delete the `getURL` calls in frame.js.
     This is the clean approach.
   - Verify camera still works in a sandboxed frame (needs `allow-scripts`; the
     iframe already has `allow="camera; microphone"`). getUserMedia from a null-origin
     sandboxed frame CAN be blocked — if so, fall back to: keep frame non-sandboxed
     but load MediaPipe's **non-SIMD** or a build that avoids `new Function`, OR host
     the eval-needing part differently. TEST sandbox+camera FIRST before deep work.
3. Reload, open frame DevTools, confirm the EvalError is gone and calibration shows.

**Alternate fix if sandbox blocks the camera:** the real issue is only the SIMD WASM
glue using `new Function`. Try forcing WebGazer/MediaPipe to the **non-SIMD** asset
(`face_mesh_solution_wasm_bin.*`, also bundled) — if that build avoids `new Function`,
no `unsafe-eval` is needed and we keep the current CSP. Worth a quick test.

### Observed behavior at the blocker (for context tomorrow):
- Camera white light comes on and STAYS on (getUserMedia succeeds).
- A video frame flashes for ~1–2 s then vanishes (pipeline aborts at the eval).
- Toast: "Camera/gaze unavailable — mouse still works". No 9-dot overlay.
- Do NOT switch cameras (HD Webcam ↔ DroidCam) mid-session — WebGazer binds the
  device at begin(); switching confuses it. Pick one, then reload the page.

---

## Files (current)

```
manifest.json                          MV3. content_scripts: platform→dwell→sidebar→gaze→content.
                                        web_accessible_resources: src/gaze/frame.html.
                                        CSP extension_pages: script-src 'self' 'wasm-unsafe-eval'.
                                        (TOMORROW: add "sandbox" + sandbox CSP — see above.)
README.md                              load/verify instructions
Drishti_2.0_Plan.md                    the full plan
PROGRESS.md                            this file
src/background/service-worker.js       message router + settings store
src/content/platform.js                browser detection + normalized ext handle
src/content/dwell.js                   input-agnostic dwell state machine
src/content/content.js                 injection, host mount, fire handler, mouse→dwell,
                                        constructs GazeController({onGaze, toast})
src/content/sidebar.js                 Shadow-DOM sidebar: 8 buttons, ring, toast, gaze toggle
src/content/gaze.js                    GazeController: injects frame iframe, relays gaze→dwell,
                                        draws 9-dot calibration, precise camera-error toasts
src/gaze/frame.html                    extension-origin gaze page (preload→webgazer→frame)
src/gaze/preload.js                    suppresses WebGazer's false "https only" alert
src/gaze/frame.js                      runs WebGazer, camera preflight, gaze→postMessage
src/vendor/webgazer.js                 vendored WebGazer 1.7.3 (~1.9 MB)
src/vendor/mediapipe/face_mesh/        bundled FaceMesh assets (7 files, ~17 MB):
    face_mesh.binarypb
    face_mesh_solution_packed_assets.data
    face_mesh_solution_packed_assets_loader.js
    face_mesh_solution_simd_wasm_bin.js / .wasm      (SIMD — uses new Function → needs unsafe-eval)
    face_mesh_solution_wasm_bin.js / .wasm           (non-SIMD — try this to avoid unsafe-eval)
```

---

## Public API contract (so downstream stays unchanged)

`content.js` does: `new GazeController({ onGaze: (x,y)=>dwell.update(x,y), toast })`
and `await gaze.toggle()`. As long as GazeController keeps `enable/disable/toggle`,
nothing else in the app needs to change when we finish Step 3.

---

## STEP 5 PLAN — next after Step 3 (Audio layer)

Voice input for Comment/Reply + read-aloud already exists (Audio button).
- SpeechRecognition (Web Speech API) for dictation; wire to Comment/Reply zones.
- Bengali support (`bn-IN`/`bn-BD`) per plan; language toggle in settings.
- Earcons/audio feedback for dwell fire (accessibility).

---

## Environment notes

- **ffmpeg installed** (winget, Gyan.FFmpeg). Drop an `.mp4` here to have frames read.
- Screenshots: save PNG/JPG in this folder, tell me the filename.
- After ANY code change: reload the Drishti card at `edge://extensions`
  (Developer mode on). If the card shows a yellow icon + "Errors", the manifest has
  a problem — click Errors to see it.
- To read the GAZE errors: edge://extensions → Drishti → **Inspect views: frame.html**
  → Console. (The page console won't show frame errors — different context.)
- "api error" popups during our chats = transient Claude Code harness hiccups, NOT
  project problems. Files are unaffected; just continue.

---

## Open questions still pending (§10 of the plan)

- Dwell default 750 ms — revisit after real gaze testing (may need longer).
- Which Tier 3 (no-API) site matters most → first scrape adapter (Step 9).
- Live Share signaling server host (self-host vs managed) → Step 8.
- Privacy stance on cloud speech + telemetry.
- DroidCam vs built-in HD Webcam: HD Webcam works; try DroidCam only if the gaze
  signal is too shaky after Step 3 is finished. Switch camera then RELOAD the page.
