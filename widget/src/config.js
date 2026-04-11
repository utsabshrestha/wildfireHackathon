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

const attrs = readScriptAttributes()

const wsUrl = attrs.serverUrl || 'ws://localhost:8000/ws'

// Derive the HTTP base URL from the WebSocket URL so we can call REST endpoints.
// ws://localhost:8000/ws  →  http://localhost:8000
// wss://api.example.com/ws → https://api.example.com
const httpBaseUrl = wsUrl
  .replace(/^ws:\/\//, 'http://')
  .replace(/^wss:\/\//, 'https://')
  .replace(/\/ws$/, '')

export const config = {
  wsUrl,
  httpBaseUrl,
  lang: attrs.lang || 'en-US',
  themeColor: attrs.themeColor || '#2563eb',
  position: attrs.position || 'bottom-right',
}
