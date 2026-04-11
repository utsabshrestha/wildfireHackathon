import { h } from 'preact'

const STATUS_TEXT = {
  idle: 'Tap to speak',
  listening: 'Listening...',
  processing: 'Processing...',
  speaking: 'Speaking...',
  error: 'Something went wrong',
  disconnected: 'Reconnecting...',
}

/**
 * Small status label that appears below the floating button.
 */
export function StatusIndicator({ status }) {
  const text = STATUS_TEXT[status] || ''
  if (!text || status === 'idle') return null

  return (
    <div class={`vw-status vw-status--${status}`} role="status" aria-live="polite">
      {text}
    </div>
  )
}
