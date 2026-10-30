// Drishti 2.0 — AAC Quick-Reply Speech Engine (src/content/aac.js)
//
// Role:
//   • Provides rapid, gaze-dwellable communication phrases for non-verbal users (ALS, dysarthria).
//   • Speaks phrases aloud at full volume through laptop speakers via Web Speech API (SpeechSynthesis).
//   • Inserts text into active social media chat/comment boxes (Reddit, WhatsApp Web, Twitter/X, Facebook).

(() => {
  "use strict";

  const NS = (window.Drishti = window.Drishti || {});

  const AAC_PHRASES = [
    {
      id: "aac-yes",
      glyph: "✓",
      label: "Yes",
      text: "Yes, I agree.",
      hint: "Speak: Yes, I agree",
    },
    {
      id: "aac-no",
      glyph: "✕",
      label: "No",
      text: "No, thank you.",
      hint: "Speak: No, thank you",
    },
    {
      id: "aac-water",
      glyph: "💧",
      label: "Water",
      text: "I need water, please.",
      hint: "Speak: I need water, please",
    },
    {
      id: "aac-help",
      glyph: "🚨",
      label: "Help!",
      text: "Please call my caregiver, I need assistance urgently.",
      hint: "Emergency: Call Caregiver",
      alert: true,
    },
    {
      id: "aac-thanks",
      glyph: "🙏",
      label: "Thanks",
      text: "Thank you very much.",
      hint: "Speak: Thank you very much",
    },
    {
      id: "aac-close",
      glyph: "🔙",
      label: "Back",
      text: "",
      hint: "Return to navigation",
      isClose: true,
    },
  ];

  class AacEngine {
    constructor(options = {}) {
      this.options = options;
      this.toast = options.toast || ((m) => console.log("[Drishti AAC]", m));
      this.synth = window.speechSynthesis || null;
    }

    getPhrases() {
      return AAC_PHRASES;
    }

    speak(text) {
      if (!this.synth) {
        this.toast("SpeechSynthesis not supported in this browser.");
        return;
      }

      try {
        // Cancel any ongoing speech so quick replies play immediately
        if (this.synth.speaking) {
          this.synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95; // Slightly slower, highly intelligible cadence
        utterance.pitch = 1.0;
        utterance.volume = 1.0; // Maximum volume for caregiver hearing
        utterance.lang = navigator.language || "en-US";

        this.synth.speak(utterance);
      } catch (err) {
        console.warn("[Drishti AAC] Speech synthesis error:", err);
      }
    }

    insertIntoActiveInput(text) {
      if (!text) return false;

      const activeEl = document.activeElement;
      if (!activeEl) return false;

      // Handle standard inputs and textareas
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") {
        const proto =
          activeEl.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        const currentVal = activeEl.value || "";
        const nextVal = currentVal ? `${currentVal} ${text}` : text;

        if (setter) {
          setter.call(activeEl, nextVal);
        } else {
          activeEl.value = nextVal;
        }

        activeEl.dispatchEvent(new Event("input", { bubbles: true }));
        activeEl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      // Handle contenteditable fields (e.g. Facebook, Twitter, WhatsApp Web)
      if (activeEl.isContentEditable) {
        activeEl.focus();
        try {
          document.execCommand("insertText", false, ` ${text}`);
          return true;
        } catch (e) {
          console.warn("[Drishti AAC] ContentEditable insert error:", e);
        }
      }

      return false;
    }

    triggerPhrase(phraseId, sidebar) {
      const phrase = AAC_PHRASES.find((p) => p.id === phraseId);
      if (!phrase) return;

      if (phrase.isClose) {
        sidebar?.setAacOpen(false);
        this.toast("🔙 Returned to browser navigation", 2000);
        return;
      }

      // 1. Speak aloud loudly through speakers
      this.speak(phrase.text);

      // 2. Type into active chat input if focused
      const typed = this.insertIntoActiveInput(phrase.text);

      // 3. User feedback
      const msg = typed
        ? `🗣️ Spoken & Typed: "${phrase.text}"`
        : `🗣️ Spoken: "${phrase.text}"`;

      this.toast(msg, 3200);
    }
  }

  NS.AAC_PHRASES = AAC_PHRASES;
  NS.AacEngine = AacEngine;
})();
