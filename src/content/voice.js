// Drishti 2.0 — Voice Engine & Command Parser (src/content/voice.js)
//
// Role:
//   • Captures voice via Web Speech API (webkitSpeechRecognition) with zero cloud latency.
//   • Parses web navigation ("Go to YouTube", "Search AI ethics") and page control ("Scroll down", "Back").
//   • Dispatches clean actions to content.js and background service worker.

(() => {
  "use strict";

  const NS = (window.Drishti = window.Drishti || {});

  const KNOWN_SITES = {
    youtube: "https://www.youtube.com",
    google: "https://www.google.com",
    wikipedia: "https://www.wikipedia.org",
    reddit: "https://www.reddit.com",
    facebook: "https://www.facebook.com",
    twitter: "https://www.x.com",
    x: "https://www.x.com",
    github: "https://www.github.com",
    netflix: "https://www.netflix.com",
    amazon: "https://www.amazon.com",
    news: "https://news.google.com",
    gmail: "https://mail.google.com",
    email: "https://mail.google.com",
    chatgpt: "https://chat.openai.com",
    bbc: "https://www.bbc.com",
    cnn: "https://www.cnn.com",
    linkedin: "https://www.linkedin.com",
  };

  const WORD_TO_NUMBER = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50,
  };

  class VoiceEngine {
    constructor(options = {}) {
      this.options = options;
      this.active = false;
      this.isListening = false;
      this.recognition = null;
      this.restartTimer = null;
      this.hasFatalError = false;
      this.consecutiveFailures = 0;
      this.lastStartTime = 0;
      this.dictationMode = false;
      this.onCommandCallback = options.onCommand || null;
      this.onStatusCallback = options.onStatus || null;
      this.toast = options.toast || ((msg) => console.log("[Drishti Voice]", msg));

      this._initSpeech();
    }

    _initSpeech() {
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

      if (!SpeechRecognition) {
        console.warn("[Drishti Voice] SpeechRecognition not supported in this browser.");
        return;
      }

      try {
        const r = new SpeechRecognition();
        r.continuous = true;
        r.interimResults = false;
        r.lang = navigator.language || "en-US";
        r.maxAlternatives = 1;

        r.onstart = () => {
          this.isListening = true;
          this.consecutiveFailures = 0;
          this._emitStatus({ active: this.active, isListening: true });
        };

        r.onresult = (event) => {
          if (!event.results || event.results.length === 0) return;
          const lastIdx = event.results.length - 1;
          const result = event.results[lastIdx];
          if (!result || !result[0]) return;

          const transcript = result[0].transcript.trim();
          console.log(`[Drishti Voice] Heard (final: ${result.isFinal}): "${transcript}"`);
          this._handleTranscript(transcript);
        };

        r.onerror = (event) => {
          console.warn("[Drishti Voice] Error:", event.error);

          // Fatal errors: mic not allowed, no microphone hardware, service blocked
          if (
            event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "audio-capture"
          ) {
            this.hasFatalError = true;
            this.stop();
            this.toast("🎙️ Mic permission needed. Click the lock/camera icon in your address bar to allow.");
            return;
          }

          // Network error in Chromium is simply a routine cloud streaming timeout (occurs every ~20-30s).
          // Do NOT treat as fatal: let onend silently refresh the stream so the button stays ON.
          if (event.error === "network") {
            console.log("[Drishti Voice] Routine cloud socket refresh (20-30s timeout). Reconnecting...");
            return;
          }

          // Non-fatal errors like 'no-speech' are natural when the user pauses speaking
          if (event.error === "no-speech") {
            // Do not treat as fatal, let onend handle graceful restart
            return;
          }

          this.consecutiveFailures++;
          if (this.consecutiveFailures > 3) {
            this.hasFatalError = true;
            this.stop();
            this.toast("🎙️ Voice paused due to repeated recognition errors.");
          }
        };

        r.onend = () => {
          this.isListening = false;

          // If stopped by user or fatal error, do NOT restart
          if (!this.active || this.hasFatalError) {
            this._emitStatus({ active: false, isListening: false });
            return;
          }

          // Rate-limit restarts: if session died too quickly (<1000ms), wait before retrying
          const elapsed = Date.now() - this.lastStartTime;
          const delay = elapsed < 1200 ? 1500 : 350;

          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            if (this.active && !this.hasFatalError && !this.isListening) {
              try {
                this.lastStartTime = Date.now();
                this.recognition.start();
              } catch (e) {
                // Ignore if already transitioning
              }
            }
          }, delay);
        };

        this.recognition = r;
      } catch (err) {
        console.error("[Drishti Voice] Initialization failed:", err);
      }
    }

    _emitStatus(state) {
      if (typeof this.onStatusCallback === "function") {
        this.onStatusCallback(state);
      }
    }

    async start(showToast = true) {
      if (!this.recognition) {
        this.toast("Speech Recognition not supported on this page.");
        return false;
      }

      this.active = true;
      this.hasFatalError = false;
      this.consecutiveFailures = 0;
      this._emitStatus({ active: true, isListening: false });

      // Start Web Speech Recognition directly
      try {
        this.lastStartTime = Date.now();
        this.recognition.start();
        if (showToast) {
          this.toast("🎙️ Voice Active — say 'Scroll down', 'Search [topic]'...", 3000);
        }
        return true;
      } catch (err) {
        if (err.name !== "InvalidStateError") {
          console.warn("[Drishti Voice] start error:", err);
        }
        return true;
      }
    }

    stop() {
      this.active = false;
      clearTimeout(this.restartTimer);
      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (e) {
          // ignore
        }
      }
      this._emitStatus({ active: false, isListening: false });
    }

    async toggle() {
      if (this.active) {
        this.stop();
        this.toast("🎙️ Voice Paused");
        return false;
      } else {
        return await this.start();
      }
    }

    setDictationMode(enabled) {
      this.dictationMode = !!enabled;
      console.log(`[Drishti Voice] Dictation mode set to: ${this.dictationMode}`);
    }

    _handleTranscript(rawText) {
      if (!rawText) return;

      // Clean punctuation & excess whitespace everywhere
      const text = rawText
        .toLowerCase()
        .replace(/[.,?!:;'"~`]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) return;
      console.log(`[Drishti Voice] Clean text: "${text}"`);

      // 0. Dictation Mode Handler (Takes priority when an input/comment box is active)
      if (this.dictationMode) {
        if (
          text === "confirm" ||
          text === "send" ||
          text === "confirm and send" ||
          text === "submit" ||
          text === "post"
        ) {
          this._dispatch({ action: "dictation-confirm", transcript: rawText });
          return;
        }

        if (
          text === "clear" ||
          text === "clear text" ||
          text === "clear input" ||
          text === "delete all"
        ) {
          this._dispatch({ action: "dictation-clear", transcript: rawText });
          return;
        }

        if (
          text === "cancel" ||
          text === "exit" ||
          text === "close" ||
          text === "stop dictating" ||
          text === "done"
        ) {
          this._dispatch({ action: "dictation-exit", transcript: rawText });
          return;
        }

        // Dictate text directly into the active field
        this._dispatch({ action: "dictation-input", text: rawText, transcript: rawText });
        return;
      }

      // 1. Help & Guide
      if (text.includes("help") || text.includes("commands") || text.includes("what can i say")) {
        this.toast("🗣️ Say: 'Scroll down', 'Scroll up', 'Go to YouTube', 'Search [topic]', 'Screenshot'", 4500);
        return;
      }

      // 2. Page Scrolling Navigation (Permissive phrase matching)
      if (text.includes("scroll down") || text.includes("page down") || text.includes("go down") || text === "down") {
        this.toast("▼ Scrolling Down");
        this._dispatch({ action: "scroll-down", transcript: rawText });
        return;
      }

      if (text.includes("scroll up") || text.includes("page up") || text.includes("go up") || text === "up") {
        this.toast("▲ Scrolling Up");
        this._dispatch({ action: "scroll-up", transcript: rawText });
        return;
      }

      if (text.includes("top") || text.includes("scroll to top") || text.includes("go to top")) {
        this.toast("▲ Scrolled to Top");
        this._dispatch({ action: "scroll-top", transcript: rawText });
        return;
      }

      if (text.includes("bottom") || text.includes("scroll to bottom") || text.includes("go to bottom")) {
        this.toast("▼ Scrolled to Bottom");
        this._dispatch({ action: "scroll-bottom", transcript: rawText });
        return;
      }

      // 3. Direct Site Navigation
      // Matches "go to youtube", "open youtube", "visit wikipedia", "youtube"
      const navMatch = text.match(/(?:go to|open|visit|launch)\s+([a-z0-9_.-]+)/i);
      const siteWord = navMatch ? navMatch[1] : null;

      for (const [siteKey, siteUrl] of Object.entries(KNOWN_SITES)) {
        if (
          (siteWord && siteWord.includes(siteKey)) ||
          text.includes(`go to ${siteKey}`) ||
          text.includes(`open ${siteKey}`) ||
          text === siteKey
        ) {
          this.toast(`🌐 Opening ${siteKey}...`, 2500);
          this._dispatch({ action: "navigate", url: siteUrl, transcript: rawText });
          return;
        }
      }

      if (siteWord && siteWord.includes(".")) {
        this.toast(`🌐 Opening ${siteWord}...`, 2500);
        this._dispatch({ action: "navigate", url: `https://${siteWord}`, transcript: rawText });
        return;
      }

      // 4. Search Queries (Contextual Site Search vs. Global Web Search)
      // Explicit global search: "google [query]" or "web search [query]"
      const googleMatch = text.match(/^(?:google|web search)\s+(.+)/i);
      if (googleMatch) {
        const query = googleMatch[1].trim();
        this._dispatch({ action: "search", query, forceWeb: true, transcript: rawText });
        return;
      }

      // Contextual search: "search for [query]", "search this for [query]", "search here for [query]", "search [query]", "find [query]"
      const searchMatch = text.match(/(?:search for|search this for|search here for|search here|search this|search|find)\s+(.+)/i);
      if (searchMatch) {
        const query = searchMatch[1].trim();
        this._dispatch({ action: "search", query, forceWeb: false, transcript: rawText });
        return;
      }

      // 5. Browser History & Tab Control
      if (text.includes("back") || text === "go back") {
        this.toast("◀ Going Back");
        this._dispatch({ action: "history-back", transcript: rawText });
        return;
      }

      if (text.includes("forward") || text === "go forward") {
        this.toast("▶ Going Forward");
        this._dispatch({ action: "history-forward", transcript: rawText });
        return;
      }

      if (text.includes("reload") || text.includes("refresh")) {
        this.toast("⟳ Reloading Page");
        this._dispatch({ action: "reload", transcript: rawText });
        return;
      }

      // 6. Audio Read-Aloud Control
      if (
        text.includes("read aloud") ||
        text.includes("read article") ||
        text.includes("read page") ||
        text.includes("start reading")
      ) {
        this.toast("🔊 Starting Read-Aloud");
        this._dispatch({ action: "read-aloud", transcript: rawText });
        return;
      }

      if (
        text.includes("stop reading") ||
        text.includes("stop audio") ||
        text.includes("quiet") ||
        text.includes("silence")
      ) {
        this.toast("🔇 Stopped Reading");
        this._dispatch({ action: "stop-audio", transcript: rawText });
        return;
      }

      // 7. Instant Capture & Share Actions
      if (text.includes("screenshot") || text.includes("capture")) {
        this.toast("📸 Taking Screenshot...");
        this._dispatch({ action: "screenshot", transcript: rawText });
        return;
      }

      if (text.includes("share") || text.includes("copy link")) {
        this.toast("↗ Sharing Link");
        this._dispatch({ action: "share", transcript: rawText });
        return;
      }

      if (text.includes("like") || text.includes("thumbs up")) {
        this.toast("👍 Liking item");
        this._dispatch({ action: "like", transcript: rawText });
        return;
      }

      // 7.5 AAC Quick-Reply Speech Dock Hooks
      if (
        text.includes("open talk") ||
        text.includes("quick talk") ||
        text.includes("open aac") ||
        text.includes("quick speech") ||
        text === "talk" ||
        text === "aac"
      ) {
        this.toast("🗣️ Opening Quick Talk...");
        this._dispatch({ action: "open-aac", transcript: rawText });
        return;
      }

      if (
        text.includes("close talk") ||
        text.includes("close aac") ||
        text.includes("close menu")
      ) {
        this.toast("🔙 Closing Quick Talk");
        this._dispatch({ action: "close-aac", transcript: rawText });
        return;
      }

      // 8. Numbered Link Hints Hooks (Accent & Phonetic Tolerant)
      // Handles: "show links", "show lyncx", "show lynx", "show linx", "show numbers", "hints", "numbers", etc.
      const hasLinkPhonetic =
        text.includes("link") ||
        text.includes("lyncx") ||
        text.includes("lynx") ||
        text.includes("linx") ||
        text.includes("lincs") ||
        text.includes("lenk") ||
        text.includes("number") ||
        text.includes("hint");

      const hasShowAction =
        text.includes("show") ||
        text.includes("view") ||
        text.includes("display") ||
        text.includes("see") ||
        text.includes("open");

      if (
        (hasShowAction && hasLinkPhonetic) ||
        text === "links" ||
        text === "link" ||
        text === "lynx" ||
        text === "lyncx" ||
        text === "linx" ||
        text === "numbers" ||
        text === "hints"
      ) {
        this.toast("🔗 Showing link numbers...");
        this._dispatch({ action: "show-links", transcript: rawText });
        return;
      }

      if (
        text.includes("hide") ||
        text.includes("cancel") ||
        text.includes("clear") ||
        text.includes("close")
      ) {
        this.toast("🔗 Hiding link hints");
        this._dispatch({ action: "hide-links", transcript: rawText });
        return;
      }

      // Check for link click commands (e.g. "click 4", "clique 4", "quick 4", "lyncx 4", "number 5", "4")
      let targetNumber = null;

      const digitMatch = text.match(/(?:click|clique|quick|klick|pick|press|select|open|number|link|lynx|lyncx)?\s*(\b\d{1,2}\b)/i);
      if (digitMatch) {
        targetNumber = parseInt(digitMatch[1], 10);
      }

      if (!targetNumber) {
        for (const [word, val] of Object.entries(WORD_TO_NUMBER)) {
          if (
            text === word ||
            text.endsWith(` ${word}`) ||
            text.startsWith(`${word} `) ||
            text.includes(`click ${word}`) ||
            text.includes(`number ${word}`) ||
            text.includes(`link ${word}`) ||
            text.includes(`lynx ${word}`) ||
            text.includes(`lyncx ${word}`)
          ) {
            targetNumber = val;
            break;
          }
        }
      }

      if (targetNumber !== null && !isNaN(targetNumber)) {
        this._dispatch({ action: "click-link", number: targetNumber, transcript: rawText });
        return;
      }

      // Fallback: Show user what was heard so they know microphone captured it!
      this.toast(`🎙️ Heard: "${rawText}"`, 2200);
    }

    _dispatch(commandData) {
      if (typeof this.onCommandCallback === "function") {
        this.onCommandCallback(commandData);
      }
    }
  }

  NS.VoiceEngine = VoiceEngine;
})();
