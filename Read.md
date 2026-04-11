# Accessibility Assistant (Flight Booking)

A voice-driven accessibility agent that embeds into any website to help users with disabilities interact with web pages using only their voice. The agent understands natural speech, fills out forms, clicks buttons, and navigates pages — all hands-free.

## How it works

A small script tag is added to a host website (e.g. a flight booking site or government portal). This loads:

1. **A widget** (iframe) — captures the user's voice via STT, speaks responses via TTS, and shows a minimal UI
2. **An injected script** — listens for actions from the widget and executes them on the host page DOM

The widget communicates with this backend over WebSocket in real time. The backend uses an LLM to understand the user's intent and return structured DOM actions.

```
Host Website
├── <script> loader
│   ├── Injects widget iframe
│   └── Injects postMessage DOM executor
│
Widget (iframe)
├── STT  →  text
├── WebSocket  →  Backend
└── Receives actions  →  postMessage to host page

Backend (this repo)
├── Receives text + page context
├── LLM generates speech response + DOM actions
└── Returns to widget over WebSocket
```

## Project structure

```
wildfireHackathon/
├── backend/
│   ├── main.py           # FastAPI app — REST + WebSocket endpoints
│   ├── llm.py            # Provider-agnostic LLM layer (Claude + OpenAI)
│   ├── models.py         # Pydantic schemas for all messages and actions
│   ├── config.py         # Settings loaded from .env
│   ├── requirements.txt  # Python dependencies
│   └── .env.example      # Environment variable template
├── API.md                # Full API contract for the frontend/widget developer
└── Read.md               # This file
```

## Backend setup

### 1. Create and activate a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate      # macOS/Linux
# venv\Scripts\activate       # Windows
```

### 2. Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your keys:

```env
# Switch provider: "claude" for demo, "openai" for dev/testing
LLM_PROVIDER=claude

# Anthropic (Claude)
CLAUDE_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6

# OpenAI-compatible (gpt-oss-120b or any OpenAI SDK endpoint)
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-oss-120b
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 4. Run the server

```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

> Always use `python -m uvicorn` (not `uvicorn` directly) to ensure the active virtual environment is used.

Server starts at `http://localhost:8000`
Interactive API docs at `http://localhost:8000/docs`

## API overview

### REST

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Health check, returns active LLM provider |
| POST | `/api/session` | Create a session, returns `session_id` |
| DELETE | `/api/session/{id}` | Delete session and clear history |
| GET | `/api/session/{id}/history` | Get conversation history (debug) |

### WebSocket

Connect to `ws://localhost:8000/ws`

**Widget sends:**

```json
{
  "type": "process_speech",
  "session_id": "...",
  "text": "I want to fly from New York to LA next Friday",
  "page_context": {
    "url": "https://flights.example.com",
    "title": "Flight Search",
    "fields": [ { "selector": "#from", "label": "From", "field_type": "text" } ],
    "buttons": [ { "selector": "#search", "text": "Search Flights" } ]
  }
}
```

**Backend responds:**

```json
{
  "type": "agent_response",
  "session_id": "...",
  "speech": "I've filled in New York and Los Angeles. Searching now.",
  "actions": [
    { "type": "fill", "selector": "#from", "value": "New York" },
    { "type": "fill", "selector": "#to",   "value": "Los Angeles" },
    { "type": "click", "selector": "#search" }
  ],
  "needs_clarification": false
}
```

See [API.md](API.md) for the full protocol, all message types, and the postMessage contract between the widget and host page.

## LLM providers

The backend supports two providers, switchable via `LLM_PROVIDER` in `.env` with no code changes.

| Provider | SDK | Structured output method |
|---|---|---|
| `claude` | `anthropic` | Tool use — schema derived from Pydantic model, guaranteed structure |
| `openai` | `openai` | JSON mode + Pydantic validation |

Use `openai` during development and switch to `claude` for the demo.

## DOM actions

The LLM returns an ordered list of actions the widget executes on the host page:

| Action | Effect |
|---|---|
| `fill` | Set value on an input or textarea |
| `click` | Click a button, link, or any element |
| `select` | Choose an option in a dropdown |
| `scroll` | Scroll element into view |
| `focus` | Move keyboard focus to element |
| `clear` | Clear current value of an input |
