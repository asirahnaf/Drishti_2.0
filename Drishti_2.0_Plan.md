# Project Drishti 2.0 — Gaze + Voice Browser Companion

**Date:** 2026-08-02
**Status:** Re-planned direction (supersedes the gaze-keyboard approach)
**One-line:** A gaze-and-voice **browser extension** that lets motor-impaired users
consume and interact with content sites (YouTube, Reddit, Wikipedia, Mastodon)
hands-free, using ~6 large gaze buttons + voice instead of a gaze keyboard.

---

## 0. Why the pivot (read this first)

The original project tried to type Bengali by looking at individual keys on a
webcam-only budget. That fails on **physics, not effort**:

- Commodity webcam gaze error (WebGazer.js) ≈ **3–5 cm on screen**.
- A keyboard key ≈ **1 cm** → smaller than the error → impossible to hit reliably.

**The fix:** stop asking the eye to be a precise pointer. Make targets **bigger than
the error** (6 large buttons + Up/Down = ~8 targets), and move all text to **voice**.
Same eye, same webcam — but the accuracy demand drops ~5×, so it actually works.

> Core idea preserved: the **human eye is still the primary input** for every action.
> Voice is a companion for text only; it does not replace gaze control.

---

## 1. Decisions locked (2026-08-02)

- **Target sites:** Tier 1 (API sites) + Tier 2 (open/API-friendly) + **Tier 3 (no-API,
  scrape) is ALSO a key priority**, not deferred.
- **Live Share default:** start **View-only**, escalate on explicit dwell-confirm.
- **Python/Selenium helper:** **deferred** from v1 core (v1 stays pure-browser) —
  BUT Tier 3 support is a priority, so the helper returns as soon as a no-API site
  is targeted (see §9 note).
- **Browsers:** Chrome + Edge for v1; add Firefox if the APIs work there too.
- **Language:** keep Bengali as a first-class target via Web Speech API (bn-BD/bn-IN).

---

## 2. Eye-tracking reality check (the make-or-break facts)

| Factor | Reality | Design response |
|---|---|---|
| Webcam gaze error | ~3–5 cm, worse in poor light / head motion | Targets are 1/6-screen big |
| Calibration | 5–9 dot calibration needed per session | Quick calibrate on start + re-cal button |
| Lighting | Visible-light cam inherits some old sensitivity | Fine at zone level; Near-IR is a *future* option only |
| Midas touch | Looking ≠ intending to click | Dwell 600–900ms + confirm ring + cooldown |
| Redundancy | Vulnerable users need a fallback | Optional switch/key activation alongside gaze |

**Verdict:** feasible. It works precisely because targets are bigger than the tracking error.

---

## 3. Architecture (layered)

```
BROWSER (user's own Chrome/Edge, logged into their own accounts)
├─ CONTENT SCRIPT (injected into the page)
│    • Shadow-DOM sidebar: Up/Down + 6 action buttons
│    • WebGazer.js gaze loop (webcam → screen coords)
│    • Dwell state machine (zone hit → confirm → fire)
│    • Site Adapter (per-site: how to like/comment/scroll)
├─ BACKGROUND SERVICE WORKER (extension core)
│    • Routes messages, holds settings/profiles
│    • Calls official APIs (YouTube Data, Reddit) via OAuth
│    • WebRTC signaling for Live Share
└─ AUDIO LAYER (in-browser Web Speech APIs)
     • SpeechRecognition (mic → text) = input
     • SpeechSynthesis (text → voice) = output/read-aloud

LOCAL HELPER (Python, localhost only) — added when Tier 3 sites are targeted
     • Selenium/scraping fallback for sites with NO API
     • "Most-used comment / like" computation
     • Runs only on the user's machine, never a remote server
```

**Key principle:** push everything possible into the extension (gaze, audio, UI, API
calls). The old design made a Python server the backbone — that's what made it
fragile and hardware-bound. Inverting that is the most important change.

---

## 4. The control surface — 6 buttons + Up/Down

Every button is a large gaze zone with dwell-to-confirm.

```
IDLE ──gaze enters zone──▶ HOVER ──dwell 600–900ms──▶ CONFIRM (fill ring) ──▶ FIRE
  ▲                          │                                                │
  └──────gaze leaves─────────┘◀──────────── cooldown 400ms ──────────────────┘
```

| Button | Action | Robust implementation |
|---|---|---|
| Up / Down | Scroll page | `window.scrollBy` — DOM-independent, never breaks |
| 1. Like | Like current item | Official API if available; else Site Adapter |
| 2. Comment | Voice comment | Mic → SpeechRecognition → editable draft → confirm → post |
| 3. Share | Share/copy link | `navigator.share` or copy URL (no site DOM needed) |
| 4. Audio | Read-aloud / talk | Dual mode — see §6 |
| 5. Most-used comment | Insert templated reply | From user's own history + local ranking |
| 6. Most-used like/react | Apply default reaction | API / adapter |

---

## 5. Live Share (remote caregiver access)

**Transport:** WebRTC peer-to-peer screen share via `getDisplayMedia()`. Video streams
directly to the caregiver — **never touches our servers**. Only a tiny signaling server
+ public STUN server are needed (near-zero hosting cost, stream stays P2P).

**Levels (default = View-only, escalate on dwell-confirm):**
1. **View-only** — caregiver watches. Safe default.
2. **Guided** — caregiver can highlight/point (shared cursor overlay), cannot act.
3. **Assist/handoff** — caregiver can trigger the 6 buttons remotely. Requires explicit consent.

**Guardrails (non-negotiable):**
- Explicit consent to start; persistent "you are being watched" indicator.
- Gaze-reachable **End Share** always on-screen — user can always cut it off.
- One caregiver at a time; rotating short-code to connect.
- Every session logged (reuse the SHA-256 immutable-log idea from v1 for audit).

**Extra Live Share ideas:**
- **Async fallback:** if no caregiver is online, Help can send a short screen recording +
  the SOS log so help isn't dependent on someone being live.
- **Voice channel:** reuse the same WebRTC connection for two-way audio (pairs with §6).

---

## 6. Audio layer (dual-mode "Audio" button)

- **Output (read-aloud):** `SpeechSynthesis` reads focused content — post title, top
  comment, video description. "Read what I'm looking at" mode: whatever zone the gaze
  rests on gets spoken.
- **Input (voice comment/search):** `SpeechRecognition` → **draft, then dwell-confirm**.
  Never auto-post.
- Split the two modes by short-dwell (talk) vs. long-dwell (read-aloud toggle).

**Updates folded in:**
- **Earcons** — distinct sounds for hover / confirm / fire / error (feedback without reading).
- **Bengali** — Web Speech API supports `bn-BD` / `bn-IN` for both directions. This is how
  the Bengali core survives without the gaze keyboard.
- **Barge-in** — speaking interrupts read-aloud.
- **Offline caveat:** browser SpeechRecognition often needs a connection (cloud-backed).
  If offline/private speech matters, add a local speech model in the Python helper later.

---

## 7. Target sites — API vs. DOM (the real axis)

The axis that controls bugs is **"has a stable public API"** vs. **"must scrape the page"** —
NOT open-source vs. not. All three tiers are priorities.

- **Tier 1 — official APIs (most robust):**
  - YouTube → Data API v3 (search, comments, rate) + IFrame Player API (play/pause/seek).
  - Reddit → official API (read, vote, comment).
  - Acting (like/comment/vote) needs the **user's own OAuth login**. "No login" = read only.
- **Tier 2 — open/API-friendly (lowest friction, great for MVP):**
  - Wikipedia/MediaWiki API, Mastodon (open API), RSS blogs. Real "open access", no auth drama.
- **Tier 3 — no API, scrape only (KEY PRIORITY here):**
  - Handled by the Python/Selenium helper + Site Adapter. Accepted as more fragile;
    robustness comes from the §8 resilience pattern.

---

## 8. Integrating no-API / non-open sites with minimal bugs

**Honest truth:** you CANNOT guarantee zero bugs on a site you don't control — its HTML can
change any day. Anyone promising "no bugs" there is wrong. But you get close to bug-free with
this resilience pattern (most → least robust):

1. **Prefer the API. Always.** If any public API exists, use it and skip DOM breakage entirely.
2. **Isolate your UI in a Shadow DOM** — their CSS can't break yours; yours can't break theirs.
3. **Prefer DOM-independent actions** — scroll, copy-link, `navigator.share`, read-aloud need
   nothing from the site's markup, so they never break.
4. **Target the accessibility tree, not CSS classes** — find controls by ARIA role / `aria-label`
   (`button[aria-label*="like" i]`). Sites randomize class names but rarely change a11y labels
   (doing so breaks their own screen-reader compliance).
5. **Site Adapter pattern with fallbacks** — one module per site; ordered selector fallbacks;
   self-check on load. If a control can't be found, the button **degrades gracefully**
   (disables + offers read-aloud/scroll) instead of crashing.
6. **Health telemetry** — adapters report "selector X failed" (local/opt-in) so you fix the one
   broken site fast.

Mental model: **depend only on stable contracts (APIs, ARIA roles, browser APIs), never on a
site's private HTML.**

---

## 9. MVP scope & build order

**v1 target sites:** YouTube (Tier 1) + Wikipedia or Mastodon (Tier 2).
> Note: Tier 3 is a stated priority, so the Python helper + first scrape adapter follow
> immediately after the pure-browser core is proven — not deferred indefinitely.

**Build order:**
1. Extension skeleton (manifest v3, service worker, content script) — Chrome/Edge.
2. Shadow-DOM sidebar UI: Up/Down + 6 buttons, dwell state machine (mouse-simulated first).
3. WebGazer integration + calibration flow; wire gaze → dwell.
4. DOM-independent actions first (scroll, copy-link, read-aloud) — these can't break.
5. Audio layer: SpeechSynthesis (read-aloud) then SpeechRecognition (voice draft + confirm).
6. Tier 1 API integration (YouTube OAuth: like/comment) → Tier 2 (Wikipedia/Mastodon).
7. Site Adapter pattern + graceful degradation; earcons; accessibility fallback (switch/key).
8. Live Share: WebRTC view-only → guided → assist; consent + End Share + session log.
9. Python helper + first Tier 3 scrape adapter.
10. Firefox port (verify Web Speech / getDisplayMedia / MV3 parity).

---

## 10. Open questions / next session

- Confirm MVP Tier-2 pick: Wikipedia vs. Mastodon.
- Confirm dwell time default (start 750ms?) and whether a redundant switch is in v1.
- Which Tier 3 site(s) matter most (drives the first scrape adapter)?
- Signaling server host for Live Share (self-host vs. managed)?
- Privacy stance on cloud speech + telemetry for this user population.

---

*Saved by Kiro on 2026-08-02. Open this to resume — start at §9 build order or §10 questions.*
