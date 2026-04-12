/**
 * DOM Actions service.
 *
 * Executes ordered DOM actions sent by the backend agent on the host page.
 *
 * Race-condition guard
 * ────────────────────
 * When we programmatically fill fields, those changes fire MutationObserver events
 * in websocket.js → observeDomChanges. Without a guard this creates a loop:
 *
 *   fill field → DOM mutates → update_context sent → LLM replies → fill field → …
 *
 * We break the loop with the `isMutating` flag. observeDomChanges checks it before
 * scheduling an update_context send.
 */

/** True while executeDomActions is running. Exported so observeDomChanges can read it. */
export let isMutating = false

/**
 * Execute a batch of DOM actions on the host page.
 * Async because search_select must wait for autocomplete options to appear.
 * Awaiting this ensures TTS speaks only after all actions have finished.
 *
 * @param {Array<{type: string, selector: string, value?: string}>} actions
 */
export async function executeDomActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return

  isMutating = true
  console.log('[widget:dom] Executing', actions.length, 'action(s) — observer suppressed')

  for (const action of actions) {
    try {
      await _executeAction(action)
    } catch (err) {
      console.error('[widget:dom] Action failed:', action, err)
    }
  }

  // Keep the flag set for a short buffer so React/Vue re-renders triggered
  // by our events are also suppressed before we re-enable the observer.
  setTimeout(() => {
    isMutating = false
    console.log('[widget:dom] Observer re-enabled')
  }, 400)
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

async function _executeAction({ type, selector, value }) {
  const el = document.querySelector(selector)

  if (!el) {
    console.warn(`[widget:dom] Element not found: "${selector}"`)
    return
  }

  switch (type) {
    case 'scroll':
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      await _sleep(300)
      break

    case 'focus':
      el.focus()
      break

    case 'clear':
      _simulateFill(el, '')
      break

    case 'fill':
      // Use native setter so React's synthetic event system picks up the change.
      // Plain el.value = x is ignored by React; InputEvent (not Event) is required.
      _simulateFill(el, value ?? '')
      console.log(`[widget:dom] Filled "${selector}" → "${value}"`)
      break

    case 'select':
      el.focus()
      _simulateFill(el, value ?? '')
      el.dispatchEvent(new Event('change', { bubbles: true }))
      console.log(`[widget:dom] Selected "${value}" in "${selector}"`)
      break

    case 'multi_select':
      await _executeMultiSelect(el, value ?? '')
      break

    case 'deselect':
      await _executeDeselect(el, value ?? '')
      break

    case 'click':
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      await _sleep(80)
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }))
      console.log(`[widget:dom] Clicked "${selector}"`)
      break

    case 'key_press': {
      const key = value ?? 'Tab'
      el.dispatchEvent(new KeyboardEvent('keydown',  { key, bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup',    { key, bubbles: true }))
      if (key === 'Tab') {
        el.blur()
        const focusable = _getFocusableElements()
        const idx = focusable.indexOf(el)
        if (idx !== -1 && idx < focusable.length - 1) focusable[idx + 1].focus()
      }
      if (key === 'Enter') {
        el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
      console.log(`[widget:dom] Key press "${key}" on "${selector}"`)
      break
    }

    case 'search_select':
      await _executeSearchSelect(el, value ?? '')
      break

    default:
      console.warn(`[widget:dom] Unknown action type: "${type}"`)
  }
}

// ---------------------------------------------------------------------------
// multi_select  — add a value to a native <select multiple> or custom chip UI
// ---------------------------------------------------------------------------

/**
 * Add a value to a multi-select field.
 *
 * Handles two patterns:
 *   1. Native <select multiple>: find the matching <option> and select it.
 *   2. Custom chip/tag UI: open the dropdown (click or focus), then click
 *      the matching option using the same scored matching as search_select.
 */
async function _executeMultiSelect(el, value) {
  // Native <select multiple>
  if (el.tagName === 'SELECT' && el.multiple) {
    const lower = value.toLowerCase()
    for (const opt of el.options) {
      if (opt.text.toLowerCase() === lower || opt.value.toLowerCase() === lower) {
        opt.selected = true
        el.dispatchEvent(new Event('change', { bubbles: true }))
        console.log(`[widget:dom] multi_select: selected native option "${opt.text}"`)
        return
      }
    }
    console.warn(`[widget:dom] multi_select: no native option matches "${value}"`)
    return
  }

  // Custom chip/tag UI — open dropdown then click matching option
  el.focus()
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  await _sleep(200)

  const option = await _pollForOption(value, 2000)
  if (!option) {
    console.warn(`[widget:dom] multi_select: no dropdown option found for "${value}"`)
    return
  }

  option.scrollIntoView({ block: 'nearest' })
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  option.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }))
  option.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  console.log(`[widget:dom] multi_select: clicked option "${option.textContent?.trim()}"`)
}

// ---------------------------------------------------------------------------
// deselect  — remove a value from a native <select multiple> or custom chip
// ---------------------------------------------------------------------------

/**
 * Remove a specific value from a multi-select field.
 *
 * Handles two patterns:
 *   1. Native <select multiple>: find the matching selected <option> and deselect it.
 *   2. Custom chip/tag UI (e.g. airport tags with × button):
 *      - First searches near the target input (its container) to avoid matching
 *        chips from a different field on the same page.
 *      - Two chip-finding strategies:
 *          a. Class-based: [class*="chip"], [class*="tag"], [class*="token"], etc.
 *          b. Structural: any small visible element that contains the text AND
 *             has a child remove button — catches sites with no standard class names.
 *      - Clicks the × / remove button inside the chip, or the chip itself if
 *        it acts as a toggle.
 */
async function _executeDeselect(el, value) {
  const lower = value.toLowerCase()

  // ── Native <select multiple> ──────────────────────────────────────────────
  if (el.tagName === 'SELECT' && el.multiple) {
    for (const opt of el.options) {
      if (opt.selected && (opt.text.toLowerCase() === lower || opt.value.toLowerCase() === lower)) {
        opt.selected = false
        el.dispatchEvent(new Event('change', { bubbles: true }))
        console.log(`[widget:dom] deselect: deselected native option "${opt.text}"`)
        return
      }
    }
    console.warn(`[widget:dom] deselect: no selected native option matches "${value}"`)
    return
  }

  // ── Custom chip UI ────────────────────────────────────────────────────────
  // Search within the input's container first; fall back to whole document.
  const container = _findChipContainer(el)
  const searchRoot = container || document.body

  const chip = _findChipByText(searchRoot, lower)
  if (!chip) {
    console.warn(`[widget:dom] deselect: no chip found for "${value}"`)
    return
  }

  const removeBtn = _findRemoveButton(chip)
  const target = removeBtn || chip

  target.scrollIntoView({ block: 'nearest' })
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  target.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }))
  target.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }))
  console.log(`[widget:dom] deselect: removed "${chip.textContent?.trim()}" via ${removeBtn ? 'remove button' : 'chip click'}`)
}

/**
 * Walk up from an input to find the ancestor that holds its chips.
 * Stops at the first ancestor that visibly contains chip-like elements.
 */
function _findChipContainer(inputEl) {
  let node = inputEl.parentElement
  for (let i = 0; i < 6 && node && node !== document.body; i++) {
    if (node.querySelectorAll('[class*="chip"],[class*="tag"],[class*="token"],[class*="badge"],[class*="pill"]').length > 0) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * Find a visible chip whose text includes `lower`.
 *
 * Strategy 1 — class-based: well-known chip class patterns.
 * Strategy 2 — structural: any small visible element that (a) contains the
 * text and (b) has a child element that looks like a remove button.
 * This catches flight-booking sites that use bespoke class names.
 */
function _findChipByText(root, lower) {
  const CHIP_SELECTORS = [
    '[class*="chip"]', '[class*="tag"]', '[class*="token"]',
    '[class*="badge"]', '[class*="pill"]', '[class*="select"]',
    '[role="option"][aria-selected="true"]',
  ].join(', ')

  const byClass = Array.from(root.querySelectorAll(CHIP_SELECTORS))
    .find(c => _isVisible(c) && (c.textContent || '').toLowerCase().includes(lower))
  if (byClass) return byClass

  // Structural fallback: small visible element containing the text that has
  // a remove button inside it (button / svg / ×-like span).
  return Array.from(root.querySelectorAll('*')).find(el => {
    if (!_isVisible(el)) return false
    const text = (el.textContent || '').trim().toLowerCase()
    // Must contain the target text and be compact (not a large container)
    if (!text.includes(lower) || text.length > lower.length + 60) return false
    return !!_findRemoveButton(el)
  }) || null
}

/** Find a × / remove button inside a chip element. */
function _findRemoveButton(chip) {
  return (
    chip.querySelector('[aria-label*="remove" i],[aria-label*="delete" i],[aria-label*="close" i]') ||
    chip.querySelector('[title*="remove" i],[title*="delete" i],[title*="close" i]') ||
    chip.querySelector('button,[role="button"]') ||
    chip.querySelector('svg') ||
    chip.querySelector('span[class*="close"],span[class*="remove"],span[class*="delete"],span[class*="clear"],span[class*="times"]')
  )
}

// ---------------------------------------------------------------------------
// search_select
// ---------------------------------------------------------------------------

/**
 * Type into an autocomplete field and select the best matching option.
 *
 * Problems this solves:
 *   1. Debounce — types char-by-char so the debounced handler fires naturally.
 *   2. Early results — checks for options after every char (min 2); stops
 *      typing as soon as a match appears instead of always typing the full value.
 *   3. Partial / formatted options — scored matching handles "New York" → "New York (JFK)".
 *   4. Value doesn't exist — falls back to progressively shorter word-prefixes so
 *      the autocomplete can still surface relevant options.
 */
async function _executeSearchSelect(el, value) {
  el.focus()
  _simulateFill(el, '')
  await _sleep(80)

  // Snapshot which dropdown containers are already visible BEFORE we type.
  // After typing, we only trust options from containers that are NEW —
  // appeared because the site responded to our input, not pre-existing
  // nav menus, recent-search panels, or other page elements.
  const preExisting = _snapshotVisibleDropdowns()

  // ── Phase 1: type char-by-char ──────────────────────────────────────────
  for (const char of value) {
    if (document.activeElement !== el) el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }))
    _nativeSetter(el).call(el, el.value + char)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }))
    await _sleep(60)
  }
  // No 'change' here — can close dropdowns on some sites.

  // ── Phase 2: wait for real search results to appear ─────────────────────
  console.log(`[widget:dom] search_select: typed "${value}", waiting for results...`)
  let option = await _pollForOption(value, 5000, el, preExisting)

  // ── Phase 3: retry with shorter prefixes ────────────────────────────────
  if (!option) {
    const words = value.trim().split(/\s+/)
    for (let n = words.length - 1; n >= 1 && !option; n--) {
      const prefix = words.slice(0, n).join(' ')
      if (prefix.length < 2) break

      console.log(`[widget:dom] search_select: no results — retrying with "${prefix}"`)
      _simulateFill(el, '')
      await _sleep(80)

      for (const char of prefix) {
        if (document.activeElement !== el) el.focus()
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }))
        _nativeSetter(el).call(el, el.value + char)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }))
        await _sleep(60)
      }

      option = await _pollForOption(value, 3000, el, preExisting)
    }
  }

  if (!option) {
    _simulateFill(el, '')
    console.warn(`[widget:dom] search_select: no real result found for "${value}" — field cleared`)
    return
  }

  // ── Click the matched option ─────────────────────────────────────────────
  option.scrollIntoView({ block: 'nearest' })
  el.focus()
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  option.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }))
  option.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new Event('change', { bubbles: true }))

  console.log(`[widget:dom] search_select: selected "${option.textContent?.trim()}"`)
}

/**
 * Record all dropdown-like containers that are currently visible.
 * After typing we filter these out so we only consider newly appeared results.
 */
function _snapshotVisibleDropdowns() {
  const snapshot = new Set()
  // Semantic containers
  document.querySelectorAll('ul, ol, [role="listbox"], [role="menu"]').forEach(el => {
    if (_isVisible(el)) snapshot.add(el)
  })
  // Body-level portals (React createPortal)
  Array.from(document.body.children).forEach(el => {
    if (_isVisible(el)) snapshot.add(el)
  })
  return snapshot
}

/**
 * Poll every 100 ms until a matching option appears or timeout is reached.
 * @param {string}       searchValue
 * @param {number}       timeoutMs
 * @param {Element|null} inputEl    — input element, for proximity detection
 * @param {Set|null}     preExisting — containers visible before typing; new ones are dropdown results
 */
async function _pollForOption(searchValue, timeoutMs, inputEl = null, preExisting = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = _bestMatchingOption(searchValue, inputEl, preExisting)
    if (match) return match
    await _sleep(100)
  }
  return null
}

/**
 * Find the best visible dropdown option for a search string.
 *
 * Three targeted strategies (in order of reliability):
 *
 *   1. ARIA roles + known UI-library class names — most reliable when present.
 *
 *   2. Positioned dropdown containers — ul, ol, div[role="listbox/menu"] that
 *      are absolutely/fixed-positioned or have high z-index. Collects their
 *      semantic children (li, [role="option"]) first; falls back to direct
 *      children only if no semantic items exist.
 *      NOTE: does NOT include [role="combobox"] — that's the input, not the list.
 *
 *   3. Proximity — positioned containers that are spatially near the input.
 *      Two sub-strategies to avoid scanning the entire document:
 *        a. Walk up the input's ancestors and search their positioned descendants.
 *        b. Check body-level portals (React createPortal) that overlap the input.
 *      Only runs when strategies 1+2 found fewer than 2 candidates.
 *
 * Scoring (higher = better):
 *   100 exact · 80 option starts-with search · 70 search starts-with option
 *   60 option contains search · 40 word-level overlap
 */
/**
 * Find the best visible dropdown option for a search string.
 *
 * Only considers containers that are NEW since typing started (not in
 * `preExisting`), so pre-existing nav menus, "recent searches" panels,
 * and other page elements are never mistaken for real search results.
 *
 * Three strategies:
 *   1. ARIA roles + known UI-library class names.
 *   2. Visible positioned containers (ul/ol/[role=listbox/menu]) that
 *      weren't already visible before typing.
 *   3. Proximity fallback — positioned containers near the input that
 *      appeared after typing (ancestor walk + body portals).
 *
 * Scoring: 100 exact · 80 starts-with · 70 search-starts-with-option
 *          60 contains · 30 word-overlap (minimum 30 required)
 *
 * @param {string}       searchValue
 * @param {Element|null} inputEl     — for proximity detection
 * @param {Set|null}     preExisting — containers visible before typing started
 */
function _bestMatchingOption(searchValue, inputEl = null, preExisting = null) {
  const lower = searchValue.toLowerCase().trim()
  const searchWords = lower.split(/\s+/).filter(Boolean)
  const candidates = new Set()

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** True if `container` appeared after typing started (not pre-existing). */
  function isNew(container) {
    return !preExisting || !preExisting.has(container)
  }

  function isPositionedDropdown(el) {
    const s = window.getComputedStyle(el)
    return s.position === 'absolute' || s.position === 'fixed' || (parseInt(s.zIndex) || 0) > 10
  }

  function addFromContainer(container) {
    const semantic = Array.from(
      container.querySelectorAll('li, [role="option"], [role="menuitem"]')
    ).filter(_isVisible)

    if (semantic.length > 0) {
      semantic.forEach(el => candidates.add(el))
    } else {
      // Flat list — short direct children only (skip header/footer rows)
      Array.from(container.children).forEach(child => {
        if (!_isVisible(child)) return
        const text = (child.textContent || '').trim()
        if (text.length > 0 && text.length < 200) candidates.add(child)
      })
    }
  }

  // ── Strategy 1: ARIA roles + known UI-library class names ─────────────────
  // These are reliable regardless of preExisting — ARIA option roles only
  // appear when a dropdown is genuinely open.
  const EXPLICIT_SELECTORS = [
    '[role="option"]', '[role="menuitem"]',
    '.dropdown-item', '.autocomplete-option', '.suggestion-item',
    '.react-select__option', '.Select-option',
    'li[data-value]', 'li[data-id]', 'li[data-agent-read]',
  ].join(', ')
  document.querySelectorAll(EXPLICIT_SELECTORS).forEach(el => {
    if (_isVisible(el)) candidates.add(el)
  })

  // ── Strategy 2: new visible positioned containers ─────────────────────────
  document.querySelectorAll('ul, ol, [role="listbox"], [role="menu"]').forEach(container => {
    if (!_isVisible(container) || !isPositionedDropdown(container)) return
    if (!isNew(container)) return   // skip menus that were already on screen
    addFromContainer(container)
  })

  // ── Strategy 3: proximity (only when 1+2 found nothing) ──────────────────
  if (inputEl && candidates.size === 0) {
    const inputRect = inputEl.getBoundingClientRect()

    function isNearInput(rect) {
      return (
        rect.top  >= inputRect.top  - 20 &&
        rect.top  <= inputRect.bottom + 450 &&
        rect.left <  inputRect.right + 100 &&
        rect.right > inputRect.left  - 100
      )
    }

    // 3a: walk up ancestors, look for new positioned descendants near the input
    let ancestor = inputEl.parentElement
    for (let i = 0; i < 5 && ancestor && ancestor !== document.body; i++) {
      ancestor.querySelectorAll('div, ul').forEach(container => {
        if (container === inputEl || container.contains(inputEl)) return
        if (!_isVisible(container) || !isPositionedDropdown(container)) return
        if (!isNew(container)) return
        if (!isNearInput(container.getBoundingClientRect())) return
        addFromContainer(container)
      })
      ancestor = ancestor.parentElement
    }

    // 3b: body-level portals (React createPortal) near the input
    if (candidates.size === 0) {
      Array.from(document.body.children).forEach(portal => {
        if (!_isVisible(portal)) return
        const s = window.getComputedStyle(portal)
        if (s.position !== 'absolute' && s.position !== 'fixed') return
        if (!isNew(portal)) return
        if (!isNearInput(portal.getBoundingClientRect())) return
        addFromContainer(portal)
      })
    }
  }

  // ── Score each candidate ──────────────────────────────────────────────────
  let best = null
  let bestScore = 0

  for (const opt of candidates) {
    if (!_isVisible(opt)) continue
    const text = (opt.textContent || '').trim().toLowerCase()
    if (!text) continue

    let score = 0
    if (text === lower)                                   score = 100
    else if (text.startsWith(lower))                      score = 80
    else if (lower.startsWith(text) && text.length >= 2)  score = 70
    else if (text.includes(lower))                        score = 60
    else {
      const optWords = text.split(/\s+/).filter(Boolean)
      const overlap = searchWords.filter(w => optWords.some(ow => ow.includes(w) || w.includes(ow)))
      // Require that the majority of search words match to avoid weak partial hits
      const ratio = overlap.length / searchWords.length
      if (ratio >= 0.5) score = Math.round(30 * ratio)
    }

    if (score > bestScore) { bestScore = score; best = opt }
  }

  return bestScore > 0 ? best : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set an input value in a way React/Vue/Angular all recognise.
 * Direct .value assignment is ignored; the native setter + InputEvent is required.
 */
function _simulateFill(el, value) {
  _nativeSetter(el).call(el, value)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function _nativeSetter(el) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  return Object.getOwnPropertyDescriptor(proto, 'value').set
}

function _getFocusableElements() {
  return Array.from(document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(_isVisible)
}

function _isVisible(el) {
  const s = window.getComputedStyle(el)
  return s.display !== 'none' && s.visibility !== 'hidden' && !!el.offsetParent
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
