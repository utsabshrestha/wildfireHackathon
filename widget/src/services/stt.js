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
 *
 * ── Race-condition guards ──────────────────────────────────────────────────────
 *   _starting  — set to true SYNCHRONOUSLY before rec.start() so a second
 *                start() call that arrives before onstart fires is a no-op.
 *   _generation — incremented on every new session so stale onresult / onend
 *                callbacks from a previous recognition instance are ignored.
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
    this._starting    = false   // true from rec.start() until onstart fires (or fails)
    this._generation  = 0       // bumped each session; old handlers self-invalidate

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
    if (this._active || this._starting) return   // conversation is live — will resume in onend
    if (this._wakeRec)      return               // already running

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
      if (this._wakeEnabled && !this._active && !this._starting) {
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
    // _starting is set synchronously in _startConversation before rec.start(),
    // so this guard catches both the "already started" and "starting up" cases.
    if (this._active || this._starting) return

    // Pause wake-word while conversation is active
    this._abortWake()
    this._startConversation()
  }

  _startConversation() {
    if (this._active || this._starting) return

    // Bump generation — all handlers for the previous instance will self-invalidate.
    const myGen = ++this._generation

    const SR  = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang           = this.lang
    rec.continuous     = true    // ← stay open between turns
    rec.interimResults = false   // only final results

    // Set _starting BEFORE rec.start() so a concurrent start() call is a no-op
    // even if it arrives before the async onstart fires.
    this._starting    = true
    this._recognition = rec

    rec.onstart = () => {
      if (myGen !== this._generation) return   // stale — a new session was started
      this._starting = false
      this._active   = true
      this.onStateChange?.('listening')
      console.log('[widget:stt] Continuous conversation started')
    }

    // Fires the moment voice activity is detected — used for instant TTS interrupt
    rec.onspeechstart = () => {
      if (myGen !== this._generation) return
      console.log('[widget:stt] Speech activity detected')
      this.onSpeechStart?.()
    }

    rec.onresult = (event) => {
      if (myGen !== this._generation) return
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
      if (myGen !== this._generation) return
      // In continuous mode, 'no-speech' is just a pause — ignore silently.
      // 'aborted' means we called stop() — also ignore; onend handles cleanup.
      if (event.error === 'no-speech' || event.error === 'aborted') return

      const messages = {
        'not-allowed':   'Microphone access was denied. Please allow microphone access and try again.',
        'audio-capture': 'No microphone found. Please connect a microphone and try again.',
        'network':       null,   // log it, but let onend restart rather than surfacing to user
      }

      if (event.error === 'network') {
        console.warn('[widget:stt] Network error — will restart if still active')
        return
      }

      if (messages[event.error]) this.onError?.(messages[event.error])
    }

    rec.onend = () => {
      if (myGen !== this._generation) return   // stale — ignore

      const wasActive = this._active || this._starting
      this._starting = false

      // onend fires only when explicitly stopped OR after a Chrome internal timeout.
      // If _active is still true, this was unexpected — restart immediately.
      if (this._active) {
        this._recognition = null
        console.log('[widget:stt] Unexpected end — restarting')
        setTimeout(() => {
          // Only restart if we're still the current generation and still want to listen
          if (myGen === this._generation && this._active) {
            this._active = false   // _startConversation checks this
            this._startConversation()
          }
        }, 300)
      } else {
        // Explicitly stopped via stop() — _active is already false
        this._recognition = null
        if (wasActive) {
          // Use microtask to ensure any in-flight state updates settle first
          Promise.resolve().then(() => this.onStateChange?.('idle'))
        }
        // Resume wake-word listener if armed
        if (this._wakeEnabled) {
          setTimeout(() => this._runWakeListener(), 100)
        }
      }
    }

    try {
      rec.start()
    } catch (err) {
      this._starting    = false
      this._active      = false
      this._recognition = null
      console.error('[widget:stt] Failed to start:', err)
      this.onError?.('Failed to start microphone. Please try again.')
      Promise.resolve().then(() => this.onStateChange?.('idle'))
    }
  }

  stop() {
    // Mark as stopped synchronously — prevents _startConversation restart loop
    this._active   = false
    this._starting = false
    if (this._recognition) {
      try { this._recognition.stop() } catch (_) {}
      // Don't null out _recognition here — onend will do it and must check generation
    }
  }

  isActive() { return this._active || this._starting }
}
