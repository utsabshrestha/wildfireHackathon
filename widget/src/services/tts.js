/**
 * Text-to-Speech service using the Web Speech Synthesis API.
 * Browser-native, no backend required.
 */
export class TextToSpeech {
  constructor({ onStart, onEnd, onError } = {}) {
    this.onStart = onStart
    this.onEnd = onEnd
    this.onError = onError
    this._voices = []
    this._preferredVoiceName = null
    this._voicesReady = false
    this._loadVoices()
  }

  isSupported() {
    return !!window.speechSynthesis
  }

  _loadVoices() {
    if (!this.isSupported()) return

    const load = () => {
      this._voices = window.speechSynthesis.getVoices()
      this._voicesReady = true
    }

    // Voices may already be loaded
    load()

    // Chrome loads voices async — listen for the event
    window.speechSynthesis.addEventListener('voiceschanged', load)
  }

  /**
   * Speak the given text aloud.
   * @param {string} text
   */
  speak(text) {
    if (!this.isSupported()) {
      console.warn('[widget:tts] Speech synthesis not supported')
      this.onEnd?.()
      return
    }

    // Cancel any current speech
    window.speechSynthesis.cancel()

    // Use setTimeout(0) to avoid Chrome's user-gesture restriction when
    // speaking is triggered from a WebSocket message (not a direct click).
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text)

      utterance.lang = 'en-US'
      utterance.rate = 1.0
      utterance.pitch = 1.0
      utterance.volume = 1.0

      // Try to use a natural-sounding voice
      if (this._voicesReady && this._voices.length > 0) {
        const preferred =
          this._voices.find((v) => v.name === this._preferredVoiceName) ||
          this._voices.find((v) => v.lang === 'en-US' && v.localService) ||
          this._voices.find((v) => v.lang.startsWith('en'))
        if (preferred) utterance.voice = preferred
      }

      utterance.onstart = () => {
        console.log('[widget:tts] Speaking:', text.substring(0, 50) + '...')
        this.onStart?.()
      }

      utterance.onend = () => {
        console.log('[widget:tts] Done speaking')
        this.onEnd?.()
      }

      utterance.onerror = (event) => {
        // 'interrupted' is not really an error — it happens when we cancel()
        if (event.error !== 'interrupted' && event.error !== 'canceled') {
          console.error('[widget:tts] Error:', event.error)
          this.onError?.(event.error)
        }
        this.onEnd?.()
      }

      window.speechSynthesis.speak(utterance)
    }, 0)
  }

  /**
   * Stop any current speech immediately.
   */
  stop() {
    if (this.isSupported()) {
      window.speechSynthesis.cancel()
    }
  }

  /**
   * Set a preferred voice by name.
   * @param {string} voiceName
   */
  setPreferredVoice(voiceName) {
    this._preferredVoiceName = voiceName
  }

  /**
   * Get all available voices.
   * @returns {SpeechSynthesisVoice[]}
   */
  getVoices() {
    return this._voices
  }
}
