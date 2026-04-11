"""
ADA Accessibility Backend
FastAPI app — REST + WebSocket endpoints.

Run:
    uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

import uuid
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from llm import get_llm_client, BaseLLMClient
from models import (
    IncomingMessage,
    OutgoingMessage,
    MessageType,
    CreateSessionResponse,
    HealthResponse,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ADA Accessibility Backend",
    version="1.0.0",
    description="Voice-driven accessibility agent for embedded website widgets.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory session store
# Stores conversation history per session as a list of {role, content} dicts.
# For production, replace with Redis or a DB.
# ---------------------------------------------------------------------------

# session_id -> list of {"role": "user"|"assistant", "content": str}
_sessions: dict[str, list[dict]] = {}

# Single shared LLM client (instantiated once at startup)
_llm_client: BaseLLMClient = get_llm_client()


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse, tags=["meta"])
async def health():
    """Health check. Returns current provider so the widget knows what's active."""
    return HealthResponse(
        status="ok",
        version="1.0.0",
        provider=settings.llm_provider,
    )


@app.post("/api/session", response_model=CreateSessionResponse, tags=["session"])
async def create_session():
    """
    Create a new conversation session.
    The widget should call this once on load and persist the returned session_id
    for the lifetime of the user's visit.
    """
    session_id = str(uuid.uuid4())
    _sessions[session_id] = []
    logger.info("Session created: %s", session_id)
    return CreateSessionResponse(session_id=session_id)


@app.delete("/api/session/{session_id}", tags=["session"])
async def delete_session(session_id: str):
    """
    Delete a session and clear its conversation history.
    Call this when the user closes the widget or navigates away.
    """
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    del _sessions[session_id]
    logger.info("Session deleted: %s", session_id)
    return {"status": "deleted", "session_id": session_id}


@app.get("/api/session/{session_id}/history", tags=["session"])
async def get_session_history(session_id: str):
    """
    Return the conversation history for a session (useful for debugging).
    """
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"session_id": session_id, "history": _sessions[session_id]}


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Main real-time channel between the widget and the backend.

    Protocol:
      Client sends JSON matching IncomingMessage schema.
      Server responds with JSON matching OutgoingMessage schema.

    Message types (client -> server):
      - process_speech  : transcribed text + current page context
      - update_context  : page context changed (navigation), no LLM call
      - ping            : keep-alive

    Message types (server -> client):
      - agent_response  : speech text + list of DOM actions
      - error           : error description
      - pong            : keep-alive reply
    """
    await websocket.accept()
    logger.info("WebSocket connection opened")

    try:
        while True:
            raw = await websocket.receive_text()

            # --- Parse incoming message ---
            try:
                msg = IncomingMessage.model_validate_json(raw)
            except Exception as parse_err:
                await _send_error(websocket, "unknown", f"Invalid message format: {parse_err}")
                continue

            session_id = msg.session_id

            # Auto-create session if client skipped the REST call
            if session_id not in _sessions:
                _sessions[session_id] = []

            # --- Route by type ---

            if msg.type == MessageType.PAGE_INIT:
                if not msg.page_context:
                    await _send_error(websocket, session_id, "Missing 'page_context' for page_init.")
                    continue

                try:
                    speech = await _llm_client.get_page_description(msg.page_context)
                except Exception as llm_err:
                    logger.exception("LLM error during page_init for session %s", session_id)
                    await _send_error(websocket, session_id, f"LLM error: {llm_err}")
                    continue

                # Seed history so follow-up conversation has context
                _sessions[session_id].append({"role": "assistant", "content": speech})

                await websocket.send_text(
                    OutgoingMessage(
                        type=MessageType.AGENT_RESPONSE,
                        session_id=session_id,
                        speech=speech,
                        actions=[],
                        needs_clarification=False,
                    ).model_dump_json()
                )
                continue

            if msg.type == MessageType.PING:
                await websocket.send_text(
                    OutgoingMessage(type=MessageType.PONG, session_id=session_id).model_dump_json()
                )
                continue

            if msg.type == MessageType.UPDATE_CONTEXT:
                # Widget notifies us the page changed; we just ack — no LLM call.
                logger.info("Context updated for session %s", session_id)
                continue

            if msg.type == MessageType.PROCESS_SPEECH:
                if not msg.text:
                    await _send_error(websocket, session_id, "Missing 'text' field for process_speech.")
                    continue
                if not msg.page_context:
                    await _send_error(websocket, session_id, "Missing 'page_context' field for process_speech.")
                    continue

                history = _sessions[session_id]

                try:
                    agent_resp = await _llm_client.get_agent_response(
                        user_text=msg.text,
                        page_context=msg.page_context,
                        history=history,
                    )
                except Exception as llm_err:
                    logger.exception("LLM error for session %s", session_id)
                    await _send_error(websocket, session_id, f"LLM error: {llm_err}")
                    continue

                # Append turn to history (plain text — keeps history compact)
                history.append({"role": "user", "content": msg.text})
                history.append({"role": "assistant", "content": agent_resp.speech})

                await websocket.send_text(
                    OutgoingMessage(
                        type=MessageType.AGENT_RESPONSE,
                        session_id=session_id,
                        speech=agent_resp.speech,
                        actions=agent_resp.actions,
                        needs_clarification=agent_resp.needs_clarification,
                    ).model_dump_json()
                )

    except WebSocketDisconnect:
        logger.info("WebSocket connection closed")


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

async def _send_error(websocket: WebSocket, session_id: str, message: str) -> None:
    logger.error("Sending error to %s: %s", session_id, message)
    await websocket.send_text(
        OutgoingMessage(
            type=MessageType.ERROR,
            session_id=session_id,
            error=message,
        ).model_dump_json()
    )
