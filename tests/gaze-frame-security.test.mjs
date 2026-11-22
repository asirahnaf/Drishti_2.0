// Security tests for the content-script <-> gaze-frame bridge.
//
// Loads the real src/content/gaze.js and src/gaze/frame.js into two simulated
// windows (the host page and the extension iframe) with a fake chrome.storage,
// then checks that a hostile page can neither command the frame (camera/mic)
// nor read the data it produces, while the real content script still can.
//
// Run: node --test "tests/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const GAZE_SRC = readFileSync(new URL("src/content/gaze.js", ROOT), "utf8");
const FRAME_SRC = readFileSync(new URL("src/gaze/frame.js", ROOT), "utf8");

const EXT_ORIGIN = "chrome-extension://drishtitestid";
const PAGE_ORIGIN = "https://evil.example";
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Node reports "null" as the origin of chrome-extension:// URLs; browsers report
// "chrome-extension://<id>". Match the browser.
class BrowserURL extends URL {
  get origin() {
    return this.protocol === "chrome-extension:" ? `chrome-extension://${this.host}` : super.origin;
  }
}

class FakeWindow {
  constructor(origin) {
    this.origin = origin;
    this.listeners = [];
    this.innerWidth = 1280;
    this.innerHeight = 720;
  }
  addEventListener(type, fn) {
    if (type === "message") this.listeners.push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  // Deliver a message INTO this window, as sent by `from`.
  deliver(data, from, ports = []) {
    setTimeout(() => {
      for (const l of [...this.listeners]) {
        l({ data, source: from, origin: from.origin, ports });
      }
    }, 0);
  }
}

function makeStorage() {
  const data = {};
  return {
    data,
    local: {
      async get(key) {
        return key in data ? { [key]: data[key] } : {};
      },
      async set(obj) {
        Object.assign(data, obj);
      },
      async remove(key) {
        delete data[key];
      },
    },
  };
}

function setup() {
  const storage = makeStorage();
  const chrome = {
    runtime: { getURL: (p = "") => `${EXT_ORIGIN}/${p}` },
    storage: { local: storage.local },
  };

  const page = new FakeWindow(PAGE_ORIGIN);
  const frame = new FakeWindow(EXT_ORIGIN);
  frame.parent = page;

  // Everything the frame sends to the page window (i.e. what a hostile page sees).
  const seenByPage = [];
  page.addEventListener("message", (e) => {
    if (e.source === frame) seenByPage.push(e.data);
  });

  // page.postMessage is called by frame.js (window.parent.postMessage).
  page.postMessage = (data) => page.deliver(data, frame);
  // frame.postMessage is called from the page side (content script or attacker).
  frame.postMessage = (data, _origin, ports = []) => frame.deliver(data, page, ports);

  // --- frame context (extension iframe) ---
  frame.webgazer = undefined; // start() will report an error over the port
  const frameCtx = vm.createContext({
    window: frame,
    chrome,
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    URL: BrowserURL,
    performance,
    navigator: {},
    document: { documentElement: { classList: { toggle() {}, remove() {} } } },
    localStorage: { clear() {} },
  });

  // --- page context (content script) ---
  const iframeEl = { style: {}, contentWindow: null };
  const document = {
    createElement: () => iframeEl,
    body: {
      appendChild(el) {
        el.contentWindow = frame;
        vm.runInContext(FRAME_SRC, frameCtx); // frame "loads"
      },
    },
    documentElement: {},
  };
  page.Drishti = { platform: { ext: chrome } };
  const pageCtx = vm.createContext({
    window: page,
    document,
    chrome,
    crypto: globalThis.crypto,
    MessageChannel,
    setTimeout,
    clearTimeout,
    URL: BrowserURL,
    console: { info() {}, warn() {}, error() {}, log() {} },
  });
  vm.runInContext(GAZE_SRC, pageCtx);

  const toasts = [];
  const gaze = new page.Drishti.GazeController({ toast: (m) => toasts.push(m) });
  return { gaze, page, frame, storage, seenByPage, toasts };
}

test("legit content script connects and gets replies over the private channel", async (t) => {
  const { gaze, seenByPage, toasts, storage } = setup();
  t.after(() => gaze._port?.close());
  const ok = await gaze.enable();
  // webgazer is absent in the test, so the frame must answer "start" with an
  // error — which proves the command reached it and the reply came back.
  assert.equal(ok, false);
  assert.ok(toasts.some((t) => /Camera tracking unavailable/.test(t)), toasts.join(" | "));
  // The page only ever saw the content-free "loaded" ping.
  assert.equal(JSON.stringify(seenByPage), JSON.stringify([{ ns: "drishti-gaze", evt: "loaded" }]));
  // The one-time nonce was consumed.
  assert.deepEqual(Object.keys(storage.data), []);
  gaze._port?.close();
});

test("hostile page cannot command the frame with plain window messages", async (t) => {
  const { gaze, page, frame, seenByPage } = setup();
  t.after(() => gaze._port?.close());
  await gaze.enable(); // a real, connected frame
  seenByPage.length = 0;
  for (const cmd of ["start", "startAudio", "calibrate", "stop"]) {
    frame.deliver({ ns: "drishti-gaze", cmd, opts: {} }, page);
  }
  await tick(50);
  assert.deepEqual(seenByPage, [], "frame must not answer the page");
  gaze._port?.close();
});

test("hostile page cannot forge the handshake before the content script", async (t) => {
  const { page, frame, seenByPage } = setup();
  // Load the frame without the content script ever connecting.
  vm.runInContext(FRAME_SRC, vm.createContext({
    window: frame,
    chrome: { runtime: { getURL: (p = "") => `${EXT_ORIGIN}/${p}` }, storage: { local: makeStorage().local } },
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout, clearTimeout, URL: BrowserURL, performance, navigator: {},
    document: { documentElement: { classList: { toggle() {}, remove() {} } } },
    localStorage: { clear() {} },
  }));

  const evil = new MessageChannel();
  const gotByAttacker = [];
  evil.port1.onmessage = (e) => gotByAttacker.push(e.data);

  for (const nonce of [undefined, "", "0".repeat(32), "not-hex", "a".repeat(32)]) {
    frame.deliver({ ns: "drishti-gaze", cmd: "connect", nonce }, page, [evil.port2]);
  }
  await tick(50);
  evil.port1.postMessage({ cmd: "startAudio" });
  await tick(50);
  assert.deepEqual(gotByAttacker, [], "attacker port must never be accepted");
  assert.deepEqual(seenByPage.filter((m) => m.evt !== "loaded"), []);
  evil.port1.close();
});

test("a used nonce cannot be replayed by the page", async (t) => {
  const { gaze, page, frame } = setup();
  t.after(() => gaze._port?.close());
  // Capture the real nonce as the content script sends it.
  let realNonce = null;
  const realDeliver = frame.deliver.bind(frame);
  frame.deliver = (data, from, ports) => {
    if (data?.cmd === "connect") realNonce = data.nonce;
    realDeliver(data, from, ports);
  };
  await gaze.enable();
  assert.match(realNonce, /^[0-9a-f]{32}$/);

  const evil = new MessageChannel();
  const gotByAttacker = [];
  evil.port1.onmessage = (e) => gotByAttacker.push(e.data);
  realDeliver({ ns: "drishti-gaze", cmd: "connect", nonce: realNonce }, page, [evil.port2]);
  await tick(50);
  evil.port1.postMessage({ cmd: "start" });
  await tick(50);
  assert.deepEqual(gotByAttacker, []);
  evil.port1.close();
  gaze._port?.close();
});
