import { h } from 'preact'
import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { FloatingButton } from './components/FloatingButton.jsx'
import { ChatPanel } from './components/ChatPanel.jsx'
import { StatusIndicator } from './components/StatusIndicator.jsx'
import { WidgetWebSocket, observeDomChanges, getPageErrors } from './services/websocket.js'
import { SpeechToText } from './services/stt.js'
import { TextToSpeech } from './services/tts.js'
import { executeDomActions } from './services/domActions.js'

/**
 * Root widget component.
 *
 * Activation: say "access" (wake word) or click the mic button.
 *
 * Hands-free loop once a session is live:
 *   TTS ends → auto-start STT → user speaks → processing → TTS speaks → …
 *   User can interrupt TTS by speaking — onspeechstart immediately stops it.
 *
 * Connection order:
 *   1. Wake word / mic click
 *      → POST /api/session  → WS connect  → send page_init
 *      → server speaks greeting via TTS
 *      → after greeting TTS ends, auto-start STT
 *   2. STT result
 *      → send process_speech  → agent_response: TTS + DOM actions
 *      → after TTS ends, auto-start STT again
 *   3. Ping every 20s (inside WidgetWebSocket)
 *   4. Widget closed
 *      → cleanup session/WS  → re-arm wake-word listener
 *
 * ── Critical refs ─────────────────────────────────────────────────────────────
 *   isExecutingRef  — true while an agent_response is being processed.
 *                     Cleared BEFORE tts.speak() so only DOM actions are guarded,
 *                     not TTS playback.  New agent_responses are still dropped while
 *                     this is true.  Cleared by _unblock() on any exit path.
 *   isTTSPlayingRef — true from TTS onStart to onEnd.  Used to filter STT echo.
 *   ttsPendingRef   — true from tts.speak() call to TTS onStart.  Covers the
 *                     setTimeout(0) gap inside TTS where isTTSPlayingRef is not yet
 *                     set.  Combined with isTTSPlayingRef for echo filtering and
 *                     interrupt detection.
 */
export function Widget({ config }) {
  const [isOpen, setIsOpen] = useState(false)
  const [status, setStatus] = useState('idle')
  const [messages, setMessages] = useState([])
  const [errorMessage, setErrorMessage] = useState(null)

  const wsRef                 = useRef(null)
  const sttRef                = useRef(null)
  const ttsRef                = useRef(null)
  const sessionIdRef          = useRef(null)    // set once, lives for the tab session
  const domObserverRef        = useRef(null)    // teardown fn returned by observeDomChanges
  const responseTimeoutRef    = useRef(null)
  const isTTSPlayingRef       = useRef(false)   // true while TTS audio is audible
  const ttsPendingRef         = useRef(false)   // true from speak() call until TTS onStart
  const pendingFailuresRef    = useRef([])       // action failures queued to send after TTS ends
  const consecutiveFailuresRef = useRef(0)      // how many feedback rounds in a row without user input
  const isExecutingRef        = useRef(false)   // true while an agent_response is being acted on
  const wasReconnectingRef    = useRef(false)   // true between 'reconnecting' and next 'connected'

  const addMessage = useCallback((role, text) => {
    setMessages((prev) => [...prev, { role, text, timestamp: Date.now() }])
  }, [])

  // ── _unblock: release all execution locks on any exit path ────────────────
  // Called from: timeout, error handler, reconnect handler, stop command,
  // and tts onEnd/onError.  Never call setStatus here — callers do that.
  const _unblock = useCallback(() => {
    isExecutingRef.current  = false
    isTTSPlayingRef.current = false
    ttsPendingRef.current   = false
    pendingFailuresRef.current = []
  }, [])

  // ── Wake-word re-armer ────────────────────────────────────────────────────
  const restartWakeWord = useCallback(() => {
    sttRef.current?.startWakeWord('access', async () => {
      console.log('[widget] Wake word "access" detected')
      setIsOpen(true)
      setErrorMessage(null)
      if (sessionIdRef.current) {
        // Session already live — just ensure we're listening
        if (!isExecutingRef.current) sttRef.current?.start()
        return
      }
      setStatus('processing')
      try {
        await initialize()   // eslint-disable-line no-use-before-define
      } catch (err) {
        console.error('[widget] Wake word init error:', err)
        sessionIdRef.current = null
        domObserverRef.current?.()
        domObserverRef.current = null
        wsRef.current?.disconnect()
        wsRef.current = null
        _unblock()
        setStatus('error')
        setErrorMessage(err.message)
        restartWakeWord()   // re-arm after failure
      }
    })
  }, []) // stable — all refs

  // ── Response timeout ──────────────────────────────────────────────────────
  // Raised to 30s to accommodate slow LLM responses.
  const _startResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current) clearTimeout(responseTimeoutRef.current)
    responseTimeoutRef.current = setTimeout(() => {
      console.warn('[widget] Response timeout — resetting to idle')
      _unblock()
      setStatus('idle')
      setErrorMessage('No response from server. Please try again.')
      setTimeout(() => setErrorMessage(null), 4000)
      // Resume STT so user can try again without clicking
      if (sessionIdRef.current) {
        setTimeout(() => sttRef.current?.start(), 200)
      }
    }, 30000)
  }, [_unblock])

  const _clearResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }
  }, [])

  // ── Initialize STT + TTS on mount (no session needed yet) ────────────────

  useEffect(() => {
    ttsRef.current = new TextToSpeech({
      onStart: () => {
        ttsPendingRef.current   = false   // TTS is now audible — pending gap closed
        isTTSPlayingRef.current = true
        setStatus('speaking')
      },
      onEnd:   () => {
        isTTSPlayingRef.current = false
        ttsPendingRef.current   = false
        isExecutingRef.current  = false

        // If action failures were queued while TTS was playing, send them to
        // the LLM now so it can acknowledge the error and guide the user.
        const failures = pendingFailuresRef.current
        if (failures.length > 0) {
          pendingFailuresRef.current = []
          setStatus('processing')
          consecutiveFailuresRef.current += 1
          if (consecutiveFailuresRef.current >= 3) {
            consecutiveFailuresRef.current = 0
            wsRef.current?.sendGiveUp(failures, sessionIdRef.current)
          } else {
            wsRef.current?.sendActionFeedback(failures, sessionIdRef.current)
          }
          _startResponseTimeout()
        } else {
          consecutiveFailuresRef.current = 0
          // Persistent listening: STT onstart will flip status to 'listening'
          if (sessionIdRef.current) {
            sttRef.current?.start()   // no-op if already running (continuous mode)
          } else {
            setStatus('idle')
          }
        }
      },
      onError: (err) => {
        console.error('[widget] TTS error:', err)
        _unblock()
        // Auto-restart listening even after a TTS error
        if (sessionIdRef.current) {
          sttRef.current?.start()
        } else {
          setStatus('idle')
        }
      },
    })

    sttRef.current = new SpeechToText({
      lang: config.lang,
      // ── Interrupt: stop TTS the moment speech is detected ─────────────────
      // onspeechstart fires before the full transcript arrives, giving
      // near-instant interruption of the current agent response.
      // Clear BOTH TTS flags FIRST so the onResult that follows doesn't look
      // like echo, and so we don't block the incoming result.
      onSpeechStart: () => {
        if (isTTSPlayingRef.current || ttsPendingRef.current) {
          isTTSPlayingRef.current = false
          ttsPendingRef.current   = false
          ttsRef.current?.stop()
        }
      },
      onStateChange: (s) => {
        if (s === 'listening') setStatus('listening')
        // 'idle' is handled implicitly — caller sets status as needed
      },
      onResult: (transcript) => {
        // Drop results that arrive while TTS is still playing or about to start — they're echo.
        // onspeechstart clears both flags before this fires when the user genuinely speaks.
        if (isTTSPlayingRef.current || ttsPendingRef.current) return

        // ── Immediate stop command ────────────────────────────────────────────
        const lower = transcript.toLowerCase().trim()
        const isStopCommand = /\b(stop|cancel|quit|pause|halt)\b/.test(lower)
        if (isStopCommand) {
          ttsRef.current?.stop()
          _clearResponseTimeout()
          _unblock()
        }

        consecutiveFailuresRef.current = 0  // new user input resets the retry counter
        isExecutingRef.current = false      // allow the new response to execute
        console.log('[widget] STT result:', transcript)
        addMessage('user', transcript)
        setStatus('processing')
        setErrorMessage(null)
        wsRef.current?.sendSpeech(transcript, sessionIdRef.current)
        _startResponseTimeout()
      },
      onError: (msg) => {
        // 'no-speech' is a silence timeout, not a real error.
        // In persistent mode (session active), silently restart listening.
        if (msg === 'no-speech' && sessionIdRef.current) {
          setTimeout(() => sttRef.current?.start(), 200)
          return
        }
        console.error('[widget] STT error:', msg)
        setStatus('error')
        setErrorMessage(msg)
        setTimeout(() => { setStatus('idle'); setErrorMessage(null) }, 3500)
      },
    })

    // Start wake-word listener so user can say "access" to open the widget
    restartWakeWord()

    return () => {
      sttRef.current?.stop()
      sttRef.current?.stopWakeWord()
      ttsRef.current?.stop()
    }
  }, [config, restartWakeWord, _unblock, _startResponseTimeout, _clearResponseTimeout])

  // ── REST helpers ─────────────────────────────────────────────────────────

  async function createSession() {
    const res = await fetch(`${config.httpBaseUrl}/api/session`, { method: 'POST' })
    if (!res.ok) throw new Error(`POST /api/session failed: ${res.status}`)
    const data = await res.json()
    return data.session_id
  }

  async function deleteSession(sessionId) {
    try {
      await fetch(`${config.httpBaseUrl}/api/session/${sessionId}`, { method: 'DELETE' })
      console.log('[widget] Session deleted:', sessionId)
    } catch (err) {
      console.warn('[widget] Could not delete session:', err)
    }
  }

  // ── WebSocket setup ──────────────────────────────────────────────────────

  function setupWebSocket(sessionId) {
    const ws = new WidgetWebSocket(config.wsUrl)
    ws.setSessionId(sessionId)
    wsRef.current = ws

    ws.on('agent_response', async (msg) => {
      _clearResponseTimeout()

      // Drop this response if we're already executing another one.
      if (isExecutingRef.current) {
        console.warn('[widget] Dropping agent_response — actions already in progress')
        return
      }
      isExecutingRef.current = true

      let failures = []
      if (Array.isArray(msg.actions) && msg.actions.length > 0) {
        console.log('[widget] Executing DOM actions:', msg.actions)
        failures = await executeDomActions(msg.actions)
        // Also capture any page-level validation errors the site showed in
        // response to our actions (toasts, aria-invalid, etc.)
        const pageErrs = getPageErrors()
        if (pageErrs.length > 0) failures = [...failures, ...pageErrs]
        if (failures.length > 0) console.warn('[widget] Issues after actions:', failures)
      }

      // Release execution lock BEFORE TTS starts so that if TTS errors or the
      // watchdog fires, onEnd won't have to worry about isExecutingRef being stuck.
      // We still guard new agent_responses via isTTSPlayingRef | ttsPendingRef below.
      // (A concurrent agent_response is already blocked by isExecutingRef being true
      //  during the DOM action phase above — it's safe to release it now.)
      isExecutingRef.current = false

      if (msg.speech) {
        addMessage('agent', msg.speech)
        // Queue failures so onEnd can send them after TTS finishes speaking.
        if (failures.length > 0) {
          pendingFailuresRef.current = failures
        } else {
          consecutiveFailuresRef.current = 0
        }
        // Set ttsPendingRef BEFORE speak() so the setTimeout(0) gap is covered.
        ttsPendingRef.current = true
        ttsRef.current?.speak(msg.speech)
      } else {
        if (failures.length > 0) {
          setStatus('processing')
          consecutiveFailuresRef.current += 1
          if (consecutiveFailuresRef.current >= 3) {
            consecutiveFailuresRef.current = 0
            wsRef.current?.sendGiveUp(failures, sessionIdRef.current)
          } else {
            wsRef.current?.sendActionFeedback(failures, sessionIdRef.current)
          }
          _startResponseTimeout()
        } else {
          consecutiveFailuresRef.current = 0
          setStatus('idle')
        }
      }
    })

    ws.on('error', (msg) => {
      _clearResponseTimeout()
      console.error('[widget] Backend error:', msg.error)
      _unblock()
      setStatus('idle')
      setErrorMessage(msg.error || 'Something went wrong. Please try again.')
      setTimeout(() => setErrorMessage(null), 4000)
      // Resume STT so user can try again
      if (sessionIdRef.current) {
        setTimeout(() => sttRef.current?.start(), 300)
      }
    })

    ws.on('connected', () => {
      // Fires on both first connect (handled by initialize()) and on auto-reconnect.
      // Only act on reconnect — first connect is fully orchestrated by initialize().
      if (!wasReconnectingRef.current) return
      wasReconnectingRef.current = false
      console.log('[widget] Reconnected — resuming session')
      setErrorMessage(null)
      _clearResponseTimeout()
      _unblock()
      // Re-send page_init so the backend re-greets and we resume from a clean state.
      if (sessionIdRef.current) {
        ws.sendPageInit(sessionIdRef.current)
        // STT will restart automatically after the greeting TTS ends (onEnd handler)
      }
    })

    ws.on('disconnected', () => {
      sttRef.current?.stop()
      ttsRef.current?.stop()
      _clearResponseTimeout()
      _unblock()
      setStatus('disconnected')
    })

    ws.on('reconnecting', ({ attempt }) => {
      wasReconnectingRef.current = true
      setStatus('disconnected')
      setErrorMessage(`Connection lost. Reconnecting... (${attempt}/5)`)
    })

    ws.on('max_reconnect_reached', () => {
      wasReconnectingRef.current = false
      sttRef.current?.stop()
      ttsRef.current?.stop()
      _unblock()
      setStatus('error')
      setErrorMessage('Unable to reconnect. Click the button to try again.')
    })

    return ws
  }

  // ── First-click initialization ────────────────────────────────────────────

  async function initialize() {
    setStatus('processing')

    // Step 1: create session
    let sessionId
    try {
      sessionId = await createSession()
      sessionIdRef.current = sessionId
      console.log('[widget] Session created:', sessionId)
    } catch (err) {
      console.error('[widget] Session creation failed:', err)
      throw new Error('Could not reach the server. Is the backend running?')
    }

    // Step 2: connect WebSocket
    const ws = setupWebSocket(sessionId)
    try {
      await ws.connect()
      console.log('[widget] WebSocket open')
    } catch (err) {
      console.error('[widget] WebSocket connect failed:', err)
      throw new Error('WebSocket connection failed. Is the backend running?')
    }

    // Step 3: send page_init — server responds with greeting agent_response
    ws.sendPageInit(sessionId)
    console.log('[widget] page_init sent')

    // Step 4: start watching the host page for DOM changes
    domObserverRef.current = observeDomChanges(
      (pageContext) => {
        if (isExecutingRef.current) return
        ws.sendUpdateContext(pageContext, sessionId)
      },
      (errors) => {
        if (!wsRef.current || !sessionIdRef.current) return
        console.log('[widget] Organic page error — sending feedback to LLM')
        setStatus('processing')
        wsRef.current.sendActionFeedback(errors, sessionIdRef.current)
        _startResponseTimeout()
      }
    )
  }

  // ── Mic button handler ───────────────────────────────────────────────────

  async function handleFabClick() {
    // Speaking → interrupt TTS; reset flags so STT can listen immediately.
    // onEnd from tts.stop() fires with settle(false) which calls _unblock indirectly
    // via TTS onEnd → isTTSPlayingRef = false etc.  But we also set ttsPendingRef
    // false here so echo filter is lifted before the next STT result arrives.
    if (status === 'speaking') {
      ttsPendingRef.current   = false
      isTTSPlayingRef.current = false
      ttsRef.current?.stop()
      // onEnd will NOT fire (stop() is silent) — manually start STT
      setTimeout(() => {
        if (sessionIdRef.current) sttRef.current?.start()
        else setStatus('idle')
      }, 50)
      return
    }

    // Processing → user wants to cancel; unblock and start listening
    if (status === 'processing') {
      _clearResponseTimeout()
      ttsRef.current?.stop()
      _unblock()
      setTimeout(() => {
        if (sessionIdRef.current) {
          sttRef.current?.start()
        } else {
          setStatus('idle')
        }
      }, 50)
      return
    }

    // Listening → manual pause (user wants to stop mic)
    if (status === 'listening') {
      sttRef.current?.stop()
      setStatus('idle')
      return
    }

    // After max_reconnect_reached or general error → allow full re-init
    if (status === 'error') {
      // Clear stale session state so initialize() runs fresh
      const oldSid = sessionIdRef.current
      sessionIdRef.current = null
      domObserverRef.current?.()
      domObserverRef.current = null
      if (wsRef.current) {
        wsRef.current.disconnect()
        wsRef.current = null
      }
      if (oldSid) deleteSession(oldSid).catch(() => {})
      _unblock()
      setErrorMessage(null)
      // Fall through to idle handling below
    }

    if (status !== 'idle' && status !== 'error') return

    if (!sttRef.current?.isSupported()) {
      setIsOpen(true)
      setErrorMessage('Voice input is not supported in this browser. Please use Chrome or Edge.')
      return
    }

    setIsOpen(true)
    setErrorMessage(null)

    // First click only (or after error reset): run the full initialization sequence
    let justInitialized = false
    if (!sessionIdRef.current) {
      try {
        await initialize()
        justInitialized = true
      } catch (err) {
        console.error('[widget] Init error:', err)
        sessionIdRef.current = null
        domObserverRef.current?.()
        domObserverRef.current = null
        wsRef.current?.disconnect()
        wsRef.current = null
        _unblock()
        setStatus('error')
        setErrorMessage(err.message)
        return
      }
    }

    // On first init: the greeting TTS will play, and ttsRef.onEnd will start STT.
    // On subsequent mic clicks: session is live, start listening immediately.
    if (!justInitialized) {
      sttRef.current?.start()
    }
  }

  // ── Close / cleanup ──────────────────────────────────────────────────────

  async function handleClose() {
    setIsOpen(false)
    _clearResponseTimeout()
    sttRef.current?.stop()
    ttsRef.current?.stop()
    _unblock()
    setStatus('idle')

    domObserverRef.current?.()
    domObserverRef.current = null

    const sid = sessionIdRef.current
    if (sid) {
      sessionIdRef.current = null
      await deleteSession(sid)
    }
    wsRef.current?.disconnect()
    wsRef.current = null

    restartWakeWord()
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div class={`vw-container vw-container--${config.position}`}>
      <ChatPanel
        messages={messages}
        isOpen={isOpen}
        onClose={handleClose}
        errorMessage={errorMessage}
      />
      <div class="vw-controls">
        <StatusIndicator status={status} />
        <FloatingButton status={status} isOpen={isOpen} onClick={handleFabClick} />
      </div>
    </div>
  )
}
