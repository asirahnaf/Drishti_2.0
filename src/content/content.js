// Drishti 2.0 — Content script (injected into every page)
//
// Role (per plan §3):
//   • Hosts the Shadow-DOM sidebar (Up/Down + 6 action buttons) — added in Step 2
//   • Runs the WebGazer gaze loop — added in Step 3
//   • Drives the dwell state machine — added in Step 2
//   • Talks to the service worker for settings + API calls
//
// Step 1 skeleton: confirm injection, reach the service worker, read settings,
// and mount an (empty) Shadow-DOM host so later steps have a stable anchor.

(() => {
  "use strict";

  // Guard against double-injection (SPA navigations, re-injection via scripting API).
  if (window.__drishtiInjected) return;
  window.__drishtiInjected = true;

  const MSG = {
    PING: "drishti:ping",
    GET_SETTINGS: "drishti:get-settings",
    SET_SETTINGS: "drishti:set-settings",
    CAPTURE_SCREENSHOT: "drishti:capture-screenshot",
    NAVIGATE: "drishti:navigate",
  };

  const HOST_ID = "drishti-host";

  // Cross-browser extension handle (Chrome/Edge = chrome, Firefox = browser).
  const ext = window.Drishti?.platform?.ext || (typeof chrome !== "undefined" ? chrome : browser);

  function send(type, extra = {}) {
    return ext.runtime.sendMessage({ type, ...extra });
  }

  // Mount a single host element. The sidebar UI attaches a shadow root here so the
  // host page's CSS can never touch our UI, and vice-versa (plan §8).
  function mountHost() {
    if (document.getElementById(HOST_ID)) return document.getElementById(HOST_ID);
    const host = document.createElement("div");
    host.id = HOST_ID;
    // Keep the host itself out of layout; the shadow content positions itself.
    host.style.setProperty("all", "initial", "important");
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  // Read aloud the most relevant text on the page (§4 Audio, §6 read-aloud).
  // DOM-independent: uses SpeechSynthesis, no site markup needed. Toggles on repeat.
  function readAloud(sidebar) {
    const synth = window.speechSynthesis;
    if (!synth) {
      sidebar.toast("Read-aloud not supported in this browser");
      return;
    }
    // Second press while speaking = stop (barge-in comes in Step 5).
    if (synth.speaking) {
      synth.cancel();
      sidebar.toast("Stopped reading");
      return;
    }
    // Prefer a selected passage; else the main article/first heading + paragraphs.
    const sel = String(window.getSelection?.() || "").trim();
    let text = sel;
    if (!text) {
      const main = document.querySelector("main, article, #content, #mw-content-text") || document.body;
      const bits = [document.title];
      main.querySelectorAll("h1, h2, p").forEach((n) => {
        const t = n.textContent.trim();
        if (t) bits.push(t);
      });
      text = bits.join(". ").slice(0, 1200); // cap so it doesn't run forever
    }
    if (!text) {
      sidebar.toast("Nothing to read here");
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    synth.speak(u);
    sidebar.toast("Reading aloud… (Audio again to stop)");
  }

  // Share/copy the current page link (§4 Share). DOM-independent: navigator.share
  // where available (mobile/secure contexts), else clipboard, else a prompt.
  async function shareLink(sidebar) {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url });
        sidebar.toast("Share dialog opened");
        return;
      }
    } catch (e) {
      // user cancelled the native share sheet — fall through to copy
    }
    try {
      await navigator.clipboard.writeText(url);
      sidebar.toast("Link copied to clipboard");
    } catch (e) {
      sidebar.toast("Copy this link: " + url, 6000);
    }
  }

  // Multimodal Hand Gesture: Thumbs Up -> Like current item (e.g. YouTube like button)
  function likeCurrentItem(sidebar) {
    const ytLikeBtn = document.querySelector(
      "like-button-view-model button, #segmented-like-button button, ytd-like-button-renderer button"
    );
    if (ytLikeBtn) {
      ytLikeBtn.click();
      sidebar.toast("👍 Thumbs Up: Liked YouTube video!");
      return;
    }

    const genericLike = document.querySelector(
      'button[aria-label*="like" i], button[aria-label*="favorite" i], [role="button"][aria-label*="like" i]'
    );
    if (genericLike) {
      genericLike.click();
      sidebar.toast("👍 Thumbs Up: Liked item!");
      return;
    }

    sidebar.toast("👍 Thumbs Up detected!");
  }

  // Multimodal Hand Gesture: Open Palm -> Full page screenshot capture & download
  async function takeScreenshot(sidebar) {
    sidebar.toast("✋ Palm held: Capturing screenshot...", 2500);
    try {
      const res = await send(MSG.CAPTURE_SCREENSHOT);
      if (!res?.ok) {
        sidebar.toast("Screenshot failed: " + (res?.error || "unknown error"));
        return;
      }
      if (res.downloaded) {
        sidebar.toast("📸 Screenshot saved to Downloads!", 3000);
        return;
      }
      if (res.dataUrl) {
        const fetchRes = await fetch(res.dataUrl);
        const blob = await fetchRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `drishti-screenshot-${Date.now()}.png`;
        (document.body || document.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        sidebar.toast("📸 Screenshot saved to Downloads!", 3000);
      }
    } catch (err) {
      sidebar.toast("Screenshot error: " + (err?.message || err));
    }
  }

  // Step 2+: what happens when a zone fires. DOM-independent actions (scroll, share,
  // read-aloud) are wired now — they need no site markup so they never break (§4, §8).
  // Site-specific actions (like/comment/react) arrive with the APIs in Step 6.
  function makeFireHandler(sidebar) {
    return (zone) => {
      sidebar.flashFire(zone.id);

      // Handle AAC Quick-Reply phrase buttons
      if (zone.id.startsWith("aac-")) {
        window.Drishti?.aacInstance?.triggerPhrase(zone.id, sidebar);
        return;
      }

      switch (zone.id) {
        case "up":
          window.scrollBy({ top: -0.8 * window.innerHeight, behavior: "smooth" });
          break;
        case "down":
          window.scrollBy({ top: 0.8 * window.innerHeight, behavior: "smooth" });
          break;
        case "share":
          shareLink(sidebar);
          break;
        case "audio":
          readAloud(sidebar);
          break;
        default:
          console.log(`[Drishti] FIRE '${zone.id}'`);
      }
    };
  }

  // Context-Aware On-Page Search Bar Discovery
  function findSiteSearchInput() {
    const selectors = [
      'input[name="search_query"]', // YouTube
      'input#search',               // YouTube
      'input[name="search"]',       // Wikipedia
      'input#searchInput',          // Wikipedia
      'input#twotabsearchtextbox',  // Amazon
      'input[type="search"]',
      'textarea[name="q"]',         // Google modern
      'input[name="q"]',            // Google, GitHub, Reddit
      '[role="searchbox"]',
      'form[role="search"] input:not([type="hidden"])',
      'input[aria-label*="search" i]',
      'input[placeholder*="search" i]',
      'input[name*="search" i]:not([type="hidden"])',
      'input[id*="search" i]:not([type="hidden"])',
    ];

    for (const sel of selectors) {
      const matches = document.querySelectorAll(sel);
      for (const el of matches) {
        if (el.closest && el.closest("#drishti-host")) continue;
        if (el.disabled || el.readOnly) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 10) {
          const style = window.getComputedStyle(el);
          if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") {
            return el;
          }
        }
      }
    }
    return null;
  }

  // React & Web Framework Input Value Setter
  function setInputValue(el, value) {
    el.focus();
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Submit Search on Active Page
  function submitSearch(input) {
    // YouTube search submit button
    const ytBtn = document.querySelector(
      "#search-icon-legacy, ytd-searchbox button#search-icon-legacy"
    );
    if (ytBtn && ytBtn.offsetParent !== null) {
      ytBtn.click();
      return;
    }

    // Amazon search submit button
    const amzBtn = document.querySelector("#nav-search-submit-button");
    if (amzBtn && amzBtn.offsetParent !== null) {
      amzBtn.click();
      return;
    }

    // Inside same form submit button
    const form = input.form || input.closest("form");
    const submitBtn = form?.querySelector(
      'button[type="submit"], input[type="submit"], button[aria-label*="search" i]'
    );
    if (submitBtn && submitBtn.offsetParent !== null) {
      submitBtn.click();
      return;
    }

    // Dispatch Enter key events
    const enterOpts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    input.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
    input.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
    input.dispatchEvent(new KeyboardEvent("keyup", enterOpts));

    // Fallback: form requestSubmit
    if (form) {
      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      } catch (e) {
        /* best effort */
      }
    }
  }

  // Perform Contextual Site Search
  function performSiteSearch(query, sidebar) {
    const searchInput = findSiteSearchInput();
    if (!searchInput) return false;

    const host = location.hostname.replace(/^www\./, "").split(".")[0];
    const siteName = host.charAt(0).toUpperCase() + host.slice(1);

    sidebar.toast(`🔍 Searching ${siteName} for: "${query}"`, 3000);
    setInputValue(searchInput, query);

    setTimeout(() => {
      submitSearch(searchInput);
    }, 100);

    return true;
  }

  // Multimodal Voice Action Handler
  function handleVoiceCommand(cmd, sidebar) {
    switch (cmd.action) {
      case "navigate":
        if (cmd.url) {
          send(MSG.NAVIGATE, { url: cmd.url });
        }
        break;
      case "search": {
        const query = cmd.query;
        if (!query) break;

        let handledOnSite = false;
        if (!cmd.forceWeb) {
          handledOnSite = performSiteSearch(query, sidebar);
        }

        if (!handledOnSite) {
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          sidebar.toast(`🔍 Searching Google: "${query}"`, 2500);
          send(MSG.NAVIGATE, { url: searchUrl });
        }
        break;
      }
      case "scroll-down": {
        const delta = Math.round(0.8 * window.innerHeight);
        if (document.scrollingElement) {
          document.scrollingElement.scrollBy({ top: delta, behavior: "smooth" });
        }
        window.scrollBy({ top: delta, behavior: "smooth" });
        break;
      }
      case "scroll-up": {
        const delta = Math.round(-0.8 * window.innerHeight);
        if (document.scrollingElement) {
          document.scrollingElement.scrollBy({ top: delta, behavior: "smooth" });
        }
        window.scrollBy({ top: delta, behavior: "smooth" });
        break;
      }
      case "scroll-top": {
        if (document.scrollingElement) {
          document.scrollingElement.scrollTo({ top: 0, behavior: "smooth" });
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      }
      case "scroll-bottom": {
        const bottom = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        if (document.scrollingElement) {
          document.scrollingElement.scrollTo({ top: bottom, behavior: "smooth" });
        }
        window.scrollTo({ top: bottom, behavior: "smooth" });
        break;
      }
      case "history-back":
        window.history.back();
        break;
      case "history-forward":
        window.history.forward();
        break;
      case "reload":
        window.location.reload();
        break;
      case "read-aloud":
        readAloud(sidebar);
        break;
      case "stop-audio":
        if (window.speechSynthesis?.speaking) {
          window.speechSynthesis.cancel();
          sidebar.toast("🔇 Audio stopped");
        }
        break;
      case "screenshot":
        takeScreenshot(sidebar);
        break;
      case "share":
        shareLink(sidebar);
        break;
      case "like":
        likeCurrentItem(sidebar);
        break;
      case "show-links":
        window.Drishti?.hintsInstance?.show();
        break;
      case "click-link":
        window.Drishti?.hintsInstance?.click(cmd.number);
        break;
      case "hide-links":
        window.Drishti?.hintsInstance?.hide();
        break;
      case "open-aac":
        sidebar.setAacOpen(true);
        break;
      case "close-aac":
        sidebar.setAacOpen(false);
        break;
      case "dictation-input":
        window.Drishti?.dictationInstance?.insertDictatedText(cmd.text);
        break;
      case "dictation-confirm":
        window.Drishti?.dictationInstance?.confirmAndSend();
        break;
      case "dictation-clear":
        window.Drishti?.dictationInstance?.clearText();
        break;
      case "dictation-exit":
        window.Drishti?.dictationInstance?.close();
        break;
      default:
        console.log(`[Drishti] Voice action: ${cmd.action}`, cmd);
    }
  }

  async function init() {
    const host = mountHost();

    let settings = { dwellMs: 750, cooldownMs: 400 };
    const browserName = window.Drishti?.platform?.name || "unknown";
    try {
      const pong = await send(MSG.PING);
      const res = await send(MSG.GET_SETTINGS);
      settings = res?.settings || settings;
      console.log(`[Drishti] content script ready (browser: ${browserName}):`, {
        pong,
        settings,
        host,
      });
    } catch (err) {
      console.warn("[Drishti] could not reach service worker; using defaults:", err);
    }

    const { Sidebar, DwellEngine } = window.Drishti || {};
    if (!Sidebar || !DwellEngine) {
      console.error("[Drishti] sidebar/dwell modules missing — check manifest load order");
      return;
    }

    let sidebar, dwell;
    try {
      sidebar = new Sidebar(host);
      dwell = new DwellEngine({
        dwellMs: settings.dwellMs,
        cooldownMs: settings.cooldownMs,
        onState: (info) => sidebar.renderDwell(info),
        onFire: makeFireHandler(sidebar),
      });
      dwell.setZones(sidebar.getZones());
      dwell.start();
    } catch (err) {
      console.error("[Drishti] sidebar construction failed:", err);
      return;
    }

    let lastMouseMoveTime = 0;

    // Input driver #1: the mouse. Always on as the fallback (§2 redundancy) — even
    // with gaze enabled, the mouse can still drive the same dwell engine.
    window.addEventListener("mousemove", (e) => {
      lastMouseMoveTime = Date.now();
      dwell.update(e.clientX, e.clientY);
      window.Drishti?.dictationInstance?.updatePointer(e.clientX, e.clientY);
    }, {
      passive: true,
    });
    document.addEventListener("mouseleave", () => dwell.clearPoint(), { passive: true });

    // Input driver #2: gaze (Step 3). Lazy/opt-in — WebGazer only starts when the
    // user flips the sidebar toggle. It feeds the SAME dwell.update(x, y), so the
    // hover → ring → fire flow is identical to the mouse.
    let smoothedX = null;
    let smoothedY = null;
    let lastGestureTime = 0;
    let lastGestureType = "";

    const { GazeController } = window.Drishti || {};
    if (GazeController) {
      const gaze = new GazeController({
        onGaze: (x, y) => {
          if (Date.now() - lastMouseMoveTime > 1500) {
            const curX = Math.max(0, Math.min(window.innerWidth, x));
            const curY = Math.max(0, Math.min(window.innerHeight, y));

            if (smoothedX === null || smoothedY === null) {
              smoothedX = curX;
              smoothedY = curY;
            } else {
              const dx = curX - smoothedX;
              const dy = curY - smoothedY;
              const dist = Math.hypot(dx, dy);

              // 1. Fixation Deadband: within 14px, keep pointer steady to eliminate micro-tremor vibration
              if (dist >= 14) {
                // 2. Controlled Damping Curve:
                // Small movements (<45px): heavy damping (alpha 0.08) for stable button dwelling
                // Medium shifts (45-150px): gentle cruise (alpha 0.14)
                // Saccades (>150px): smooth glide (alpha 0.22)
                let alpha;
                if (dist < 45) {
                  alpha = 0.08;
                } else if (dist < 150) {
                  alpha = 0.14;
                } else {
                  alpha = 0.22;
                }

                let step = alpha * dist;
                // 3. Slew Rate Cap: max 36px per frame so the pointer never darts or flies wildly
                const MAX_STEP_PX = 36;
                if (step > MAX_STEP_PX) {
                  step = MAX_STEP_PX;
                }

                smoothedX += (dx / dist) * step;
                smoothedY += (dy / dist) * step;
              }
            }

            // Natural Smooth Gaze Tracking:
            // Cursor follows smoothed gaze position. When hovering, gently bias 30% toward button center.
            let cursorX = smoothedX;
            let cursorY = smoothedY;
            if (dwell.zoneId) {
              const btnObj = sidebar.buttons.get(dwell.zoneId);
              if (btnObj?.el) {
                const r = btnObj.el.getBoundingClientRect();
                const centerX = r.left + r.width / 2;
                const centerY = r.top + r.height / 2;
                // Stronger magnetic pull (45%) locks the visual cursor onto the button center
                cursorX = 0.55 * smoothedX + 0.45 * centerX;
                cursorY = 0.55 * smoothedY + 0.45 * centerY;
              }
            }
            sidebar.updateGazeCursor(cursorX, cursorY, true);

            dwell.update(smoothedX, smoothedY);
            window.Drishti?.dictationInstance?.updatePointer(cursorX, cursorY);
          } else {
            smoothedX = null;
            smoothedY = null;
            sidebar.updateGazeCursor(0, 0, false);
          }
        },
        onCalibComplete: () => {
          smoothedX = null;
          smoothedY = null;
        },
        onGesture: (gestureName, score) => {
          const now = Date.now();
          if (gestureName === lastGestureType && now - lastGestureTime < 2000) return;
          if (now - lastGestureTime < 1000) return;

          lastGestureTime = now;
          lastGestureType = gestureName;

          console.log(`[Drishti] Gesture recognized: ${gestureName} (${(score * 100).toFixed(0)}%)`);

          if (gestureName === "Thumb_Up") {
            likeCurrentItem(sidebar);
          } else if (gestureName === "Open_Palm") {
            takeScreenshot(sidebar);
          }
        },
        toast: (m, ms) => sidebar.toast(m, ms),
      });
      sidebar.onGazeToggle(async () => {
        const on = await gaze.toggle();
        sidebar.setGazeState(on);
        if (!on) {
          sidebar.updateGazeCursor(0, 0, false);
          smoothedX = null;
          smoothedY = null;
        }
        // Persist the preference so later sessions remember it.
        try {
          await send(MSG.SET_SETTINGS, { patch: { gazeEnabled: on } });
        } catch (e) {
          /* settings persistence is best-effort */
        }
      });
      window.__drishti = { host, settings, sidebar, dwell, gaze, MSG };
    } else {
      console.warn("[Drishti] GazeController missing — mouse only (check manifest)");
      window.__drishti = { host, settings, sidebar, dwell, MSG };
    }

    // Voice Engine (Multimodal Voice & Command Navigation)
    const { VoiceEngine } = window.Drishti || {};
    if (VoiceEngine) {
      const voice = new VoiceEngine({
        onCommand: (cmd) => handleVoiceCommand(cmd, sidebar),
        onStatus: (st) => sidebar.setVoiceState(st.active),
        toast: (m, ms) => sidebar.toast(m, ms),
      });

      // Auto-resume voice across page navigations & new tabs if enabled
      if (settings.voiceEnabled) {
        console.log("[Drishti] Auto-resuming Voice from saved settings");
        voice.start().then((on) => {
          sidebar.setVoiceState(on);
        }).catch((err) => {
          console.warn("[Drishti] Auto-resume voice failed:", err);
        });
      }

      sidebar.onVoiceToggle(async () => {
        const on = await voice.toggle();
        sidebar.setVoiceState(on);
        try {
          await send(MSG.SET_SETTINGS, { patch: { voiceEnabled: on } });
        } catch (e) {
          /* best effort */
        }
      });

      // Quick keyboard shortcut Alt+V to toggle voice
      window.addEventListener("keydown", async (e) => {
        if (e.altKey && (e.key === "v" || e.key === "V")) {
          e.preventDefault();
          const on = await voice.toggle();
          sidebar.setVoiceState(on);
          try {
            await send(MSG.SET_SETTINGS, { patch: { voiceEnabled: on } });
          } catch (e) {}
        }
      });

      // Real-time multi-tab synchronization of voice state
      if (ext.storage?.onChanged) {
        ext.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes["drishti:settings"]) {
            const next = changes["drishti:settings"].newValue;
            if (next && typeof next.voiceEnabled === "boolean") {
              if (next.voiceEnabled && !voice.active) {
                voice.start().then((on) => sidebar.setVoiceState(on));
              } else if (!next.voiceEnabled && voice.active) {
                voice.stop();
                sidebar.setVoiceState(false);
              }
            }
          }
        });
      }

      window.__drishti.voice = voice;
    }

    // Numbered Link Hints Engine (Vimium-Style Hands-Free Clicker)
    const { HintsEngine } = window.Drishti || {};
    if (HintsEngine) {
      const hints = new HintsEngine({
        toast: (m, ms) => sidebar.toast(m, ms),
      });
      window.Drishti.hintsInstance = hints;
      window.__drishti.hints = hints;

      // Quick keyboard shortcut Alt+L to toggle link hints
      window.addEventListener("keydown", (e) => {
        if (e.altKey && (e.key === "l" || e.key === "L")) {
          e.preventDefault();
          hints.toggle();
        }
      });
    }

    // AAC Quick-Reply Speech Engine
    const { AacEngine } = window.Drishti || {};
    if (AacEngine) {
      const aac = new AacEngine({
        toast: (m, ms) => sidebar.toast(m, ms),
      });
      window.Drishti.aacInstance = aac;
      window.__drishti.aac = aac;

      // Sync dwell zones whenever AAC drawer opens or closes
      sidebar.onAacToggle((isOpen) => {
        dwell.setZones(sidebar.getZones());
        if (isOpen) {
          sidebar.toast("🗣️ Quick Talk Menu: Gaze at any phrase to speak aloud", 3000);
        }
      });

      // Quick keyboard shortcut Alt+A to toggle AAC mode
      window.addEventListener("keydown", (e) => {
        if (e.altKey && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          sidebar.toggleAac();
        }
      });
    }

    // Social Media Voice Dictation & Gaze Confirmation Guardrail
    const { DictationEngine } = window.Drishti || {};
    if (DictationEngine) {
      const dictation = new DictationEngine({
        sidebar,
        voiceEngine: window.__drishti?.voice,
        toast: (m, ms) => sidebar.toast(m, ms),
      });
      window.Drishti.dictationInstance = dictation;
      window.__drishti.dictation = dictation;

      // Quick keyboard shortcut Alt+D to toggle dictation on active input
      window.addEventListener("keydown", (e) => {
        if (e.altKey && (e.key === "d" || e.key === "D")) {
          e.preventDefault();
          const target = document.activeElement;
          if (dictation._isEditable(target)) {
            dictation.activate(target);
          } else {
            // Find first visible input/textarea on page
            const candidate = document.querySelector('textarea, input[type="text"], input:not([type]), [contenteditable="true"]');
            if (candidate) {
              candidate.focus();
              dictation.activate(candidate);
            } else {
              sidebar.toast("No editable field found on page.");
            }
          }
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
