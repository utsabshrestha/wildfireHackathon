/**
 * ADA Accessibility Widget — Injected Script
 *
 * This script is injected into the host page (flight booking site, gov portal, etc.)
 * by the loader snippet. It:
 *  - Listens for postMessage commands from the widget iframe
 *  - Executes DOM actions simulating real user input (proper browser events)
 *  - Scans the page and returns context to the widget
 *  - Watches for meaningful DOM changes via MutationObserver
 *
 * The agentActing flag prevents the mutation observer from firing update_context
 * while we are executing our own actions — avoiding the race condition / feedback loop.
 */

(function () {
  if (window.__adaInjected) return;
  window.__adaInjected = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let agentActing = false;   // true while we are executing a batch of actions
  let mutationTimer = null;

  // ---------------------------------------------------------------------------
  // Core: simulate real user input
  // React, Vue, Angular all watch native DOM events — direct .value = x is not enough.
  // ---------------------------------------------------------------------------

  function simulateFill(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(el, value);
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function simulateClick(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
  }

  function simulateKeyPress(el, key) {
    const opts = { key, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup',    opts));

    if (key === 'Tab') {
      el.blur();
      const focusable = getFocusableElements();
      const idx = focusable.indexOf(el);
      if (idx !== -1 && idx < focusable.length - 1) {
        focusable[idx + 1].focus();
      }
    }

    if (key === 'Enter') {
      el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }

  function getFocusableElements() {
    return Array.from(document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(isVisible);
  }

  // ---------------------------------------------------------------------------
  // search_select: type into a dynamic autocomplete, wait for options, click match
  // ---------------------------------------------------------------------------

  async function executeSearchSelect(el, value) {
    el.focus();
    simulateFill(el, value);

    const option = await waitForMatchingOption(value, 3000);
    if (!option) {
      return { success: false, error: `No dropdown option matched "${value}" within 3s` };
    }
    option.scrollIntoView({ block: 'nearest' });
    simulateClick(option);
    return { success: true };
  }

  async function waitForMatchingOption(searchValue, timeoutMs) {
    // Covers common autocomplete/combobox patterns across UI libraries
    const SELECTORS = [
      '[role="option"]',
      '[role="listitem"]',
      '[role="menuitem"]',
      '.dropdown-item',
      '.autocomplete-option',
      '.suggestion-item',
      '.react-select__option',
      '.Select-option',
      'li[data-value]',
    ].join(', ');

    const lower = searchValue.toLowerCase();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const options = document.querySelectorAll(SELECTORS);
      for (const opt of options) {
        if (isVisible(opt) && opt.textContent.trim().toLowerCase().includes(lower)) {
          return opt;
        }
      }
      await sleep(100);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Action executor
  // ---------------------------------------------------------------------------

  async function executeAction(action) {
    const el = document.querySelector(action.selector);
    if (!el) {
      return { success: false, error: `Element not found: ${action.selector}` };
    }

    switch (action.type) {
      case 'scroll':
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300); // let scroll settle
        return { success: true };

      case 'focus':
        el.focus();
        return { success: true };

      case 'clear':
        simulateFill(el, '');
        return { success: true };

      case 'fill':
        simulateFill(el, action.value ?? '');
        return { success: true };

      case 'select':
        el.focus();
        simulateFill(el, action.value ?? '');
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };

      case 'click':
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await sleep(100);
        simulateClick(el);
        return { success: true };

      case 'key_press':
        simulateKeyPress(el, action.value ?? '');
        return { success: true };

      case 'search_select':
        return await executeSearchSelect(el, action.value ?? '');

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }

  async function executeActions(actions) {
    agentActing = true;  // suppress mutation observer while we act
    const results = [];

    for (const action of actions) {
      try {
        const result = await executeAction(action);
        results.push({ action: action.type, selector: action.selector, ...result });
      } catch (err) {
        results.push({ action: action.type, selector: action.selector, success: false, error: err.message });
      }
      await sleep(80); // small gap so the page (React re-renders etc.) can react
    }

    // Keep the flag true for a buffer after the last action
    // so DOM mutations triggered by our actions don't fire update_context
    setTimeout(() => { agentActing = false; }, 400);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Page context scanner
  // Serializes visible form fields and buttons so the widget can send
  // page_context to the backend.
  // ---------------------------------------------------------------------------

  function scanPage() {
    const fields = [];
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      if (!isVisible(el)) return;

      const selector = bestSelector(el);
      const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const label = labelEl?.textContent?.trim()
        || el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || null;

      const field = {
        selector,
        label,
        field_type: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
        value: el.value || null,
        placeholder: el.placeholder || null,
        required: el.required || false,
        aria_label: el.getAttribute('aria-label') || null,
      };

      if (el.tagName === 'SELECT') {
        field.options = Array.from(el.options).map(o => o.text.trim()).filter(Boolean);
      }

      fields.push(field);
    });

    const buttons = [];
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach((el) => {
      if (!isVisible(el)) return;
      buttons.push({
        selector: bestSelector(el),
        text: (el.textContent || el.value || '').trim(),
        aria_label: el.getAttribute('aria-label') || null,
        disabled: el.disabled || false,
      });
    });

    return { url: window.location.href, title: document.title, fields, buttons };
  }

  function bestSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    // Fallback: tag + index among siblings of same type
    const siblings = Array.from(el.parentElement?.querySelectorAll(el.tagName) ?? []);
    const idx = siblings.indexOf(el) + 1;
    return `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
  }

  function isVisible(el) {
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && !!el.offsetParent;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // postMessage bridge — widget iframe <-> host page
  // ---------------------------------------------------------------------------

  window.addEventListener('message', async (event) => {
    if (!event.data || event.data.source !== 'ada-widget') return;

    if (event.data.type === 'execute_actions') {
      const results = await executeActions(event.data.actions || []);
      event.source?.postMessage({ source: 'ada-host', type: 'action_results', results }, '*');
    }

    if (event.data.type === 'scan_page') {
      const context = scanPage();
      event.source?.postMessage({ source: 'ada-host', type: 'page_context', context }, '*');
    }
  });

  // ---------------------------------------------------------------------------
  // Mutation observer — watches for real page changes (new steps, new fields)
  // Suppressed while agentActing is true to avoid the race condition:
  //   agent fills field → DOM mutates → update_context → LLM fills again → loop
  // ---------------------------------------------------------------------------

  const observer = new MutationObserver(() => {
    if (agentActing) return;

    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const context = scanPage();
      const iframe = document.querySelector('iframe[data-ada-widget]');
      iframe?.contentWindow?.postMessage(
        { source: 'ada-host', type: 'dom_changed', context },
        '*'
      );
    }, 500); // 500ms debounce — wait for DOM to settle before scanning
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,    // skip attribute changes — too noisy
    characterData: false,
  });
})();
