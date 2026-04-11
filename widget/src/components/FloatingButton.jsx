import { h } from 'preact'

/**
 * The always-visible floating microphone button.
 * Visual states: idle | listening | processing | speaking | error
 */
export function FloatingButton({ status, isOpen, onClick }) {
  const label = {
    idle: 'Click to speak',
    listening: 'Listening — click to stop',
    processing: 'Processing...',
    speaking: 'Speaking...',
    error: 'Error — click to retry',
    disconnected: 'Reconnecting...',
  }[status] || 'Click to speak'

  return (
    <button
      class={`vw-fab vw-fab--${status}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {status === 'processing' || status === 'disconnected' ? (
        <SpinnerIcon />
      ) : status === 'speaking' ? (
        <SpeakingIcon />
      ) : (
        <MicIcon active={status === 'listening'} />
      )}

      {status === 'listening' && <span class="vw-fab__pulse" aria-hidden="true" />}
    </button>
  )
}

function MicIcon({ active }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="24"
      height="24"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  )
}

function SpeakingIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="24"
      height="24"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="24"
      height="24"
      class="vw-spin"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}
