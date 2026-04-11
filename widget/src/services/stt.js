/**
 * Speech-to-Text service using the Web Speech API.
 * Browser-native, no backend required for transcription.
 *
 * Supported browsers: Chrome, Edge (full support), Safari (partial), Firefox (not supported).
 */
export class SpeechToText {
  constructor({ onResult, onError, onStateChange, lang = 'en-US' }) {
    this.onResult = onResult
    this.onError = onError
    this.onStateChange = onStateChange
    this.lang = lang
    this.recognition = null
    this._active = false
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  start() {
    if (!this.isSupported()) {
      this.onError?.('Speech recognition is not supported in this browser. Please use Chrome or Edge.')
      return
    }

    if (this._active) return

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    this.recognition = new SpeechRecognition()

    this.recognition.lang = this.lang
    this.recognition.continuous = false        // Single utterance per press
    this.recognition.interimResults = false    // Only fire on final result

    this.recognition.onstart = () => {
      this._active = true
      this.onStateChange?.('listening')
      console.log('[widget:stt] Listening...')
    }

    this.recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      const confidence = event.results[0][0].confidence
      console.log(`[widget:stt] Transcript: "${transcript}" (confidence: ${confidence.toFixed(2)})`)
      this.onResult?.(transcript)
    }

    this.recognition.onerror = (event) => {
      this._active = false
      console.error('[widget:stt] Error:', event.error)

      const errorMessages = {
        'not-allowed': 'Microphone access was denied. Please allow microphone access and try again.',
        'no-speech': 'No speech detected. Please try speaking again.',
        'network': 'Network error during speech recognition. Please check your connection.',
        'audio-capture': 'No microphone found. Please connect a microphone and try again.',
        'aborted': null, // User-initiated, not an error
      }

      const msg = errorMessages[event.error]
      if (msg !== null) {
        this.onError?.(msg || `Speech recognition error: ${event.error}`)
      }
      this.onStateChange?.('idle')
    }

    this.recognition.onend = () => {
      this._active = false
      this.onStateChange?.('idle')
      console.log('[widget:stt] Recognition ended')
    }

    try {
      this.recognition.start()
    } catch (err) {
      this._active = false
      console.error('[widget:stt] Failed to start:', err)
      this.onError?.('Failed to start microphone. Please try again.')
      this.onStateChange?.('idle')
    }
  }

  stop() {
    if (this.recognition && this._active) {
      this.recognition.stop()
    }
    this._active = false
  }

  isActive() {
    return this._active
  }
}
