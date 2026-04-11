import { WebSocketServer } from 'ws'
import { getResponse } from './mockAgent.js'

const PORT = process.env.PORT || 8080

const wss = new WebSocketServer({ port: PORT })

console.log(`[server] WebSocket server listening on ws://localhost:${PORT}`)

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  let sessionId = null

  console.log(`[server] Client connected from ${clientIp}`)

  ws.on('message', (rawData) => {
    let message
    try {
      message = JSON.parse(rawData.toString())
    } catch {
      console.error('[server] Failed to parse message:', rawData.toString())
      return
    }

    const { type } = message

    switch (type) {
      case 'session_start': {
        sessionId = message.sessionId
        console.log(`[server] Session started: ${sessionId}`)
        console.log(`[server] Page: ${message.context?.pageTitle} (${message.context?.pageUrl})`)
        break
      }

      case 'user_message': {
        const { text, timestamp } = message
        console.log(`[server] [${sessionId}] User said: "${text}"`)

        const replyText = getResponse(text)
        console.log(`[server] [${sessionId}] Agent replies: "${replyText}"`)

        const response = JSON.stringify({
          type: 'agent_message',
          sessionId,
          text: replyText,
          timestamp: Date.now(),
        })

        // Small delay to feel more natural
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(response)
          }
        }, 400)

        break
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', sessionId }))
        break
      }

      default:
        console.warn(`[server] Unknown message type: ${type}`)
    }
  })

  ws.on('close', () => {
    console.log(`[server] Client disconnected${sessionId ? ` (session: ${sessionId})` : ''}`)
  })

  ws.on('error', (err) => {
    console.error(`[server] WebSocket error:`, err.message)
  })
})

wss.on('error', (err) => {
  console.error('[server] Server error:', err)
})
