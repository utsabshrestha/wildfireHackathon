"""
Provider-agnostic LLM layer.

Switch via LLM_PROVIDER env var:
  - "claude"  → Anthropic SDK, tool-use for guaranteed structured output
  - "openai"  → OpenAI SDK (works with gpt-oss-120b or any compatible endpoint),
                JSON mode + Pydantic validation
"""

import asyncio
import json
from abc import ABC, abstractmethod

import anthropic
from openai import AsyncOpenAI

from config import settings
from models import AgentResponse, PageContext

# ---------------------------------------------------------------------------
# Web search helper
# ---------------------------------------------------------------------------

async def _execute_web_search(query: str) -> str:
    """Run a DuckDuckGo text search and return the top results as a plain string."""
    try:
        from duckduckgo_search import DDGS  # imported lazily so the app works without it

        def _sync_search():
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=5))

        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(None, _sync_search)

        if not results:
            return f"No results found for: {query}"

        lines = [f"Search results for: {query}\n"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.get('title', '')}")
            lines.append(f"   {r.get('body', '')}")
            lines.append(f"   {r.get('href', '')}")
            lines.append("")
        return "\n".join(lines)

    except ImportError:
        return "Web search unavailable (duckduckgo-search not installed)."
    except Exception as exc:
        return f"Search failed: {exc}"


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

SEARCH_WEB_TOOL = {
    "name": "search_web",
    "description": (
        "Search the web for up-to-date information. Use this for:\n"
        "- Airport codes or hub cities for countries/regions you're unsure about\n"
        "- Flight pricing trends, cheapest booking windows, seasonal deals\n"
        "- Travel tips, airline reviews, Reddit discussions about a route\n"
        "- Any factual travel question you can't answer reliably from memory\n"
        "Keep queries short and specific (e.g. 'Nepal main international airport code')."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query (concise, under 15 words)"}
        },
        "required": ["query"],
    },
}


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
- If a [SYSTEM] message reports an autocomplete failure, use your world knowledge to suggest the correct city or airport name and include a corrected search_select action to retry immediately.
"""

SYSTEM_PROMPT = """You are an ADA accessibility assistant embedded in a website via an iframe.
Your job is to help users with disabilities interact with web pages using only their voice.

On each turn you receive:
1. A snapshot of the current page (URL, title, form fields, buttons).
2. What the user just said (transcribed from speech).

Your responsibilities:
- Understand the user's intent.
- Return the exact DOM actions needed to fulfil the request, following the interaction rules below.
- Always return a speech field — even for silent actions say something brief like "Done." or "Got it.".
- Return a short, natural-sounding speech response suitable for text-to-speech (no markdown, no lists).
- If the intent is unclear, set needs_clarification=true and ask a single focused follow-up question in the speech field.
- Never invent selectors that aren't in the provided page context.
- Keep speech responses under 40 words unless explaining a complex situation.
- If the page context contains "⚠ Page errors", read them carefully. They mean the previous action failed or the page rejected an input. Acknowledge the specific error to the user and suggest a concrete fix (e.g. try a different spelling, pick from the dropdown, check the date format). Do not repeat the same action that just failed.

Autocomplete recovery — when a [SYSTEM] message says a search_select failed:
- Use your world knowledge of airports, cities, countries, and landmarks to identify the correct search term.
- Examples: "Nepal" → main airport is Tribhuvan International (KTM) in Kathmandu, try "Kathmandu".
  "London" → try "London Heathrow" or just "Heathrow". "Dubai" → try "Dubai" (DXB).
  "New York" → try "New York" (will surface JFK, LGA, EWR). Country names → use the capital city or main hub.
- Tell the user briefly what you know: "Nepal's main airport is in Kathmandu, let me try that."
- Then include a corrected search_select action in your response so the retry happens immediately.
- If you are genuinely unsure of the airport/city, ask the user for the specific city or airport code.

DOM interaction rules — simulate a real human user:
1. Always scroll to an element before interacting with it if it might be off-screen.
2. Always focus an element before filling or selecting it.
3. If a field already has a value, send clear before fill.
4. After filling a field, send key_press Tab to move focus naturally to the next field. This fires blur (triggering form validation) and focus on the next input — exactly what a real user does.
5. For buttons and links, use click only — no focus needed first.
6. For <select> dropdowns, use focus then select (not fill).
7. To submit a form, click the submit button. Never use key_press Enter on a field unless it is a search box with no submit button.
8. Never chain multiple fills without Tab between them.

Handling result items (flight cards, search results):
- Result items appear in the page context under "Result items" when search results are shown.
- Each item has an index, its full visible text (price, airline, times, etc.), and a selector.
- For queries like "find the cheapest", "pick the first option", "select the fastest":
  parse the text of each result item to find the best match, then return a click action on its selector.
- Never guess a selector — only use selectors that appear in the provided result items list.
- If no result items are present, tell the user the results haven't loaded yet and ask them to try again.

Choosing the right action for dropdowns:
- Native <select> element (single): use focus then select (not fill).
- Native <select multiple> or custom multi-select chips/tags: use multi_select to add a value, deselect to remove one.
  - The page context will show "(multi-select)" and list currently selected values under "selected".
  - Use deselect before multi_select if you need to replace all selections — deselect each current value first.
  - For custom chip/tag UIs (no native select), multi_select clicks the option in the dropdown, deselect clicks the × remove button on the chip.
- Dynamic autocomplete / combobox (user types to search, options appear below): use search_select.
  search_select types the value, waits for the dropdown list to appear, and clicks the matching option.
  Never use fill on a dynamic autocomplete — it sets the text but doesn't select an option.
- For multi-select autocompletes (type to add multiple values, e.g. airport chips): use search_select for each value in sequence to add, and deselect to remove an existing chip.
  Example — user says "add Miami as a second origin":
    search_select #origin "Miami"
  Example — user says "remove Sioux Falls":
    deselect #origin "FSD Sioux Falls"
  The selector for deselect is the input field, not the chip — the widget finds the chip automatically by matching the value text.

Web search — call search_web BEFORE execute_actions when:
- You need an airport code or hub city for a country/region you're not certain about.
- The user asks about pricing trends, best time to book, or cheapest routes.
- The user wants travel tips, airline comparisons, or advice from travel communities.
- A search_select just failed and you want to verify the correct search term before retrying.
After searching, synthesise the key insight into a brief speech (≤ 40 words) then include the
appropriate execute_actions. Do not search for information that is already visible in the page context.

Example correct sequence for filling two fields then submitting:
  scroll → focus #from → fill #from "New York" → key_press Tab
  scroll → focus #to   → fill #to   "Los Angeles" → key_press Tab
  click #search-btn

Example for a dynamic city autocomplete:
  scroll → search_select #city-input "New York"
  (search_select handles focus, typing, waiting, and clicking the option internally)
"""


def _build_page_context_str(ctx: PageContext) -> str:
    """Serialize PageContext into a compact string for the LLM."""
    lines = [f"Page: {ctx.title}", f"URL: {ctx.url}", ""]

    if ctx.fields:
        lines.append("Form fields:")
        for f in ctx.fields:
            label = f.label or f.aria_label or f.selector
            opts = f" | options: [{', '.join(f.options)}]" if f.options else ""
            current = f" | current: \"{f.value}\"" if f.value and not f.multiple else ""
            multi_tag = " (multi-select)" if f.multiple else ""
            selected = f" | selected: [{', '.join(f.selected_values)}]" if f.multiple and f.selected_values else ""
            req = " (required)" if f.required else ""
            lines.append(f"  [{f.field_type}]{multi_tag} {label}{req}{opts}{current}{selected} → selector={f.selector}")

    if ctx.buttons:
        lines.append("Buttons:")
        for b in ctx.buttons:
            disabled = " (disabled)" if b.disabled else ""
            lines.append(f"  \"{b.text}\"{disabled} → selector={b.selector}")

    if ctx.result_items:
        lines.append(f"\nResult items ({len(ctx.result_items)} visible):")
        for item in ctx.result_items:
            lines.append(f"  [{item.index}] {item.text} → selector={item.selector}")

    if ctx.page_errors:
        lines.append("\n⚠ Page errors / validation messages:")
        for err in ctx.page_errors:
            lines.append(f"  - {err}")

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
        self._execute_tool = {
            "name": "execute_actions",
            "description": "Execute DOM actions on the page and provide a speech response to the user.",
            "input_schema": AgentResponse.model_json_schema(),
        }
        # Keep old name for callers that reference self._tool (page_description, update_context)
        self._tool = self._execute_tool

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

        messages = history + [user_message]

        # Agentic loop — LLM may call search_web one or more times before
        # calling execute_actions. Cap at 5 search iterations to avoid runaway loops.
        for _iteration in range(5):
            response = await self._client.messages.create(
                model=settings.claude_model,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                tools=[SEARCH_WEB_TOOL, self._execute_tool],
                tool_choice={"type": "auto"},
                messages=messages,
            )

            # Convert response content to plain dicts once, categorised by type.
            text_blocks: list[dict] = []
            search_dicts: list[dict] = []
            execute_block = None

            for block in response.content:
                if block.type == "text":
                    text_blocks.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    block_dict = {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                    if block.name == "execute_actions":
                        execute_block = block
                    elif block.name == "search_web":
                        search_dicts.append(block_dict)
                    # Any other tool_use is silently dropped — avoids unmatched IDs.

            # LLM chose to act on the page — return immediately
            if execute_block:
                return AgentResponse.model_validate(execute_block.input)

            # LLM called search_web (possibly multiple times in one response).
            # Execute ALL searches and pair EVERY tool_use with its tool_result.
            # This is the critical fix: if we add N tool_use blocks to the
            # assistant message, we must add N matching tool_results in the
            # next user message — otherwise Anthropic rejects with 400.
            if search_dicts:
                tool_results = []
                for sb in search_dicts:
                    result = await _execute_web_search(sb["input"].get("query", ""))
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": sb["id"],
                        "content": result,
                    })
                # assistant_content contains ONLY the search blocks we've responded
                # to — no orphaned tool_use IDs.
                messages.append({"role": "assistant", "content": text_blocks + search_dicts})
                messages.append({"role": "user", "content": tool_results})
                continue

            # LLM responded with text only — fall through to forced call below
            break

        # Fallback: force execute_actions so we always return a structured response
        response = await self._client.messages.create(
            model=settings.claude_model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            tools=[self._execute_tool],
            tool_choice={"type": "tool", "name": "execute_actions"},
            messages=messages,
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


_OPENAI_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_web",
        "description": SEARCH_WEB_TOOL["description"],
        "parameters": SEARCH_WEB_TOOL["input_schema"],
    },
}

_OPENAI_EXECUTE_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_actions",
        "description": "Execute DOM actions on the page and provide a speech response to the user.",
        "parameters": _OPENAI_SCHEMA_HINT,
    },
}


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

        # Agentic loop — LLM may call search_web before execute_actions
        for _iteration in range(5):
            response = await self._client.chat.completions.create(
                model=settings.openai_model,
                tools=[_OPENAI_SEARCH_TOOL, _OPENAI_EXECUTE_TOOL],
                tool_choice="auto",
                messages=messages,
                max_tokens=1024,
            )

            msg = response.choices[0].message
            tool_calls = msg.tool_calls or []

            execute_call = next((tc for tc in tool_calls if tc.function.name == "execute_actions"), None)
            search_call  = next((tc for tc in tool_calls if tc.function.name == "search_web"), None)

            if execute_call:
                return AgentResponse.model_validate_json(execute_call.function.arguments or "{}")

            if search_call:
                args = json.loads(search_call.function.arguments or "{}")
                search_results = await _execute_web_search(args.get("query", ""))
                messages.append(msg.model_dump(exclude_unset=True))
                messages.append({
                    "role": "tool",
                    "tool_call_id": search_call.id,
                    "content": search_results,
                })
                continue

            # No tool call — try to parse a JSON response (fallback for JSON-mode models)
            raw = msg.content or "{}"
            try:
                return AgentResponse.model_validate_json(raw)
            except Exception:
                break

        # Fallback: force JSON response without tool calls
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
