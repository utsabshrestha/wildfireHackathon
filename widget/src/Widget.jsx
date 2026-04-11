import { h } from 'preact'
import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { FloatingButton } from './components/FloatingButton.jsx'
import { ChatPanel } from './components/ChatPanel.jsx'
import { StatusIndicator } from './components/StatusIndicator.jsx'
import { WidgetWebSocket } from './services/websocket.js'
import { SpeechToText } from './services/stt.js'
import { TextToSpeech } from './services/tts.js'
import { executeDomActions } from './services/domActions.js'

/**
 * Root widget component.
 * Orchestrates STT → WS → TTS pipeline and manages all UI state.
 *
 * Status flow:
 *   idle → listening (user presses mic)
 *   listening → processing (STT result received, sending to WS)
 *   processing → speaking (agent reply received, TTS starts)
 *   speaking → idle (TTS finishes)
 */
export function Widget({ config }) {
  const [isOpen, setIsOpen] = useState(false)
  const [status, setStatus] = useState('idle')
  const [messages, setMessages] = useState([])
  const [errorMessage, setErrorMessage] = useState(null)

  const wsRef = useRef(null)
  const sttRef = useRef(null)
  const ttsRef = useRef(null)

  const addMessage = useCallback((role, text) => {
    setMessages((prev) => [...prev, { role, text, timestamp: Date.now() }])
  }, [])

  // Initialize services on mount
  useEffect(() => {
    // TTS
    ttsRef.current = new TextToSpeech({
      onStart: () => setStatus('speaking'),
      onEnd: () => setStatus('idle'),
      onError: (err) => {
        console.error('[widget] TTS error:', err)
        setStatus('idle')
      },
    })

    // STT
    sttRef.current = new SpeechToText({
      lang: config.lang,
      onStateChange: (s) => {
        if (s === 'listening') setStatus('listening')
      },
      onResult: (transcript) => {
        console.log('[widget] STT result:', transcript)
        setStatus('processing')
        addMessage('user', transcript)
        clearError()

        if (wsRef.current) {
          wsRef.current.sendMessage(transcript)
        }
      },
      onError: (msg) => {
        console.error('[widget] STT error:', msg)
        setStatus('error')
        setErrorMessage(msg)
        setTimeout(() => {
          setStatus('idle')
          setErrorMessage(null)
        }, 3000)
      },
    })

    // WebSocket
    const ws = new WidgetWebSocket(config.serverUrl, config.sessionId)
    wsRef.current = ws

    ws.on('agent_message', (msg) => {
      addMessage('agent', msg.text)
      setStatus('speaking')
      ttsRef.current?.speak(msg.text)
    })

    ws.on('dom_action', (msg) => {
      console.log('[widget] DOM action received:', msg.actions)
      executeDomActions(msg.actions)
    })

    ws.on('connected', () => {
      setStatus('idle')
      setErrorMessage(null)
    })

    ws.on('disconnected', () => {
      if (status !== 'listening' && status !== 'processing') {
        setStatus('disconnected')
      }
    })

    ws.on('reconnecting', ({ attempt, delay }) => {
      setStatus('disconnected')
      setErrorMessage(`Connection lost. Reconnecting... (${attempt}/5)`)
    })

    ws.on('max_reconnect_reached', () => {
      setStatus('error')
      setErrorMessage('Unable to connect to server. Please refresh the page.')
    })

    ws.connect()

    return () => {
      ws.disconnect()
      sttRef.current?.stop()
      ttsRef.current?.stop()
    }
  }, [config])

  function clearError() {
    setErrorMessage(null)
  }

  function handleFabClick() {
    // If speaking, stop TTS and go idle
    if (status === 'speaking') {
      ttsRef.current?.stop()
      setStatus('idle')
      return
    }

    // If listening, stop STT
    if (status === 'listening') {
      sttRef.current?.stop()
      setStatus('idle')
      return
    }

    // If idle or error, open panel and start listening
    if (status === 'idle' || status === 'error') {
      setIsOpen(true)
      setErrorMessage(null)

      if (!sttRef.current?.isSupported()) {
        setErrorMessage('Voice input is not supported in this browser. Please use Chrome or Edge.')
        return
      }

      sttRef.current?.start()
    }
  }

  function handleClose() {
    setIsOpen(false)
    sttRef.current?.stop()
    ttsRef.current?.stop()
    setStatus('idle')
  }

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
        <FloatingButton
          status={status}
          isOpen={isOpen}
          onClick={handleFabClick}
        />
      </div>
    </div>
  )
}
