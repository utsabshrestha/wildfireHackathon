/**
 * WebSocket client service.
 * Maintains connection to the backend agent server with auto-reconnect.
 * Routes incoming messages by `type` to registered handlers.
 */
export class WidgetWebSocket {
  constructor(serverUrl, sessionId) {
    this.serverUrl = serverUrl
    this.sessionId = sessionId
    this.ws = null
    this.handlers = {}
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelays = [1000, 2000, 4000, 8000, 16000]
    this.pingInterval = null
    this.manualClose = false
  }

  connect() {
    this.manualClose = false
    try {
      this.ws = new WebSocket(this.serverUrl)
    } catch (err) {
      console.error('[widget:ws] Failed to create WebSocket:', err)
      this._scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      console.log('[widget:ws] Connected to', this.serverUrl)
      this.reconnectAttempts = 0

      // Send session_start
      this._send({
        type: 'session_start',
        sessionId: this.sessionId,
        context: {
          pageUrl: window.location.href,
          pageTitle: document.title,
        },
      })

      // Start keepalive ping every 30s
      this.pingInterval = setInterval(() => {
        this._send({ type: 'ping', sessionId: this.sessionId })
      }, 30000)

      this._dispatch('connected', {})
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
      console.log('[widget:ws] Disconnected', event.code, event.reason)
      clearInterval(this.pingInterval)
      this.pingInterval = null
      this._dispatch('disconnected', { code: event.code })

      if (!this.manualClose) {
        this._scheduleReconnect()
      }
    })

    this.ws.addEventListener('error', (err) => {
      console.error('[widget:ws] Error:', err)
      this._dispatch('error', { error: err })
    })
  }

  /**
   * Send user speech text to the backend.
   * @param {string} text - Transcribed user speech
   */
  sendMessage(text) {
    this._send({
      type: 'user_message',
      sessionId: this.sessionId,
      text,
      timestamp: Date.now(),
    })
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type - e.g. 'agent_message', 'dom_action', 'connected'
   * @param {Function} handler - Called with the full message object
   */
  on(type, handler) {
    this.handlers[type] = handler
  }

  disconnect() {
    this.manualClose = true
    clearInterval(this.pingInterval)
    this.pingInterval = null
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    } else {
      console.warn('[widget:ws] Cannot send — not connected')
    }
  }

  _dispatch(type, message) {
    if (this.handlers[type]) {
      this.handlers[type](message)
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
      this.connect()
    }, delay)
  }
}
