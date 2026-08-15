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

  // Step 2+: what happens when a zone fires. DOM-independent actions (scroll, share,
  // read-aloud) are wired now — they need no site markup so they never break (§4, §8).
  // Site-specific actions (like/comment/react) arrive with the APIs in Step 6.
  function makeFireHandler(sidebar) {
    return (zone) => {
      sidebar.flashFire(zone.id);
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
          // like, comment, reply, react — need site APIs (Step 6). Tell the user.
          sidebar.toast(`"${zone.id}" needs the site login — coming in a later step`);
          console.log(`[Drishti] FIRE '${zone.id}' — action arrives in a later step`);
      }
    };
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

    // Input driver #1: the mouse. Always on as the fallback (§2 redundancy) — even
    // with gaze enabled, the mouse can still drive the same dwell engine.
    window.addEventListener("mousemove", (e) => dwell.update(e.clientX, e.clientY), {
      passive: true,
    });
    document.addEventListener("mouseleave", () => dwell.clearPoint(), { passive: true });

    // Input driver #2: gaze (Step 3). Lazy/opt-in — WebGazer only starts when the
    // user flips the sidebar toggle. It feeds the SAME dwell.update(x, y), so the
    // hover → ring → fire flow is identical to the mouse.
    const { GazeController } = window.Drishti || {};
    if (GazeController) {
      const gaze = new GazeController({
        onGaze: (x, y) => dwell.update(x, y),
        toast: (m, ms) => sidebar.toast(m, ms),
      });
      sidebar.onGazeToggle(async () => {
        const on = await gaze.toggle();
        sidebar.setGazeState(on);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
