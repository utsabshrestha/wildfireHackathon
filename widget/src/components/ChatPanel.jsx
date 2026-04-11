import { h } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

/**
 * Slide-up transcript panel showing conversation history.
 * Renders alternating user/agent message bubbles.
 */
export function ChatPanel({ messages, isOpen, onClose, errorMessage }) {
  const bottomRef = useRef(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isOpen && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isOpen])

  return (
    <div class={`vw-panel ${isOpen ? 'vw-panel--open' : ''}`} role="dialog" aria-label="Voice assistant">
      <div class="vw-panel__header">
        <div class="vw-panel__header-left">
          <div class="vw-panel__avatar">
            <PlaneIcon />
          </div>
          <div>
            <div class="vw-panel__title">Flight Assistant</div>
            <div class="vw-panel__subtitle">AI-powered booking helper</div>
          </div>
        </div>
        <button class="vw-panel__close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div class="vw-panel__messages">
        {messages.length === 0 && (
          <div class="vw-panel__empty">
            <PlaneIcon size={32} />
            <p>Hi! I can help you search and book flights.</p>
            <p>Click the microphone and tell me where you'd like to go.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} class={`vw-bubble vw-bubble--${msg.role}`}>
            <div class="vw-bubble__text">{msg.text}</div>
            <div class="vw-bubble__time">{formatTime(msg.timestamp)}</div>
          </div>
        ))}

        {errorMessage && (
          <div class="vw-error-msg" role="alert">
            {errorMessage}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function CloseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      width="18" height="18" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function PlaneIcon({ size = 20 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      width={size} height={size} aria-hidden="true">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L11 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
    </svg>
  )
}
