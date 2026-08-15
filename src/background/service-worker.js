// Drishti 2.0 — Background service worker (extension core)
//
// Role (per plan §3):
//   • Routes messages between content scripts and the extension core
//   • Holds settings / profiles (persisted in chrome.storage)
//   • Later: calls official APIs (YouTube, Mastodon) via OAuth; WebRTC signaling
//
// This is the Step 1 skeleton: message routing + settings plumbing only.
//
// Cross-browser: Chrome/Edge expose `chrome`, Firefox exposes `browser`. They share
// the same MV3 surface, so one shim lets the rest of the file stay namespace-free.
const ext = typeof browser !== "undefined" && browser.runtime ? browser : chrome;

const MSG = {
  PING: "drishti:ping",
  GET_SETTINGS: "drishti:get-settings",
  SET_SETTINGS: "drishti:set-settings",
};

// Defaults locked from the plan (§10 open questions): dwell 750ms, cooldown 400ms.
const DEFAULT_SETTINGS = {
  dwellMs: 750,
  cooldownMs: 400,
  sidebarEnabled: true,
  gazeEnabled: false, // mouse-driven until Step 3 wires WebGazer
};

const SETTINGS_KEY = "drishti:settings";

async function getSettings() {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await ext.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// Central message router. Returns true to keep the channel open for async replies.
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message?.type) {
    case MSG.PING:
      sendResponse({ ok: true, type: "drishti:pong", tabId, at: Date.now() });
      return false;

    case MSG.GET_SETTINGS:
      getSettings().then((settings) => sendResponse({ ok: true, settings }));
      return true;

    case MSG.SET_SETTINGS:
      setSettings(message.patch || {}).then((settings) =>
        sendResponse({ ok: true, settings })
      );
      return true;

    default:
      sendResponse({ ok: false, error: `unknown message type: ${message?.type}` });
      return false;
  }
});

ext.runtime.onInstalled.addListener(async (details) => {
  // Seed defaults on first install so later steps can rely on them existing.
  const settings = await getSettings();
  await ext.storage.local.set({ [SETTINGS_KEY]: settings });
  console.log("[Drishti] service worker installed:", details.reason, settings);
});

console.log("[Drishti] service worker booted");
