// Drishti 2.0 — gaze frame preload shim (must run BEFORE webgazer.js)
//
// WebGazer.begin() has a legacy guard:
//   "https:" !== location.protocol && "localhost" !== location.hostname && window.chrome
//   && alert("WebGazer works only over https. …run a local server.")
//
// Inside this iframe location.protocol is "chrome-extension:", which IS a secure
// context (getUserMedia is allowed here), but it's neither "https:" nor "localhost",
// so the guard fires a FALSE-POSITIVE modal alert that blocks the whole flow.
//
// We are genuinely on a secure origin, so suppress ONLY that specific alert and let
// everything else proceed. Every other alert (should any exist) still shows.

(() => {
  "use strict";
  const realAlert = window.alert ? window.alert.bind(window) : null;
  window.alert = function (msg) {
    const m = String(msg == null ? "" : msg);
    if (/WebGazer works only over https/i.test(m)) {
      // Expected on chrome-extension:// — this origin is a secure context.
      console.info("[Drishti] suppressed WebGazer https warning (extension origin is secure)");
      return;
    }
    if (realAlert) return realAlert(msg);
  };
})();
