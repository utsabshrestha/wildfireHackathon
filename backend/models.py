from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# DOM Action types & model
# ---------------------------------------------------------------------------

class ActionType(str, Enum):
    FOCUS = "focus"        # Move keyboard focus to element — always before fill/select
    CLEAR = "clear"        # Clear existing value before typing new one
    FILL = "fill"          # Simulate typing into an input/textarea (fires input + change events)
    SELECT = "select"      # Choose an option in a <select> dropdown
    MULTI_SELECT = "multi_select"  # Add a value to a <select multiple> or toggle a chip/tag in a custom multiselect
    DESELECT = "deselect"  # Remove a specific value from a multiselect (clicks the × on a chip, or deselects native option)
    CLICK = "click"        # Simulate a real mouse click (mousedown → mouseup → click)
    SCROLL = "scroll"      # Scroll element into view before interacting
    KEY_PRESS = "key_press"      # Press a keyboard key — use for Tab (field nav), Enter (submit), Escape
    SEARCH_SELECT = "search_select"  # Type into a dynamic autocomplete/combobox, wait for options, click match


class DOMAction(BaseModel):
    type: ActionType
    selector: str = Field(description="CSS selector for the target element")
    value: Optional[str] = Field(
        None,
        description=(
            "For fill/select: the value to set. "
            "For key_press: the key name — 'Tab', 'Enter', 'Escape'."
        )
    )
    description: Optional[str] = Field(None, description="Human-readable description of this action")


# ---------------------------------------------------------------------------
# LLM structured response
# ---------------------------------------------------------------------------

class AgentResponse(BaseModel):
    speech: str = Field(
        default="",
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
    multiple: bool = False  # True if this is a multi-select field
    selected_values: Optional[list[str]] = None  # Currently selected values for multi-select fields


class PageButton(BaseModel):
    selector: str
    text: str
    aria_label: Optional[str] = None
    disabled: bool = False


class ResultItem(BaseModel):
    selector: str
    text: str = Field(description="Visible text of the result card — includes price, airline, times, etc. (max 300 chars)")
    index: int = Field(description="0-based position in the result list")


class PageContext(BaseModel):
    url: str
    title: str
    fields: list[FormField] = Field(default_factory=list)
    buttons: list[PageButton] = Field(default_factory=list)
    result_items: list[ResultItem] = Field(
        default_factory=list,
        description="Visible result cards / list rows (flight results, search results, etc.) — used for queries like 'find the cheapest'"
    )


# ---------------------------------------------------------------------------
# WebSocket message envelopes (client <-> server)
# ---------------------------------------------------------------------------

class MessageType(str, Enum):
    # Client -> Server
    PAGE_INIT = "page_init"        # Widget just loaded — scan page and greet user
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
