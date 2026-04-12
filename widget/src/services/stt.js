/**
 * Speech-to-Text service using the Web Speech API.
 *
 * ── Wake-word mode (background) ──────────────────────────────────────────────
 *   startWakeWord(word, cb) — always-on, single-utterance loop that restarts
 *   itself silently after every silence timeout / error.  Pauses automatically
 *   while conversation mode is running and resumes after it ends.
 *   stopWakeWord() — disarm it (e.g. when the widget is open).
 *
 * ── Conversation mode (foreground, continuous) ────────────────────────────────
 *   start()  — begins a CONTINUOUS recognition session that NEVER stops by
 *               itself.  onResult fires for every final utterance; the
 *               microphone stays open between turns.  If Chrome's internal
 *               timeout fires onend unexpectedly, the session auto-restarts.
 *   stop()   — explicit stop (session close / "stop" command).
 *
 *   onSpeechStart — fires the instant the browser detects speech, BEFORE the
 *   full transcript is ready.  Widget uses this for near-instant TTS interrupt.
 */
export class SpeechToText {
  constructor({ onResult, onError, onStateChange, onSpeechStart, lang = 'en-US' }) {
    this.onResult      = onResult
    this.onError       = onError
    this.onStateChange = onStateChange
    this.onSpeechStart = onSpeechStart
    this.lang          = lang

    this._recognition = null
    this._active      = false   // true while conversation recognition is running

    this._wakeRec         = null
    this._wakeEnabled     = false
    this._wakeWord        = null
    this._onWakeTriggered = null
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  // ── Wake-word mode ────────────────────────────────────────────────────────

  startWakeWord(wakeWord, onTriggered) {
    if (!this.isSupported()) return
    this._wakeWord        = wakeWord.toLowerCase()
    this._onWakeTriggered = onTriggered
    this._wakeEnabled     = true
    this._runWakeListener()
  }

  stopWakeWord() {
    this._wakeEnabled = false
    this._abortWake()
  }

  _abortWake() {
    if (this._wakeRec) {
      try { this._wakeRec.abort() } catch (_) {}
      this._wakeRec = null
    }
  }

  _runWakeListener() {
    if (!this._wakeEnabled) return
    if (this._active)       return   // conversation is live — will resume in onend
    if (this._wakeRec)      return   // already running

    const SR  = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang           = this.lang
    rec.continuous     = false
    rec.interimResults = false
    this._wakeRec = rec

    rec.onresult = (event) => {
      const text = (event.results[0]?.[0]?.transcript || '').toLowerCase().trim()
      console.log('[widget:stt] Wake check:', text)
      if (text.includes(this._wakeWord)) {
        this._wakeEnabled = false
        this._wakeRec     = null
        console.log('[widget:stt] Wake word detected!')
        this._onWakeTriggered?.()
      }
    }

    rec.onerror = (event) => {
      this._wakeRec = null
      if (event.error === 'aborted' || !this._wakeEnabled) return
      setTimeout(() => this._runWakeListener(), 400)
    }

    rec.onend = () => {
      this._wakeRec = null
      if (this._wakeEnabled && !this._active) {
        setTimeout(() => this._runWakeListener(), 100)
      }
    }

    try {
      rec.start()
      console.log('[widget:stt] Wake word listening for:', this._wakeWord)
    } catch (e) {
      this._wakeRec = null
      if (this._wakeEnabled) setTimeout(() => this._runWakeListener(), 1000)
    }
  }

  // ── Conversation mode ─────────────────────────────────────────────────────

  start() {
    if (!this.isSupported()) {
      this.onError?.('Speech recognition is not supported in this browser. Please use Chrome or Edge.')
      return
    }
    if (this._active) return   // already running — no-op

    // Pause wake-word while conversation is active
    this._abortWake()
    this._startConversation()
  }

  _startConversation() {
    if (this._active) return

    const SR  = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang           = this.lang
    rec.continuous     = true    // ← stay open between turns
    rec.interimResults = false   // only final results

    rec.onstart = () => {
      this._active = true
      this.onStateChange?.('listening')
      console.log('[widget:stt] Continuous conversation started')
    }

    // Fires the moment voice activity is detected — used for instant TTS interrupt
    rec.onspeechstart = () => {
      console.log('[widget:stt] Speech activity detected')
      this.onSpeechStart?.()
    }

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const transcript = event.results[i][0].transcript
          const confidence = event.results[i][0].confidence
          console.log(`[widget:stt] "${transcript}" (${confidence?.toFixed(2)})`)
          this.onResult?.(transcript)
        }
      }
    }

    rec.onerror = (event) => {
      // In continuous mode, 'no-speech' is just a pause — ignore silently
      if (event.error === 'no-speech' || event.error === 'aborted') return

      const messages = {
        'not-allowed':   'Microphone access was denied. Please allow microphone access and try again.',
        'network':       'Network error during speech recognition. Please check your connection.',
        'audio-capture': 'No microphone found. Please connect a microphone and try again.',
      }
      if (messages[event.error]) this.onError?.(messages[event.error])
    }

    rec.onend = () => {
      // onend fires only when explicitly stopped OR after a Chrome internal timeout.
      // If _active is still true, this was unexpected — restart immediately.
      if (this._active) {
        this._recognition = null
        console.log('[widget:stt] Unexpected end — restarting')
        setTimeout(() => {
          if (this._active) this._startConversation()
        }, 150)
      } else {
        // Explicitly stopped via stop()
        this.onStateChange?.('idle')
        // Resume wake-word listener if armed
        if (this._wakeEnabled) {
          setTimeout(() => this._runWakeListener(), 100)
        }
      }
    }

    this._recognition = rec
    try {
      rec.start()
    } catch (err) {
      this._active = false
      console.error('[widget:stt] Failed to start:', err)
      this.onError?.('Failed to start microphone. Please try again.')
      this.onStateChange?.('idle')
    }
  }

  stop() {
    this._active = false
    if (this._recognition) {
      try { this._recognition.stop() } catch (_) {}
      this._recognition = null
    }
  }

  isActive() { return this._active }
}
