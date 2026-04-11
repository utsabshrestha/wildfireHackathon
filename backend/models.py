from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# DOM Action types & model
# ---------------------------------------------------------------------------

class ActionType(str, Enum):
    FILL = "fill"        # Set value on an input/textarea
    CLICK = "click"      # Click a button, link, or any element
    SELECT = "select"    # Choose an option in a <select> dropdown
    SCROLL = "scroll"    # Scroll to bring an element into view
    FOCUS = "focus"      # Move keyboard focus to an element
    CLEAR = "clear"      # Clear the current value of an input


class DOMAction(BaseModel):
    type: ActionType
    selector: str = Field(description="CSS selector for the target element")
    value: Optional[str] = Field(None, description="Value for fill/select actions")
    description: Optional[str] = Field(None, description="Human-readable description of this action")


# ---------------------------------------------------------------------------
# LLM structured response
# ---------------------------------------------------------------------------

class AgentResponse(BaseModel):
    speech: str = Field(
        description="What the assistant should say aloud to the user via TTS"
    )
    actions: list[DOMAction] = Field(
        default_factory=list,
        description="Ordered list of DOM actions to execute on the host page"
    )
    needs_clarification: bool = Field(
        False,
        description="Set to true if the user intent is unclear and more info is needed"
    )


# ---------------------------------------------------------------------------
# Page context sent by the widget (describes current host-page state)
# ---------------------------------------------------------------------------

class FormField(BaseModel):
    selector: str
    label: Optional[str] = None
    field_type: str = Field(description="html input type: text, email, select, checkbox, radio, date, etc.")
    value: Optional[str] = None
    placeholder: Optional[str] = None
    required: bool = False
    options: Optional[list[str]] = None  # Only populated for <select> elements
    aria_label: Optional[str] = None


class PageButton(BaseModel):
    selector: str
    text: str
    aria_label: Optional[str] = None
    disabled: bool = False


class PageContext(BaseModel):
    url: str
    title: str
    fields: list[FormField] = Field(default_factory=list)
    buttons: list[PageButton] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# WebSocket message envelopes (client <-> server)
# ---------------------------------------------------------------------------

class MessageType(str, Enum):
    # Client -> Server
    PROCESS_SPEECH = "process_speech"
    UPDATE_CONTEXT = "update_context"
    PING = "ping"

    # Server -> Client
    AGENT_RESPONSE = "agent_response"
    ERROR = "error"
    PONG = "pong"


class IncomingMessage(BaseModel):
    """Message sent from the widget (client) to the backend."""
    type: MessageType
    session_id: str
    text: Optional[str] = Field(None, description="Transcribed speech text from STT")
    page_context: Optional[PageContext] = Field(
        None,
        description="Current page state snapshot from the host website"
    )


class OutgoingMessage(BaseModel):
    """Message sent from the backend to the widget (client)."""
    type: MessageType
    session_id: str
    speech: Optional[str] = Field(None, description="Text for TTS to speak")
    actions: Optional[list[DOMAction]] = Field(None, description="Actions to execute on the host page")
    needs_clarification: Optional[bool] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# REST endpoint schemas
# ---------------------------------------------------------------------------

class CreateSessionResponse(BaseModel):
    session_id: str


class HealthResponse(BaseModel):
    status: str
    version: str
    provider: str
