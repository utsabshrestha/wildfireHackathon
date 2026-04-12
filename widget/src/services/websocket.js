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
      ? `#${CSS.escape(el.id)}`
      : el.name
        ? `[name="${_escAttr(el.name)}"]`
        : el.getAttribute('aria-label')
          ? `[aria-label="${_escAttr(el.getAttribute('aria-label'))}"]`
          : el.placeholder
            ? `[placeholder="${_escAttr(el.placeholder)}"]`
            : el.tagName.toLowerCase()

    // Collect <option> values for <select> elements
    let options = undefined
    let multiple = false
    let selected_values = undefined
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options).map((o) => o.text || o.value).filter(Boolean)
      multiple = el.multiple || false
      if (multiple) {
        selected_values = Array.from(el.selectedOptions).map((o) => o.text || o.value).filter(Boolean)
      }
    } else {
      // For custom chip/tag multi-select UIs (e.g. airport chip inputs), detect
      // any chip elements near this input and report them as selected_values.
      const chipInfo = _detectChipSelections(el)
      if (chipInfo.multiple) {
        multiple = true
        selected_values = chipInfo.selectedValues
      }
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
      multiple,
      selected_values,
    })
  })

  document
    .querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')
    .forEach((el) => {
      const text = el.textContent?.trim() || el.value || el.getAttribute('aria-label') || ''
      if (!text) return

      buttons.push({
        selector: _buildSelector(el),
        text,
        aria_label: el.getAttribute('aria-label') || undefined,
        disabled: el.disabled || false,
      })
    })

  // Scan result items — finds cards/rows that contain prices and action buttons.
  // Works on any site: discovers structure by reading visible content, not
  // by relying on special attributes we added to the page.
  const resultItems = _scanResultCards()

  return {
    url: window.location.href,
    title: document.title,
    fields,
    buttons,
    result_items: resultItems,
    page_errors: getPageErrors(),
  }
}

/**
 * Scan for visible error states on the host page.
 * Returns an array of human-readable error strings.
 *
 * Exported so Widget.jsx can call it directly after executing DOM actions.
 */
export function getPageErrors() {
  const errors = []
  const seen = new Set()

  function add(text) {
    const t = text.trim().slice(0, 150)
    if (t && !seen.has(t)) { seen.add(t); errors.push(t) }
  }

  // Input-level validation errors
  document.querySelectorAll('[aria-invalid="true"], .input-error, [data-invalid]').forEach(el => {
    if (!_isVisible(el)) return
    const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null
    const name = labelEl?.textContent?.trim() ||
                 el.getAttribute('aria-label') ||
                 el.placeholder || el.id || 'a field'
    add(`Validation error on field: "${name}"`)
  })

  // Visible alert / live region / toast messages
  document.querySelectorAll(
    '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], ' +
    '.toast, .snackbar, .alert, .notification, .error-message'
  ).forEach(el => {
    if (!_isVisible(el)) return
    add(el.textContent || '')
  })

  return errors
}

/** Escape a string for use inside a CSS attribute selector value. */
function _escAttr(val) {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function _isVisible(el) {
  const s = window.getComputedStyle(el)
  return s.display !== 'none' && s.visibility !== 'hidden' && !!el.offsetParent
}

/**
 * For a text/search input, detect whether it is part of a chip/tag multi-select
 * UI (e.g. airport chip selectors on flight booking sites).
 *
 * Walks up to 5 ancestor levels looking for a container that holds visible
 * chip elements with a remove button (×). If found, returns the chip texts
 * as selectedValues so the LLM knows what is already selected.
 *
 * Two strategies:
 *   1. Class-based — chips with well-known CSS class patterns.
 *   2. Structural — compact sibling elements that contain text + a remove button.
 *
 * @param {HTMLElement} inputEl
 * @returns {{ multiple: boolean, selectedValues: string[] | undefined }}
 */
function _detectChipSelections(inputEl) {
  const CHIP_SELECTORS = [
    '[class*="chip"]', '[class*="tag"]', '[class*="token"]',
    '[class*="badge"]', '[class*="pill"]',
  ].join(',')

  let node = inputEl.parentElement
  for (let i = 0; i < 5 && node && node !== document.body; i++) {
    // Strategy 1: elements matching known chip class patterns
    const byClass = Array.from(node.querySelectorAll(CHIP_SELECTORS)).filter(c => {
      if (c === inputEl || c.contains(inputEl) || inputEl.contains(c)) return false
      if (!_isVisible(c)) return false
      // Must have an internal remove button — plain badges/labels don't count
      return !!(c.querySelector('button,[role="button"],svg,[aria-label*="remove" i],[aria-label*="delete" i]'))
    })

    if (byClass.length > 0) {
      const vals = byClass.map(_extractChipText).filter(Boolean)
      if (vals.length > 0) return { multiple: true, selectedValues: vals }
    }

    // Strategy 2: structural — direct children of this ancestor that are
    // compact visible elements containing text + a remove button, but are
    // NOT the input itself and NOT large containers.
    const byStructure = Array.from(node.children).filter(child => {
      if (child === inputEl || child.contains(inputEl)) return false
      if (!_isVisible(child)) return false
      const text = (child.textContent || '').trim()
      if (!text || text.length > 100) return false
      return !!(child.querySelector('button,[role="button"],svg'))
    })

    if (byStructure.length > 0) {
      const vals = byStructure.map(_extractChipText).filter(Boolean)
      if (vals.length > 0) return { multiple: true, selectedValues: vals }
    }

    node = node.parentElement
  }

  return { multiple: false, selectedValues: undefined }
}

/**
 * Extract the visible text label from a chip element, excluding the
 * remove button / icon text so we get just the value (e.g. "FSD Sioux Falls").
 */
function _extractChipText(chip) {
  const clone = chip.cloneNode(true)
  clone.querySelectorAll(
    'button,[role="button"],svg,' +
    '[aria-label*="remove" i],[aria-label*="delete" i],[aria-label*="close" i],' +
    '[class*="close"],[class*="remove"],[class*="delete"],[class*="clear"]'
  ).forEach(el => el.remove())
  return (clone.textContent || '').trim().replace(/\s+/g, ' ').replace(/[×✕✖]/g, '').trim()
}

/**
 * Find result cards on the page by locating action buttons and walking up
 * to their surrounding content block.
 *
 * Works on any site without requiring special attributes:
 *   1. Find every visible action button (non-submit, non-nav)
 *   2. Walk up the DOM to find the smallest ancestor that contains
 *      meaningful context text (price, description, etc.)
 *   3. Capture that card's visible text + a reliable selector for the button
 *
 * The LLM reads the text ("$189 · CloudHop Air · 1 Stop") and clicks
 * the button selector to act — exactly as a user would.
 */
function _scanResultCards() {
  const cards = []
  const seenCards = new Set()

  // Buttons outside forms that are likely to be "action" buttons on result cards
  const SKIP_TEXTS = new Set(['close', 'menu', 'search', 'sign in', 'log in', 'sign up', 'back'])
  const candidates = Array.from(
    document.querySelectorAll('button:not([type="submit"]), a[role="button"]')
  ).filter((btn) => {
    if (!_isVisible(btn)) return false
    if (btn.closest('nav, header, footer, form')) return false
    const text = (btn.textContent || '').trim().toLowerCase()
    return text.length > 0 && text.length < 60 && !SKIP_TEXTS.has(text)
  })

  for (const btn of candidates) {
    const btnText = (btn.textContent || '').trim()

    // Walk up from the button looking for a "card" — an ancestor that has
    // substantially more visible text than just the button, capped at a
    // reasonable size so we don't capture entire page sections.
    let card = btn.parentElement
    while (card && card !== document.body) {
      const cardText = (card.textContent || '').trim()
      const isCard = cardText.length > btnText.length + 30 && cardText.length < 700
      if (isCard) break
      card = card.parentElement
    }

    if (!card || card === document.body || seenCards.has(card)) continue
    seenCards.add(card)

    const text = (card.textContent || '').trim().replace(/\s+/g, ' ')
    if (text.length < 20) continue

    cards.push({
      selector: _buildSelector(btn),
      text: text.slice(0, 300),
      index: cards.length,
    })
  }

  return cards
}

/**
 * Build the most stable CSS selector for an element, in priority order:
 *   id → unique data attribute → path from nearest identified ancestor
 */
function _buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`

  // Use the first data-* attribute that looks like a stable identifier
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-') && attr.value && !['data-v', 'data-reactid'].some(p => attr.name.startsWith(p))) {
      return `[${attr.name}="${CSS.escape(attr.value)}"]`
    }
  }

  // Build a path down from the nearest ancestor that has an id or unique data attr
  const path = []
  let node = el
  while (node && node !== document.body) {
    if (node.id) {
      path.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName)
      : [node]
    const nth = siblings.indexOf(node) + 1
    path.unshift(nth > 1 ? `${tag}:nth-of-type(${nth})` : tag)
    node = node.parentElement
  }
  return path.join(' > ')
}

// ── DOM change observer ───────────────────────────────────────────────────

/**
 * Observe the host page DOM for two kinds of changes:
 *
 *   1. Structural changes (new fields, removed fields, SPA navigation)
 *      → calls `onContextChanged(pageContext)` (debounced, skipped during isMutating)
 *
 *   2. Error-state changes (validation alerts appearing, aria-invalid set)
 *      → calls `onPageError(errors)` when error indicators appear organically
 *        (NOT during isMutating, so widget's own actions don't trigger this)
 *
 * @param {(ctx: object) => void}    onContextChanged - called with new page context
 * @param {(errors: string[]) => void} [onPageError]  - called when page shows errors
 * @param {number}                   debounceMs       - quiet period (default 400ms)
 * @returns {() => void} teardown function
 */
export function observeDomChanges(onContextChanged, onPageError = null, debounceMs = 400) {
  let debounceTimer = null
  let errorDebounceTimer = null

  // BUTTON intentionally excluded — result cards appearing with action buttons
  // should not trigger update_context. We only care about new form fields.
  const WATCHED_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'LABEL'])
  const WATCHED_ATTRS = new Set(['id', 'name', 'type', 'disabled', 'required', 'aria-label', 'placeholder'])

  function scheduleUpdate() {
    if (isMutating) {
      console.log('[widget:dom-observer] Skipping mutation — widget is executing DOM actions')
      return
    }
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (isMutating) return
      console.log('[widget:dom-observer] Organic DOM change — sending update_context')
      onContextChanged(getPageContext())
    }, debounceMs)
  }

  function scheduleErrorCheck() {
    // Only fire for organic errors — never while widget is filling fields
    if (isMutating || !onPageError) return
    clearTimeout(errorDebounceTimer)
    errorDebounceTimer = setTimeout(() => {
      if (isMutating) return
      const errors = getPageErrors()
      if (errors.length > 0) {
        console.log('[widget:dom-observer] Page errors detected:', errors)
        onPageError(errors)
      }
    }, 300)
  }

  function isWatchedNode(node) {
    return node.nodeType === Node.ELEMENT_NODE && WATCHED_TAGS.has(node.nodeName)
  }

  function hasWatchedDescendant(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    return node.querySelector?.('input, select, textarea') !== null
  }

  /** True if this node looks like an alert / toast / error banner. */
  function isErrorNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const role = node.getAttribute?.('role') || ''
    const ariaLive = node.getAttribute?.('aria-live') || ''
    return role === 'alert' || role === 'status' || ariaLive === 'assertive' || ariaLive === 'polite'
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        const addedNodes = Array.from(mutation.addedNodes)
        const removedNodes = Array.from(mutation.removedNodes)

        // Check for structural form changes
        const structuralChange =
          addedNodes.some((n) => isWatchedNode(n) || hasWatchedDescendant(n)) ||
          removedNodes.some((n) => isWatchedNode(n) || hasWatchedDescendant(n))
        if (structuralChange) { scheduleUpdate(); continue }

        // Check for alert/toast nodes being injected
        if (addedNodes.some(isErrorNode)) {
          scheduleErrorCheck()
          continue
        }
      }

      if (mutation.type === 'attributes') {
        const target = mutation.target
        const attr = mutation.attributeName

        // aria-invalid being set to "true" on any element
        if (attr === 'aria-invalid' && target.getAttribute('aria-invalid') === 'true') {
          scheduleErrorCheck()
          continue
        }

        // class change that adds an error-like class
        if (attr === 'class') {
          const cls = target.className || ''
          if (/error|invalid|shake/.test(cls)) {
            scheduleErrorCheck()
            continue
          }
        }

        // Structural attribute changes on form elements
        if (isWatchedNode(target) && WATCHED_ATTRS.has(attr)) {
          scheduleUpdate()
        }
      }
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...Array.from(WATCHED_ATTRS), 'aria-invalid', 'class'],
  })

  console.log('[widget:dom-observer] Observing DOM for context changes and errors')

  return () => {
    observer.disconnect()
    clearTimeout(debounceTimer)
    clearTimeout(errorDebounceTimer)
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
   * Send action failures + current page state back to the LLM.
   *
   * The LLM is asked to use its world knowledge (airports, cities, countries)
   * to suggest a better search term and immediately retry with search_select
   * rather than just reporting the error.
   *
   * @param {string[]} failures - failure strings from executeDomActions
   * @param {string}   sessionId
   */
  sendActionFeedback(failures, sessionId) {
    const summary = failures.join(' | ')
    console.log('[widget:ws] Sending action feedback:', summary)
    this._send({
      type: 'process_speech',
      session_id: sessionId,
      text: `[SYSTEM] Action failed: ${summary}. `
        + `Use your knowledge of airports, cities, and countries to identify the correct search term. `
        + `For example, if "Nepal" failed, you know the main airport is Tribhuvan International (KTM) in Kathmandu — retry with search_select using "Kathmandu". `
        + `Briefly tell the user what you're trying (e.g. "Nepal's airport is in Kathmandu, trying that") and include the corrected search_select action in your response.`,
      page_context: getPageContext(),
    })
  }

  /**
   * Called after 3 consecutive failures on the same intent.
   * Instructs the LLM to stop retrying and ask the user for help instead.
   *
   * @param {string[]} failures
   * @param {string}   sessionId
   */
  sendGiveUp(failures, sessionId) {
    const summary = failures.join(' | ')
    console.warn('[widget:ws] 3 consecutive failures — sending give-up signal:', summary)
    this._send({
      type: 'process_speech',
      session_id: sessionId,
      text: `[SYSTEM] After multiple attempts the action still failed: ${summary}. `
        + `Do NOT try again automatically. Tell the user what went wrong in plain language and ask them to `
        + `provide a different search term, the exact airport name, or the IATA code (e.g. "JFK", "LHR").`,
      page_context: getPageContext(),
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
