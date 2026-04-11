/**
 * Reads configuration from the widget's own <script> tag data-* attributes.
 * Falls back to sensible defaults for local development.
 *
 * Usage on host page:
 *   <script src="widget.js"
 *     data-server-url="wss://api.example.com/ws"
 *     data-lang="en-US"
 *     data-theme-color="#2563eb"
 *     data-position="bottom-right">
 *   </script>
 */

function readScriptAttributes() {
  // In IIFE build mode, document.currentScript is available at parse time.
  // In Vite dev (module mode), we search by src pattern as a fallback.
  const script =
    document.currentScript ||
    document.querySelector('script[src*="widget"]') ||
    document.querySelector('script[type="module"][src*="main"]')

  if (!script) return {}

  return {
    serverUrl: script.getAttribute('data-server-url'),
    lang: script.getAttribute('data-lang'),
    themeColor: script.getAttribute('data-theme-color'),
    position: script.getAttribute('data-position'),
  }
}

function generateSessionId() {
  const existing = sessionStorage.getItem('vw_session_id')
  if (existing) return existing

  const id = 'sess_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now()
  sessionStorage.setItem('vw_session_id', id)
  return id
}

const attrs = readScriptAttributes()

export const config = {
  serverUrl: attrs.serverUrl || 'ws://localhost:8080',
  lang: attrs.lang || 'en-US',
  themeColor: attrs.themeColor || '#2563eb',
  position: attrs.position || 'bottom-right',
  sessionId: generateSessionId(),
}
