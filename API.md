# ADA Accessibility Backend — API Contract

Base URL (local dev): `http://localhost:8000`
WebSocket URL: `ws://localhost:8000/ws`

---

## REST Endpoints

### `GET /health`
Returns server status and active LLM provider.

**Response**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "provider": "claude"
}
```

---

### `POST /api/session`
Create a new conversation session. Call this **once** when the widget loads.
Persist `session_id` for all subsequent WebSocket messages.

**Response**
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### `DELETE /api/session/{session_id}`
Clear conversation history and free server resources.
Call when the user closes the widget or leaves the page.

**Response**
```json
{
  "status": "deleted",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### `GET /api/session/{session_id}/history`
Returns the plain-text conversation history (for debugging).

---

## WebSocket — `/ws`

All messages are JSON strings. Both directions share the same envelope shape.

### Envelope shape (both directions)

```ts
{
  type: string           // message type (see below)
  session_id: string     // from POST /api/session
  // ... type-specific fields
}
```

---

### Client → Server messages

#### `process_speech`
Sent after the user finishes speaking. Triggers an LLM call.

```json
{
  "type": "process_speech",
  "session_id": "...",
  "text": "I want to book a flight from New York to Los Angeles next Friday",
  "page_context": {
    "url": "https://flights.example.com/search",
    "title": "Flight Search",
    "fields": [
      {
        "selector": "#from-city",
        "label": "From",
        "field_type": "text",
        "value": "",
        "placeholder": "Departure city",
        "required": true
      },
      {
        "selector": "#to-city",
        "label": "To",
        "field_type": "text",
        "value": "",
        "placeholder": "Arrival city",
        "required": true
      },
      {
        "selector": "#depart-date",
        "label": "Departure date",
        "field_type": "date",
        "value": ""
      },
      {
        "selector": "#cabin-class",
        "label": "Cabin",
        "field_type": "select",
        "value": "economy",
        "options": ["economy", "business", "first"]
      }
    ],
    "buttons": [
      {
        "selector": "#search-btn",
        "text": "Search Flights",
        "disabled": false
      }
    ]
  }
}
```

**PageContext field reference**

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Full page URL |
| `title` | string | yes | `document.title` |
| `fields` | array | no | All visible form inputs |
| `fields[].selector` | string | yes | Unique CSS selector |
| `fields[].label` | string | no | Associated `<label>` text |
| `fields[].field_type` | string | yes | `text`, `email`, `date`, `select`, `checkbox`, `radio`, `number`, etc. |
| `fields[].value` | string | no | Current value |
| `fields[].placeholder` | string | no | |
| `fields[].required` | bool | no | Default false |
| `fields[].options` | string[] | no | Only for `select` type |
| `fields[].aria_label` | string | no | Fallback label |
| `buttons[].selector` | string | yes | |
| `buttons[].text` | string | yes | Visible button text |
| `buttons[].aria_label` | string | no | |
| `buttons[].disabled` | bool | no | Default false |

---

#### `update_context`
Notify the backend that the page changed (e.g. after a navigation or dynamic content load).
No LLM call is triggered — server just acknowledges.

```json
{
  "type": "update_context",
  "session_id": "...",
  "page_context": { ... }
}
```

---

#### `ping`
Keep-alive. Send every ~20 seconds if the connection might be idle.

```json
{
  "type": "ping",
  "session_id": "..."
}
```

---

### Server → Client messages

#### `agent_response`
Result of a `process_speech` call. Execute actions in order, then speak.

```json
{
  "type": "agent_response",
  "session_id": "...",
  "speech": "I've filled in New York and Los Angeles. Should I also set a return date?",
  "needs_clarification": false,
  "actions": [
    {
      "type": "fill",
      "selector": "#from-city",
      "value": "New York",
      "description": "Fill departure city"
    },
    {
      "type": "fill",
      "selector": "#to-city",
      "value": "Los Angeles",
      "description": "Fill arrival city"
    },
    {
      "type": "fill",
      "selector": "#depart-date",
      "value": "2026-04-17",
      "description": "Set next Friday as departure date"
    }
  ]
}
```

**Action types**

| `type` | `selector` | `value` | Effect |
|---|---|---|---|
| `fill` | input/textarea | string | Set `.value` |
| `click` | any element | — | `.click()` |
| `select` | `<select>` | option value | Set `<select>` value |
| `scroll` | any element | — | `scrollIntoView()` |
| `focus` | any element | — | `.focus()` |
| `clear` | input/textarea | — | Set `.value = ""` |

When `needs_clarification` is `true`, the `actions` array will be empty.
Speak the `speech` text and wait for the user to respond.

---

#### `error`

```json
{
  "type": "error",
  "session_id": "...",
  "error": "Missing page_context field for process_speech."
}
```

---

#### `pong`
Response to a `ping`.

```json
{
  "type": "pong",
  "session_id": "..."
}
```

---

## Recommended Widget Flow

```
1. Widget loads on host page
2. POST /api/session  →  store session_id
3. Open WebSocket /ws
4. Every 20s: send ping, expect pong

On user speech:
5. STT converts audio → text
6. Widget serializes visible form fields + buttons → page_context
7. Send process_speech message
8. On agent_response:
   a. Execute actions in order via postMessage to host page
   b. Speak response via TTS
   c. If needs_clarification=true, listen for follow-up

On page navigation / dynamic content change:
9. Re-serialize and send update_context

On widget close:
10. DELETE /api/session/{session_id}
11. Close WebSocket
```

---

## postMessage Protocol (widget ↔ host page injected script)

The widget lives in an iframe and cannot directly touch the host page DOM.
Communication goes through `window.postMessage`.

**Widget → Host (execute action)**
```json
{
  "source": "ada-widget",
  "type": "execute_action",
  "action": {
    "type": "fill",
    "selector": "#from-city",
    "value": "New York"
  }
}
```

**Host → Widget (action result)**
```json
{
  "source": "ada-host",
  "type": "action_result",
  "success": true,
  "selector": "#from-city",
  "error": null
}
```

The host page's injected script listens for `ada-widget` messages and
responds with `ada-host` messages after executing each action.
