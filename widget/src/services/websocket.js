/**
 * WebSocket client service for the real backend.
 *
 * Full protocol order:
 *   1. POST /api/session          → get session_id  (done in Widget.jsx)
 *   2. WS connect                 → no message on open
 *   3. send page_init             → receive greeting agent_response
 *   4. send process_speech        → receive actions + speech  (repeat)
 *   5. send update_context        → DOM changed organically (not by widget actions)
 *   6. send ping every ~20s       → receive pong
 *   7. DELETE /api/session/{id}   → cleanup  (done in Widget.jsx)
 */

import { isMutating } from './domActions.js'

// ── Page context scraping ─────────────────────────────────────────────────

/**
 * Scrape the host page for all interactive fields and buttons.
 * Matches the backend PageContext / FormField / PageButton Pydantic models exactly.
 *
 * @returns {{ url: string, title: string, fields: object[], buttons: object[] }}
 */
export function getPageContext() {
  const fields = []
  const buttons = []

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'hidden') return

    const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null
    const label =
      labelEl?.textContent?.trim() ||
      el.getAttribute('aria-label') ||
      el.placeholder ||
      el.name ||
      ''

    const selector = el.id
      ? `#${el.id}`
      : el.name
        ? `[name="${el.name}"]`
        : el.tagName.toLowerCase()

    // Collect <option> values for <select> elements
    let options = undefined
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options).map((o) => o.text || o.value).filter(Boolean)
    }

    fields.push({
      selector,
      label,
      field_type: el.tagName === 'SELECT' ? 'select' : el.type || 'text',
      value: el.value || '',
      placeholder: el.placeholder || undefined,
      required: el.required || false,
      options,
      aria_label: el.getAttribute('aria-label') || undefined,
    })
  })

  document
    .querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')
    .forEach((el) => {
      const text = el.textContent?.trim() || el.value || el.getAttribute('aria-label') || ''
      if (!text) return

      const selector = el.id
        ? `#${el.id}`
        : el.className
          ? `.${el.className.trim().split(/\s+/)[0]}`
          : el.tagName.toLowerCase()

      buttons.push({
        selector,
        text,
        aria_label: el.getAttribute('aria-label') || undefined,
        disabled: el.disabled || false,
      })
    })

  return {
    url: window.location.href,
    title: document.title,
    fields,
    buttons,
  }
}

// ── DOM change observer ───────────────────────────────────────────────────

/**
 * Observe the host page DOM for structural changes (new fields, removed fields,
 * attribute changes on inputs). When a meaningful change is detected, calls
 * the provided callback with a debounced snapshot of the new page context.
 *
 * We watch for:
 *   - childList mutations on the whole document (elements added/removed)
 *   - attribute mutations on inputs/selects/textareas/buttons
 *     (e.g. `id`, `name`, `disabled`, `required`, `type` changing)
 *
 * Input `value` changes are intentionally NOT observed here — those are sent
 * with every `process_speech` as the latest page_context snapshot.
 *
 * @param {(ctx: object) => void} onContextChanged - called with new page context
 * @param {number} debounceMs - quiet period before firing (default 400ms)
 * @returns {() => void} teardown function — call to stop observing
 */
export function observeDomChanges(onContextChanged, debounceMs = 400) {
  let debounceTimer = null

  // The set of tag names / attributes we care about — prevents firing on
  // every mouseover, style tweak, or animation frame update.
  const WATCHED_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'FORM', 'LABEL'])
  const WATCHED_ATTRS = new Set(['id', 'name', 'type', 'disabled', 'required', 'aria-label', 'placeholder'])

  function scheduleUpdate() {
    // Skip mutations caused by our own DOM actions to avoid the feedback loop:
    // executeDomActions fills fields → MutationObserver fires → update_context → LLM fills again → loop
    if (isMutating) {
      console.log('[widget:dom-observer] Skipping mutation — widget is executing DOM actions')
      return
    }
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // Double-check the flag hasn't been set during the debounce window
      if (isMutating) return
      console.log('[widget:dom-observer] Organic DOM change — sending update_context')
      onContextChanged(getPageContext())
    }, debounceMs)
  }

  function isWatchedNode(node) {
    return node.nodeType === Node.ELEMENT_NODE && WATCHED_TAGS.has(node.nodeName)
  }

  function hasWatchedDescendant(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    // Quick check before doing a querySelector (which is more expensive)
    return node.querySelector?.('input, select, textarea, button') !== null
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Structural changes: nodes added or removed
      if (mutation.type === 'childList') {
        const relevant =
          Array.from(mutation.addedNodes).some((n) => isWatchedNode(n) || hasWatchedDescendant(n)) ||
          Array.from(mutation.removedNodes).some((n) => isWatchedNode(n) || hasWatchedDescendant(n))

        if (relevant) {
          scheduleUpdate()
          return // one update per batch is enough
        }
      }

      // Attribute changes on existing elements
      if (mutation.type === 'attributes') {
        if (isWatchedNode(mutation.target) && WATCHED_ATTRS.has(mutation.attributeName)) {
          scheduleUpdate()
          return
        }
      }
    }
  })

  observer.observe(document.body, {
    childList: true,     // direct children added/removed
    subtree: true,       // whole document tree
    attributes: true,   // attribute changes
    attributeFilter: Array.from(WATCHED_ATTRS),
  })

  console.log('[widget:dom-observer] Observing DOM for context changes')

  return () => {
    observer.disconnect()
    clearTimeout(debounceTimer)
    console.log('[widget:dom-observer] Observer disconnected')
  }
}

// ── WebSocket client ──────────────────────────────────────────────────────

export class WidgetWebSocket {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.handlers = {}
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelays = [1000, 2000, 4000, 8000, 16000]
    this.manualClose = false
    this._pingTimer = null
    this._sessionId = null
  }

  /**
   * Open the WebSocket.
   * Returns a Promise that resolves when the socket is open,
   * or rejects on error / 5-second timeout.
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.manualClose = false

      try {
        this.ws = new WebSocket(this.wsUrl)
      } catch (err) {
        reject(err)
        return
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out after 5s'))
      }, 5000)

      this.ws.addEventListener('open', () => {
        clearTimeout(timeout)
        console.log('[widget:ws] Connected to', this.wsUrl)
        this.reconnectAttempts = 0
        this._startPing()
        this._dispatch('connected', {})
        resolve()
      })

      this.ws.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          console.error('[widget:ws] Failed to parse message:', event.data)
          return
        }
        console.log('[widget:ws] Received:', message)
        this._dispatch(message.type, message)
      })

      this.ws.addEventListener('close', (event) => {
        clearTimeout(timeout)
        console.log('[widget:ws] Disconnected', event.code, event.reason)
        this._stopPing()
        this._dispatch('disconnected', { code: event.code })
        if (!this.manualClose) {
          this._scheduleReconnect()
        }
      })

      this.ws.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('WebSocket connection error'))
        this._dispatch('error', {})
      })
    })
  }

  /**
   * Store session_id — required for ping and all outgoing messages.
   * @param {string} id
   */
  setSessionId(id) {
    this._sessionId = id
  }

  /**
   * Send page_init — call immediately after connect() resolves.
   * Server responds with a greeting agent_response.
   * @param {string} sessionId
   */
  sendPageInit(sessionId) {
    this._send({
      type: 'page_init',
      session_id: sessionId,
      page_context: getPageContext(),
    })
  }

  /**
   * Send transcribed speech with the latest page context.
   * @param {string} text
   * @param {string} sessionId
   */
  sendSpeech(text, sessionId) {
    this._send({
      type: 'process_speech',
      session_id: sessionId,
      text,
      page_context: getPageContext(),
    })
  }

  /**
   * Notify the backend that the page context changed (DOM mutation).
   * The backend updates its understanding of the page — no LLM reply is sent.
   * @param {object} pageContext - result of getPageContext()
   * @param {string} sessionId
   */
  sendUpdateContext(pageContext, sessionId) {
    this._send({
      type: 'update_context',
      session_id: sessionId,
      page_context: pageContext,
    })
  }

  /**
   * Register a handler for a specific incoming message type.
   * @param {string} type
   * @param {Function} handler
   */
  on(type, handler) {
    this.handlers[type] = handler
  }

  disconnect() {
    this.manualClose = true
    this._stopPing()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    } else {
      console.warn('[widget:ws] Cannot send — not connected:', obj.type)
    }
  }

  _dispatch(type, message) {
    if (this.handlers[type]) {
      this.handlers[type](message)
    }
  }

  _startPing() {
    this._stopPing()
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping', session_id: this._sessionId })
    }, 20000)
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[widget:ws] Max reconnect attempts reached')
      this._dispatch('max_reconnect_reached', {})
      return
    }

    const delay = this.reconnectDelays[this.reconnectAttempts] || 16000
    console.log(`[widget:ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`)
    this._dispatch('reconnecting', { attempt: this.reconnectAttempts + 1, delay })

    setTimeout(() => {
      this.reconnectAttempts++
      this.connect().catch(() => {}) // error already dispatched via handlers
    }, delay)
  }
}
