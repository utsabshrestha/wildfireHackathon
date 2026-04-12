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


GET_TRAVEL_INSIGHTS_TOOL = {
    "name": "get_travel_insights",
    "description": (
        "Search Reddit, travel blogs, and fare-tracking communities for money-saving tips,\n"
        "hidden tricks, and community advice about a specific flight route.\n"
        "Use this PROACTIVELY when flight results are visible (even without the user asking)\n"
        "and when the user implies curiosity about price, value, or alternatives.\n"
        "Returns community insights that can help the user save money or travel smarter."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "origin": {
                "type": "string",
                "description": "Origin city or airport (e.g. 'Kathmandu' or 'KTM')",
            },
            "destination": {
                "type": "string",
                "description": "Destination city or airport (e.g. 'Dhaka' or 'DAC')",
            },
            "context": {
                "type": "string",
                "description": (
                    "What to focus on, e.g. 'cheapest booking time', 'alternative routes', "
                    "'layover savings', 'is this price normal'. Keep it short."
                ),
            },
        },
        "required": ["origin", "destination"],
    },
}

COMPARE_FLIGHTS_TOOL = {
    "name": "compare_flights",
    "description": (
        "Search multiple flight booking websites to compare prices for a specific route and date.\n"
        "Use this when the user asks to compare with other sites (Kayak, Skyscanner, Google Flights, Expedia, etc.),\n"
        "wants to know if there are cheaper options elsewhere, or says 'check other sites'.\n"
        "Runs targeted web searches across platforms and returns aggregated price data for comparison."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "origin": {
                "type": "string",
                "description": "Origin city or airport code (e.g. 'Kathmandu' or 'KTM')",
            },
            "destination": {
                "type": "string",
                "description": "Destination city or airport code (e.g. 'Dhaka' or 'DAC')",
            },
            "date": {
                "type": "string",
                "description": "Outbound travel date (e.g. 'April 15 2026' or '2026-04-15')",
            },
            "return_date": {
                "type": "string",
                "description": "Return date for round trips (optional)",
            },
        },
        "required": ["origin", "destination", "date"],
    },
}


async def _execute_flight_comparison(
    origin: str, destination: str, date: str, return_date: str | None = None
) -> str:
    """Search multiple flight booking sites and return aggregated results."""
    trip = f"{origin} to {destination} on {date}"
    if return_date:
        trip += f" returning {return_date}"

    # Use queries that surface travel aggregator articles and cached price pages
    # rather than trying to scrape booking sites directly (those block crawlers).
    queries = [
        f"{origin} {destination} flight price {date} USD cheapest",
        f"{origin} to {destination} cheapest flight {date} airline price comparison",
        f"Kayak OR Skyscanner {origin} {destination} flight {date} price",
    ]

    parts = [f"=== Flight comparison: {trip} ===\n"]
    for query in queries:
        result = await _execute_web_search(query)
        parts.append(result)

    return "\n\n---\n\n".join(parts)


async def _execute_travel_insights(
    origin: str, destination: str, context: str = ""
) -> str:
    """Search Reddit and travel communities for money-saving tips on a route."""
    focus = context or "cheapest booking tips money saving"
    queries = [
        f"{origin} {destination} flights cheapest tips reddit",
        f"site:reddit.com {origin} {destination} flight deals save money",
        f"{origin} to {destination} flight {focus} travel hacks",
    ]

    parts = [f"=== Travel insights: {origin} → {destination} ===\n"]
    for query in queries:
        result = await _execute_web_search(query)
        parts.append(result)

    return "\n\n---\n\n".join(parts)


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
The host page DOM has just changed. Decide whether a proactive response is needed.

╔══ WHEN TO STAY SILENT (empty speech + empty actions) ══╗
  • Search results, flight cards, or price lists appeared    → SILENT
  • Minor re-renders, same fields, loading spinners          → SILENT
  • Any change you are not certain is a new booking step     → SILENT
  • Anything that looks like a results page or a list        → SILENT
╚═════════════════════════════════════════════════════════╝

╔══ WHEN TO SPEAK (actions = []) ══╗
  • A clearly new booking/checkout STEP appeared (e.g. passenger details
    form, seat selection, payment screen) — describe it briefly (≤ 20 words)
    and ask the user how to proceed.
╚══════════════════════════════════╝

╔══ WHEN TO FILL FIELDS (actions allowed) ══╗
  • New INPUT / SELECT / TEXTAREA fields appeared that are REQUIRED to
    complete a task the user explicitly asked for AND you have the values.
    Fill only those fields. Do not click any button afterwards.
╚═══════════════════════════════════════════╝

ABSOLUTE RULES — never break these:
  ✗ Never click ANY button, link, or result item (no "View Details",
    "Select", "Book", "Continue", "Search", or anything else).
  ✗ Never submit a form or navigate away from the current page.
  ✗ Never act on search results — only the USER decides which result to pick.
  ✗ When in doubt, return empty speech and empty actions.

Style: speech ≤ 20 words, plain language, no markdown.
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
- NEVER tell the user to check a website manually, open a new tab themselves, type something themselves,
  or perform any action on their own. You are their hands and voice. If you cannot do something, say
  "I wasn't able to get live prices from that site, but here's what I found:" and share what you DID
  find. Always offer a concrete next step you can take for them.
- If the page context contains "⚠ Page errors", read them carefully. They mean the previous action failed or the page rejected an input. Acknowledge the specific error to the user and suggest a concrete fix (e.g. try a different spelling, pick from the dropdown, check the date format). Do not repeat the same action that just failed.
- Complete the ENTIRE search form in a single action sequence. If the user says "fly from New York to LA next Monday", fill origin, destination, AND date, then click the search button — all in one response. Do NOT fill one field and ask "what should I fill next?" unless information is genuinely missing from what the user said.
- After filling all form fields, click the search/submit button if visible. Stop there — do NOT click result cards, "View Details", "Book", "Select", or any post-search button. Wait for the user to tell you what to do with the results.
- STOP / CANCEL COMMAND: If the user says "stop", "cancel", "pause", or "halt":
  • Immediately return EMPTY actions (actions = []).
  • Do NOT call any tool.
  • Speak: "Okay, stopped. What would you like to do?"
  • Do not attempt to resume or retry whatever you were doing before.
  • Keep the session live and wait for the user's next instruction.

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
3. If a plain text field already has a value, send clear before fill.
   IMPORTANT: Never use clear on airport/chip fields — use deselect instead.
   clear only works on plain <input> and <textarea> elements, not on chip UIs.
4. After filling a field, send key_press Tab to move focus naturally to the next field. This fires blur (triggering form validation) and focus on the next input — exactly what a real user does.
5. For buttons and links, use click only — no focus needed first.
6. For <select> dropdowns, use focus then select (not fill).
7. To submit a form, click the submit button. Never use key_press Enter on a field unless it is a search box with no submit button.
8. Never chain multiple fills without Tab between them.

Handling result items (flight cards, search results):
- Result items appear in the page context under "Result items" when search results are shown.
- Each item has an index, its full visible text (price, airline, times, etc.), and a selector.
- When results are present, READ and SUMMARISE the top 2–3 options to the user (price, airline, duration)
  and ASK which one they want. Do NOT click anything — just describe and wait.
- Only click a result item when the user EXPLICITLY instructs you to act on a specific result:
  e.g. "book the cheapest", "select the first one", "view details on that flight".
  In that case: parse the result text to identify the right item, then click its selector.
- Never guess a selector — only use selectors from the provided result items list.
- If no result items are present, tell the user the results haven't loaded yet and ask them to try again.
- NEVER proactively click "View Details", "Book", "Select", or any result card button without the user
  explicitly asking. Doing so navigates away from the results page and loses the other options.

Choosing the right action for dropdowns:
- Native <select> element (single): use focus then select (not fill).
- Native <select multiple> or custom multi-select chips/tags: use multi_select to add a value, deselect to remove one.
  - The page context will show "(multi-select)" and list currently selected values under "selected".
  - Use deselect before multi_select if you need to replace all selections — deselect each current value first.
  - For custom chip/tag UIs (no native select), multi_select clicks the option in the dropdown, deselect clicks the × remove button on the chip.
- Dynamic autocomplete / combobox (user types to search, options appear below): use search_select.
  search_select types the value, waits for the dropdown list to appear, and clicks the matching option.
  Never use fill on a dynamic autocomplete — it sets the text but doesn't select an option.
  IMPORTANT: Do NOT send a separate click or focus action before search_select. search_select handles
  opening and focusing the field internally. An extra click before search_select causes the action to
  fail because the results panel is already open when the search begins.
- For multi-select autocompletes (type to add multiple values, e.g. airport chips): use search_select for each value in sequence to add, and deselect to remove an existing chip.
  Example — user says "add Miami as a second origin":
    search_select #origin "Miami"
  Example — user says "remove Sioux Falls":
    deselect #origin "FSD Sioux Falls"
  The selector for deselect is the input field, not the chip — the widget finds the chip automatically by matching the value text.
- To REPLACE an existing chip selection (user wants a different airport):
  1. deselect each currently selected value shown in the page context under "selected".
  2. search_select the new value.
  Example — field shows selected: ["FSD Sioux Falls"], user wants "New York":
    deselect #origin "FSD Sioux Falls"
    search_select #origin "New York"
  Always deselect ALL existing chips before adding the new one unless the user explicitly says "add another".
- "Select multiple airports at once" / "Compare prices" button in a dropdown:
  Some airport fields show a button like "Select multiple airports at once and compare prices".
  Clicking it expands a checkbox list of nearby airports. To use it:
    click <selector-of-that-button>           ← opens the checkbox list
    click <selector-of-checkbox-for-airport>  ← tick each desired airport
  Use this when the user asks to compare prices across nearby airports.
  For a normal single-airport search, do NOT click that button — just use search_select directly.

Web search — call search_web BEFORE execute_actions when:
- You need an airport code or hub city for a country/region you're not certain about.
- A search_select just failed and you want to verify the correct search term before retrying.
After searching, synthesise the key insight into a brief speech (≤ 40 words) then include the
appropriate execute_actions. Do not search for information that is already visible in the page context.

Flight comparison — call compare_flights when the user's INTENT suggests wanting alternatives or
better prices, even if they don't use the word "compare". Triggers include:
- Explicit: "compare", "check other sites", "Kayak", "Skyscanner", "Google Flights", "Expedia"
- Price concern: "seems expensive", "is this good?", "can I find cheaper?", "too much", "that's a lot"
- Alternatives: "any better options?", "other flights?", "what else is there?", "look elsewhere"
- Value check: "is this a good deal?", "what do others pay?", "worth it?", "is that normal?"
After getting results, summarise the top 2–3 options across sites (airline, price, key differences)
in ≤ 50 words. Do NOT execute any DOM actions — just speak the comparison and ask what the user prefers.
If the search results don't contain live prices from a specific site, share what you DID find and offer
to search for a specific alternative (e.g. "I found prices starting at $X from [source]. Want me to
search specifically for [airline] or a connecting route that might be cheaper?"). Never say "check
[site] manually".

Travel insights — call get_travel_insights:
- PROACTIVELY whenever flight search results appear in the page context (result_items present)
  AND the user is asking about options or prices — do this automatically, without being asked.
- Whenever the user implies curiosity about saving money, timing, routes, or value:
  "any tips?", "save money", "cheaper way?", "better route", "is there a trick?", "advice?"
- After compare_flights results come back — run insights too to add community perspective.
After getting insights, weave the most useful finding naturally into your response:
  "I found something interesting — [insight]. This could save you around $X."
  "Reddit travelers suggest [tip] for this route, which could save about $X."
Only surface insights that are genuinely actionable (save money, time, or hassle). Skip generic tips.
Do NOT execute any DOM actions after get_travel_insights — just share the finding and ask the user
if they want to act on it.

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

        # Agentic loop — LLM may call search_web / compare_flights one or more
        # times before calling execute_actions. Cap at 8 iterations.
        for _iteration in range(8):
            response = await self._client.messages.create(
                model=settings.claude_model,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                tools=[SEARCH_WEB_TOOL, COMPARE_FLIGHTS_TOOL, GET_TRAVEL_INSIGHTS_TOOL, self._execute_tool],
                tool_choice={"type": "auto"},
                messages=messages,
            )

            # Convert response content to plain dicts once, categorised by type.
            text_blocks: list[dict] = []
            lookup_dicts: list[dict] = []   # search_web OR compare_flights calls
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
                    elif block.name in ("search_web", "compare_flights", "get_travel_insights"):
                        lookup_dicts.append(block_dict)
                    # Any other tool_use is silently dropped — avoids unmatched IDs.

            # LLM chose to act on the page — return immediately
            if execute_block:
                return AgentResponse.model_validate(execute_block.input)

            # LLM called one or more lookup tools (search_web / compare_flights / get_travel_insights).
            # Execute ALL of them and pair EVERY tool_use with its tool_result.
            # If we add N tool_use blocks to the assistant message we must add N
            # matching tool_results in the next user message (Anthropic rule).
            if lookup_dicts:
                tool_results = []
                for ld in lookup_dicts:
                    inp = ld["input"]
                    if ld["name"] == "search_web":
                        result = await _execute_web_search(inp.get("query", ""))
                    elif ld["name"] == "compare_flights":
                        result = await _execute_flight_comparison(
                            inp.get("origin", ""),
                            inp.get("destination", ""),
                            inp.get("date", ""),
                            inp.get("return_date"),
                        )
                    else:  # get_travel_insights
                        result = await _execute_travel_insights(
                            inp.get("origin", ""),
                            inp.get("destination", ""),
                            inp.get("context", ""),
                        )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": ld["id"],
                        "content": result,
                    })
                # assistant_content contains ONLY the lookup blocks we've responded
                # to — no orphaned tool_use IDs.
                messages.append({"role": "assistant", "content": text_blocks + lookup_dicts})
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

_OPENAI_COMPARE_FLIGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "compare_flights",
        "description": COMPARE_FLIGHTS_TOOL["description"],
        "parameters": COMPARE_FLIGHTS_TOOL["input_schema"],
    },
}

_OPENAI_GET_TRAVEL_INSIGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "get_travel_insights",
        "description": GET_TRAVEL_INSIGHTS_TOOL["description"],
        "parameters": GET_TRAVEL_INSIGHTS_TOOL["input_schema"],
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

        # Agentic loop — LLM may call search_web / compare_flights before execute_actions
        for _iteration in range(8):
            response = await self._client.chat.completions.create(
                model=settings.openai_model,
                tools=[_OPENAI_SEARCH_TOOL, _OPENAI_COMPARE_FLIGHTS_TOOL, _OPENAI_GET_TRAVEL_INSIGHTS_TOOL, _OPENAI_EXECUTE_TOOL],
                tool_choice="auto",
                messages=messages,
                max_tokens=1024,
            )

            msg = response.choices[0].message
            tool_calls = msg.tool_calls or []

            execute_call  = next((tc for tc in tool_calls if tc.function.name == "execute_actions"), None)
            lookup_calls  = [tc for tc in tool_calls if tc.function.name in ("search_web", "compare_flights", "get_travel_insights")]

            if execute_call:
                return AgentResponse.model_validate_json(execute_call.function.arguments or "{}")

            if lookup_calls:
                messages.append(msg.model_dump(exclude_unset=True))
                for lc in lookup_calls:
                    args = json.loads(lc.function.arguments or "{}")
                    if lc.function.name == "search_web":
                        result = await _execute_web_search(args.get("query", ""))
                    elif lc.function.name == "compare_flights":
                        result = await _execute_flight_comparison(
                            args.get("origin", ""),
                            args.get("destination", ""),
                            args.get("date", ""),
                            args.get("return_date"),
                        )
                    else:  # get_travel_insights
                        result = await _execute_travel_insights(
                            args.get("origin", ""),
                            args.get("destination", ""),
                            args.get("context", ""),
                        )
                    messages.append({
                        "role": "tool",
                        "tool_call_id": lc.id,
                        "content": result,
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
