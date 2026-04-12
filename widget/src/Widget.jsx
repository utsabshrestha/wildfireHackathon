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
 * Exact connection order:
 *   1. User clicks mic (first time)
 *      → POST /api/session           → store session_id
 *      → WS connect                  → no message sent on open
 *      → send page_init              → server sends greeting agent_response
 *      → speak greeting via TTS
 *      → start STT (user can now speak)
 *   2. STT result
 *      → send process_speech (latest page_context)
 *      → server sends agent_response: speak speech, execute actions
 *   3. Ping every 20s (handled inside WidgetWebSocket)
 *   4. Widget closed
 *      → stop STT/TTS, DELETE /api/session, close WS
 */
export function Widget({ config }) {
  const [isOpen, setIsOpen] = useState(false)
  const [status, setStatus] = useState('idle')
  const [messages, setMessages] = useState([])
  const [errorMessage, setErrorMessage] = useState(null)

  const wsRef = useRef(null)
  const sttRef = useRef(null)
  const ttsRef = useRef(null)
  const sessionIdRef = useRef(null)    // set once, lives for the tab session
  const domObserverRef = useRef(null)  // teardown fn returned by observeDomChanges
  const responseTimeoutRef = useRef(null)
  const pendingFailuresRef = useRef([]) // action failures queued to send after TTS ends

  const addMessage = useCallback((role, text) => {
    setMessages((prev) => [...prev, { role, text, timestamp: Date.now() }])
  }, [])

  // ── Response timeout ──────────────────────────────────────────────────────
  // Started whenever we send speech and are waiting for a backend reply.
  // Clears on agent_response or backend error. Resets the widget to idle
  // if neither arrives within 15 s so the user is never stuck in 'processing'.

  const _startResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current) clearTimeout(responseTimeoutRef.current)
    responseTimeoutRef.current = setTimeout(() => {
      console.warn('[widget] Response timeout — resetting to idle')
      setStatus('idle')
      setErrorMessage('No response from server. Please try again.')
      setTimeout(() => setErrorMessage(null), 4000)
    }, 15000)
  }, [])

  const _clearResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }
  }, [])

  // ── Initialize STT + TTS on mount (no session needed yet) ────────────────

  useEffect(() => {
    ttsRef.current = new TextToSpeech({
      onStart: () => setStatus('speaking'),
      onEnd:   () => {
        // If action failures were queued while TTS was playing, send them to
        // the LLM now so it can acknowledge the error and guide the user.
        const failures = pendingFailuresRef.current
        if (failures.length > 0) {
          pendingFailuresRef.current = []
          setStatus('processing')
          wsRef.current?.sendActionFeedback(failures, sessionIdRef.current)
          _startResponseTimeout()
        } else {
          setStatus('idle')
        }
      },
      onError: (err) => {
        console.error('[widget] TTS error:', err)
        pendingFailuresRef.current = []
        setStatus('idle')
      },
    })

    sttRef.current = new SpeechToText({
      lang: config.lang,
      onStateChange: (s) => {
        if (s === 'listening') setStatus('listening')
      },
      onResult: (transcript) => {
        console.log('[widget] STT result:', transcript)
        addMessage('user', transcript)
        setStatus('processing')
        setErrorMessage(null)
        wsRef.current?.sendSpeech(transcript, sessionIdRef.current)
        _startResponseTimeout()
      },
      onError: (msg) => {
        console.error('[widget] STT error:', msg)
        setStatus('error')
        setErrorMessage(msg)
        setTimeout(() => { setStatus('idle'); setErrorMessage(null) }, 3500)
      },
    })

    return () => {
      sttRef.current?.stop()
      ttsRef.current?.stop()
    }
  }, [config])

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

      if (msg.speech) {
        addMessage('agent', msg.speech)
        // Queue failures so onEnd can send them after TTS finishes speaking.
        // This way the user hears the current response before the follow-up.
        if (failures.length > 0) {
          pendingFailuresRef.current = failures
        }
        ttsRef.current?.speak(msg.speech)
      } else {
        if (failures.length > 0) {
          // No speech — send feedback immediately without waiting for TTS
          setStatus('processing')
          wsRef.current?.sendActionFeedback(failures, sessionIdRef.current)
          _startResponseTimeout()
        } else {
          setStatus('idle')
        }
      }
    })

    ws.on('error', (msg) => {
      _clearResponseTimeout()
      console.error('[widget] Backend error:', msg.error)
      setStatus('idle')
      setErrorMessage(msg.error || 'Something went wrong. Please try again.')
      setTimeout(() => setErrorMessage(null), 4000)
    })

    ws.on('disconnected', () => {
      setStatus((prev) =>
        prev === 'listening' || prev === 'processing' ? prev : 'disconnected'
      )
    })

    ws.on('reconnecting', ({ attempt }) => {
      setStatus('disconnected')
      setErrorMessage(`Connection lost. Reconnecting... (${attempt}/5)`)
    })

    ws.on('max_reconnect_reached', () => {
      setStatus('error')
      setErrorMessage('Unable to reconnect to server. Please refresh the page.')
    })

    return ws
  }

  // ── First-click initialization ────────────────────────────────────────────
  // Full sequence: POST session → WS connect → page_init → speak greeting → STT

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

    // Step 2: connect WebSocket (Promise resolves on 'open')
    const ws = setupWebSocket(sessionId)
    try {
      await ws.connect()
      console.log('[widget] WebSocket open')
    } catch (err) {
      console.error('[widget] WebSocket connect failed:', err)
      throw new Error('WebSocket connection failed. Is the backend running?')
    }

    // Step 3: send page_init — server responds with greeting agent_response
    // The agent_response handler (wired above) will speak the greeting.
    ws.sendPageInit(sessionId)
    console.log('[widget] page_init sent')

    // Step 4: start watching the host page for DOM changes.
    // When fields/buttons appear, disappear, or get new IDs (SPA navigation,
    // dynamic forms), send update_context so the backend stays in sync.
    domObserverRef.current = observeDomChanges(
      (pageContext) => {
        ws.sendUpdateContext(pageContext, sessionId)
      },
      (errors) => {
        // Organic page error detected (e.g. site shows validation toast after
        // user interaction). Send feedback to LLM so it can guide the user.
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
    // Speaking → stop TTS
    if (status === 'speaking') {
      ttsRef.current?.stop()
      setStatus('idle')
      return
    }

    // Listening → stop STT
    if (status === 'listening') {
      sttRef.current?.stop()
      setStatus('idle')
      return
    }

    if (status !== 'idle' && status !== 'error') return

    if (!sttRef.current?.isSupported()) {
      setIsOpen(true)
      setErrorMessage('Voice input is not supported in this browser. Please use Chrome or Edge.')
      return
    }

    setIsOpen(true)
    setErrorMessage(null)

    // First click only: run the full initialization sequence
    if (!sessionIdRef.current) {
      try {
        await initialize()
        // After greeting TTS ends (status goes idle → listening is triggered
        // by the user clicking again). But we also start STT immediately so
        // the user can speak right after the greeting.
      } catch (err) {
        console.error('[widget] Init error:', err)
        sessionIdRef.current = null   // allow retry
        domObserverRef.current?.()
        domObserverRef.current = null
        wsRef.current?.disconnect()
        wsRef.current = null
        setStatus('error')
        setErrorMessage(err.message)
        return
      }
    }

    // Start listening — on subsequent clicks the greeting is already done
    sttRef.current?.start()
  }

  // ── Close / cleanup ──────────────────────────────────────────────────────

  async function handleClose() {
    setIsOpen(false)
    _clearResponseTimeout()
    sttRef.current?.stop()
    ttsRef.current?.stop()
    setStatus('idle')

    // Stop DOM observer
    domObserverRef.current?.()
    domObserverRef.current = null

    // Cleanup: delete session on backend, then close WS
    const sid = sessionIdRef.current
    if (sid) {
      sessionIdRef.current = null
      await deleteSession(sid)
    }
    wsRef.current?.disconnect()
    wsRef.current = null
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
