/**
 * DOM Actions service — Phase 2 stub.
 *
 * When the backend agent wants to fill a flight booking form automatically,
 * it sends a `dom_action` message with an array of actions. This service
 * executes those actions on the host page's DOM.
 *
 * The widget JS runs in the host page's window scope (Shadow DOM only isolates
 * CSS, not JS), so `document.querySelector` here targets the host page — exactly
 * what we want for Phase 2.
 *
 * Protocol:
 * {
 *   "type": "dom_action",
 *   "sessionId": "sess_abc",
 *   "actions": [
 *     { "action": "fill",   "selector": "#departure",   "value": "JFK" },
 *     { "action": "fill",   "selector": "#destination", "value": "LHR" },
 *     { "action": "fill",   "selector": "#depart-date", "value": "2026-04-18" },
 *     { "action": "select", "selector": "#passengers",  "value": "2" },
 *     { "action": "click",  "selector": "#search-btn" }
 *   ]
 * }
 */

/**
 * Execute a batch of DOM actions on the host page.
 * @param {Array<{action: string, selector: string, value?: string}>} actions
 */
export function executeDomActions(actions) {
  if (!Array.isArray(actions)) {
    console.warn('[widget:dom] executeDomActions called with non-array:', actions)
    return
  }

  for (const action of actions) {
    try {
      _executeAction(action)
    } catch (err) {
      console.error('[widget:dom] Action failed:', action, err)
    }
  }
}

function _executeAction({ action, selector, value }) {
  const el = document.querySelector(selector)

  if (!el) {
    console.warn(`[widget:dom] Element not found for selector: "${selector}"`)
    return
  }

  switch (action) {
    case 'fill': {
      // Set the value
      el.value = value ?? ''
      // Dispatch both 'input' and 'change' events so React/Vue/Angular
      // detect the programmatic change through their event interceptors
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      console.log(`[widget:dom] Filled "${selector}" with "${value}"`)
      break
    }

    case 'select': {
      // Works for <select> elements
      el.value = value ?? ''
      el.dispatchEvent(new Event('change', { bubbles: true }))
      console.log(`[widget:dom] Selected "${value}" in "${selector}"`)
      break
    }

    case 'click': {
      el.click()
      console.log(`[widget:dom] Clicked "${selector}"`)
      break
    }

    case 'focus': {
      el.focus()
      console.log(`[widget:dom] Focused "${selector}"`)
      break
    }

    case 'clear': {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      console.log(`[widget:dom] Cleared "${selector}"`)
      break
    }

    default:
      console.warn(`[widget:dom] Unknown action type: "${action}"`)
  }
}
