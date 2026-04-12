/**
 * Text-to-Speech service using the Web Speech Synthesis API.
 * Browser-native, no backend required.
 *
 * Key design decisions:
 *   - Every speak() call uses a per-utterance `settled` flag so onend/onerror
 *     can never both fire. Prevents double-calling onEnd which would restart
 *     STT twice and corrupt widget state.
 *   - stop() cancels synthesis AND marks any pending utterance as settled so
 *     a stale onerror('interrupted') from a previous speak() can't fire after
 *     a new one has already started.
 *   - A watchdog timer fires if onend never arrives (Chrome bug on long text)
 *     so isExecutingRef never gets permanently stuck.
 */
export class TextToSpeech {
  constructor({ onStart, onEnd, onError } = {}) {
    this.onStart = onStart
    this.onEnd   = onEnd
    this.onError = onError

    this._voices           = []
    this._preferredVoiceName = null
    this._voicesReady      = false

    // Per-utterance settle function — replaced on each speak() call.
    // Calling it more than once is a no-op (guarded by closure flag).
    this._settle      = null
    this._watchdog    = null

    this._loadVoices()
  }

  isSupported() {
    return !!window.speechSynthesis
  }

  _loadVoices() {
    if (!this.isSupported()) return
    const load = () => {
      this._voices      = window.speechSynthesis.getVoices()
      this._voicesReady = true
    }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
  }

  speak(text) {
    if (!this.isSupported()) {
      console.warn('[widget:tts] Speech synthesis not supported')
      this.onEnd?.()
      return
    }

    // Cancel any in-flight utterance and invalidate its callbacks.
    this._cancelCurrent()

    // Build a one-shot settle function for this utterance.
    // Whichever of onend / onerror / watchdog fires first wins; the rest no-op.
    let settled = false
    const settle = (isError, errMsg) => {
      if (settled) return
      settled    = true
      this._settle   = null
      clearTimeout(this._watchdog)
      this._watchdog = null

      if (isError) this.onError?.(errMsg)
      this.onEnd?.()
    }
    this._settle = () => settle(false)   // exposed so stop() can invalidate it

    // setTimeout(0) lets the cancel() above flush before the new utterance
    // queues, and also satisfies Chrome's user-gesture requirement when speaking
    // is triggered from a WebSocket message rather than a direct click.
    setTimeout(() => {
      // If stop() was called between speak() and this timeout, bail out.
      if (!this._settle) return

      const utterance  = new SpeechSynthesisUtterance(text)
      utterance.lang   = 'en-US'
      utterance.rate   = 1.0
      utterance.pitch  = 1.0
      utterance.volume = 1.0

      if (this._voicesReady && this._voices.length > 0) {
        const preferred =
          this._voices.find((v) => v.name === this._preferredVoiceName) ||
          this._voices.find((v) => v.lang === 'en-US' && v.localService)  ||
          this._voices.find((v) => v.lang.startsWith('en'))
        if (preferred) utterance.voice = preferred
      }

      utterance.onstart = () => {
        console.log('[widget:tts] Speaking:', text.substring(0, 60))
        this.onStart?.()

        // Watchdog: Chrome sometimes silently drops onend for long utterances.
        // Budget = estimated speaking time (600 ms/word) + 10 s buffer.
        const words       = text.split(/\s+/).length
        const budgetMs    = Math.max(15000, words * 600 + 10000)
        clearTimeout(this._watchdog)
        this._watchdog = setTimeout(() => {
          console.warn('[widget:tts] Watchdog — onend never fired, unblocking')
          window.speechSynthesis.cancel()
          settle(false)
        }, budgetMs)
      }

      utterance.onend = () => {
        console.log('[widget:tts] Done speaking')
        settle(false)
      }

      utterance.onerror = (event) => {
        const ignore = event.error === 'interrupted' || event.error === 'canceled'
        if (ignore) {
          settle(false)          // not a real error — just unblock cleanly
        } else {
          console.error('[widget:tts] Error:', event.error)
          settle(true, event.error)
        }
      }

      window.speechSynthesis.speak(utterance)
    }, 0)
  }

  /** Stop synthesis immediately.  Does NOT call onEnd — caller handles state. */
  stop() {
    this._cancelCurrent()
  }

  _cancelCurrent() {
    // Invalidate any pending settle so stale onend/onerror can't fire later.
    this._settle = null
    clearTimeout(this._watchdog)
    this._watchdog = null
    if (this.isSupported()) window.speechSynthesis.cancel()
  }

  setPreferredVoice(name) { this._preferredVoiceName = name }
  getVoices()             { return this._voices }
}
