"""
Provider-agnostic LLM layer.

Switch via LLM_PROVIDER env var:
  - "claude"  → Anthropic SDK, tool-use for guaranteed structured output
  - "openai"  → OpenAI SDK (works with gpt-oss-120b or any compatible endpoint),
                JSON mode + Pydantic validation
"""

import json
from abc import ABC, abstractmethod

import anthropic
from openai import AsyncOpenAI

from config import settings
from models import AgentResponse, PageContext, FormField, PageButton

# ---------------------------------------------------------------------------
# Shared prompt
# ---------------------------------------------------------------------------

PAGE_INIT_PROMPT = """You are an ADA accessibility assistant embedded in a website via an iframe.
A user with a disability has just opened this page. Your job is to greet them and describe what's on the page.

Tell them:
- What the page is for (in plain language)
- The key form fields available and what each one is for
- The main actions they can take

Then end with a single clear question asking how you can help them get started.
Keep the entire response under 60 words. Speak naturally — it will be read aloud via text-to-speech. No markdown, no lists.
"""

UPDATE_CONTEXT_PROMPT = """You are an ADA accessibility assistant embedded in a website via an iframe.
The host page DOM has just changed — new fields may have appeared, old ones may have gone, or the page may have navigated to a new step (e.g. a confirmation screen, a date picker, a passenger details form).

You are given:
1. The conversation history so far.
2. The updated page snapshot (fields, buttons, URL, title).

Your job is to decide whether this DOM change requires a proactive response:
- If a new form step or screen appeared that the user needs to know about, describe it briefly and ask how to proceed.
- If new input fields appeared that are relevant to the user's last request, fill them if you have the information, or ask for what's missing.
- If nothing meaningful changed (minor re-renders, same fields), return an empty speech string and an empty actions list so the widget stays silent.

Rules:
- Keep speech under 30 words. It will be read aloud. No markdown, no lists.
- Never invent selectors not present in the page context.
- If unsure whether the change is meaningful, stay silent (empty speech, empty actions).
"""

SYSTEM_PROMPT = """You are an ADA accessibility assistant embedded in a website via an iframe.
Your job is to help users with disabilities interact with web pages using only their voice.

On each turn you receive:
1. A snapshot of the current page (URL, title, form fields, buttons).
2. What the user just said (transcribed from speech).

Your responsibilities:
- Understand the user's intent.
- Return the exact DOM actions needed to fulfil the request (fill fields, click buttons, etc.).
- Return a short, natural-sounding speech response suitable for text-to-speech (no markdown, no lists).
- If the intent is unclear, set needs_clarification=true and ask a single focused follow-up question in the speech field.
- Never invent selectors that aren't in the provided page context.
- Keep speech responses under 40 words unless explaining a complex situation.
"""


def _build_page_context_str(ctx: PageContext) -> str:
    """Serialize PageContext into a compact string for the LLM."""
    lines = [f"Page: {ctx.title}", f"URL: {ctx.url}", ""]

    if ctx.fields:
        lines.append("Form fields:")
        for f in ctx.fields:
            label = f.label or f.aria_label or f.selector
            opts = f" | options: [{', '.join(f.options)}]" if f.options else ""
            current = f" | current: \"{f.value}\"" if f.value else ""
            req = " (required)" if f.required else ""
            lines.append(f"  [{f.field_type}] {label}{req}{opts}{current} → selector={f.selector}")

    if ctx.buttons:
        lines.append("Buttons:")
        for b in ctx.buttons:
            disabled = " (disabled)" if b.disabled else ""
            lines.append(f"  \"{b.text}\"{disabled} → selector={b.selector}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class BaseLLMClient(ABC):
    @abstractmethod
    async def get_agent_response(
        self,
        user_text: str,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        ...

    @abstractmethod
    async def get_page_description(self, page_context: PageContext) -> str:
        """Describe the page to the user on widget init. Returns plain speech text."""
        ...

    @abstractmethod
    async def get_context_update_response(
        self,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        """
        React to a DOM change on the host page.
        Returns an AgentResponse — speech may be empty if no action is needed.
        """
        ...


# ---------------------------------------------------------------------------
# Claude implementation  (Anthropic SDK, tool-use)
# ---------------------------------------------------------------------------

class ClaudeClient(BaseLLMClient):
    def __init__(self) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=settings.claude_api_key)
        # Build tool schema once from Pydantic model
        self._tool = {
            "name": "execute_actions",
            "description": "Execute DOM actions on the page and provide a speech response to the user.",
            "input_schema": AgentResponse.model_json_schema(),
        }

    async def get_agent_response(
        self,
        user_text: str,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        user_message = {
            "role": "user",
            "content": (
                f"--- Page context ---\n{_build_page_context_str(page_context)}\n\n"
                f"--- User said ---\n{user_text}"
            ),
        }

        response = await self._client.messages.create(
            model=settings.claude_model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            tools=[self._tool],
            tool_choice={"type": "tool", "name": "execute_actions"},
            messages=history + [user_message],
        )

        for block in response.content:
            if block.type == "tool_use":
                return AgentResponse.model_validate(block.input)

        raise RuntimeError("Claude returned no tool_use block — unexpected response format.")

    async def get_page_description(self, page_context: PageContext) -> str:
        response = await self._client.messages.create(
            model=settings.claude_model,
            max_tokens=256,
            system=PAGE_INIT_PROMPT,
            messages=[{
                "role": "user",
                "content": f"--- Page context ---\n{_build_page_context_str(page_context)}",
            }],
        )
        return response.content[0].text

    async def get_context_update_response(
        self,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        user_message = {
            "role": "user",
            "content": (
                "The page DOM has changed. Here is the updated page snapshot:\n\n"
                f"--- Updated page context ---\n{_build_page_context_str(page_context)}\n\n"
                "Decide whether to speak or act based on this change."
            ),
        }

        response = await self._client.messages.create(
            model=settings.claude_model,
            max_tokens=512,
            system=UPDATE_CONTEXT_PROMPT,
            tools=[self._tool],
            tool_choice={"type": "tool", "name": "execute_actions"},
            messages=history + [user_message],
        )

        for block in response.content:
            if block.type == "tool_use":
                return AgentResponse.model_validate(block.input)

        raise RuntimeError("Claude returned no tool_use block for update_context.")


# ---------------------------------------------------------------------------
# OpenAI-compatible implementation  (OpenAI SDK, JSON mode)
# ---------------------------------------------------------------------------

_OPENAI_SCHEMA_HINT = AgentResponse.model_json_schema()

_OPENAI_SYSTEM_PROMPT = (
    SYSTEM_PROMPT
    + "\n\nIMPORTANT: You must respond ONLY with a valid JSON object that strictly follows "
    "this JSON schema (no extra keys, no prose, no markdown):\n"
    + json.dumps(_OPENAI_SCHEMA_HINT, indent=2)
)


class OpenAIClient(BaseLLMClient):
    def __init__(self) -> None:
        self._client = AsyncOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )

    async def get_agent_response(
        self,
        user_text: str,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        user_message = {
            "role": "user",
            "content": (
                f"--- Page context ---\n{_build_page_context_str(page_context)}\n\n"
                f"--- User said ---\n{user_text}"
            ),
        }

        messages = (
            [{"role": "system", "content": _OPENAI_SYSTEM_PROMPT}]
            + history
            + [user_message]
        )

        response = await self._client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=messages,
            max_tokens=1024,
        )

        raw = response.choices[0].message.content or "{}"
        return AgentResponse.model_validate_json(raw)

    async def get_page_description(self, page_context: PageContext) -> str:
        response = await self._client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": PAGE_INIT_PROMPT},
                {"role": "user", "content": f"--- Page context ---\n{_build_page_context_str(page_context)}"},
            ],
            max_tokens=256,
        )
        return response.choices[0].message.content or ""

    async def get_context_update_response(
        self,
        page_context: PageContext,
        history: list[dict],
    ) -> AgentResponse:
        _update_system = (
            UPDATE_CONTEXT_PROMPT
            + "\n\nIMPORTANT: You must respond ONLY with a valid JSON object that strictly follows "
            "this JSON schema (no extra keys, no prose, no markdown):\n"
            + json.dumps(_OPENAI_SCHEMA_HINT, indent=2)
        )

        user_message = {
            "role": "user",
            "content": (
                "The page DOM has changed. Here is the updated page snapshot:\n\n"
                f"--- Updated page context ---\n{_build_page_context_str(page_context)}\n\n"
                "Decide whether to speak or act based on this change."
            ),
        }

        messages = (
            [{"role": "system", "content": _update_system}]
            + history
            + [user_message]
        )

        response = await self._client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=messages,
            max_tokens=512,
        )

        raw = response.choices[0].message.content or "{}"
        return AgentResponse.model_validate_json(raw)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_llm_client() -> BaseLLMClient:
    if settings.llm_provider == "claude":
        return ClaudeClient()
    elif settings.llm_provider == "openai":
        return OpenAIClient()
    else:
        raise ValueError(f"Unknown LLM_PROVIDER: {settings.llm_provider!r}. Use 'claude' or 'openai'.")
