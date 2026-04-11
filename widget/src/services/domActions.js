/**
 * DOM Actions service.
 *
 * Executes ordered DOM actions sent by the backend agent (fill, click, select, etc.)
 * on the host page. The widget JS runs in the host page's window scope (Shadow DOM
 * only isolates CSS), so document.querySelector targets the host page correctly.
 *
 * Race-condition guard
 * ────────────────────
 * When we programmatically fill fields, those changes fire MutationObserver events
 * in websocket.js → observeDomChanges. Without a guard this creates a loop:
 *
 *   fill field → DOM mutates → update_context sent → LLM replies → fill field → …
 *
 * We break the loop with the `isMutating` flag. observeDomChanges checks it before
 * scheduling an update_context send. Any mutation that occurs while we are executing
 * actions is our own change — skip it.
 */

/**
 * True while executeDomActions is running.
 * Exported so observeDomChanges can read it.
 */
export let isMutating = false

/**
 * Execute a batch of DOM actions on the host page.
 * Sets isMutating=true for the entire batch + a short settling window
 * so that any React/Vue re-renders triggered by our changes are also suppressed.
 *
 * @param {Array<{type: string, selector: string, value?: string}>} actions
 */
export function executeDomActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return

  isMutating = true
  console.log('[widget:dom] Executing', actions.length, 'action(s) — observer suppressed')

  for (const action of actions) {
    try {
      _executeAction(action)
    } catch (err) {
      console.error('[widget:dom] Action failed:', action, err)
    }
  }

  // Keep the flag set for one more event-loop tick so that synchronous
  // re-renders triggered by our dispatched events are also swallowed,
  // then add a short buffer for async framework re-renders (React, Vue).
  setTimeout(() => {
    isMutating = false
    console.log('[widget:dom] Observer re-enabled')
  }, 300)
}

function _executeAction({ type, selector, value }) {
  const el = document.querySelector(selector)

  if (!el) {
    console.warn(`[widget:dom] Element not found: "${selector}"`)
    return
  }

  switch (type) {
    case 'fill': {
      el.value = value ?? ''
      // Dispatch input + change so React/Vue/Angular detect the programmatic change
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      console.log(`[widget:dom] Filled "${selector}" → "${value}"`)
      break
    }
    case 'select': {
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
    case 'scroll': {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      console.log(`[widget:dom] Scrolled to "${selector}"`)
      break
    }
    default:
      console.warn(`[widget:dom] Unknown action type: "${type}"`)
  }
}
