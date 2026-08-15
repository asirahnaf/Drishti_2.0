// Drishti 2.0 — Platform helper (cross-browser: Chrome + Edge, later Firefox)
//
// Chrome and Edge are both Chromium/MV3, so the `chrome.*` APIs are identical.
// Firefox uses the same MV3 surface under the `browser.*` namespace with promises.
// This helper gives later steps ONE place to ask "which browser?" and ONE API
// handle, so audio (§5), screen-share (§8) and the Firefox port (§10) don't grow
// scattered `if (chrome)` checks.

(() => {
  "use strict";
  const NS = (window.Drishti = window.Drishti || {});

  function detect() {
    const ua = navigator.userAgent;
    // Order matters: Edge's UA also contains "Chrome", so test Edg/ first.
    if (/\bEdg(A|iOS|)?\//.test(ua)) return "edge";
    if (typeof browser !== "undefined" && browser.runtime) return "firefox";
    if (/\bChrome\//.test(ua)) return "chrome";
    return "unknown";
  }

  // Normalized extension API handle. `browser` on Firefox, `chrome` elsewhere.
  const ext =
    typeof browser !== "undefined" && browser.runtime
      ? browser
      : typeof chrome !== "undefined"
      ? chrome
      : null;

  NS.platform = {
    name: detect(),
    ext,
    isChromium: () => ["chrome", "edge"].includes(NS.platform.name),
  };
})();
