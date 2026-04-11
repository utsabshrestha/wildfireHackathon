import { render, h } from 'preact'
import { config } from './config.js'
import { Widget } from './Widget.jsx'
import widgetCss from './styles/widget.css?inline'

function mount() {
  // Create the shadow host element
  const host = document.createElement('div')
  host.id = 'voice-widget-host'
  host.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    inset: 0;
  `
  document.body.appendChild(host)

  // Attach Shadow DOM for full CSS isolation
  const shadowRoot = host.attachShadow({ mode: 'open' })

  // Inject widget styles into the shadow root
  const style = document.createElement('style')
  style.textContent = widgetCss
  shadowRoot.appendChild(style)

  // Apply theme color as CSS custom property
  host.style.setProperty('--widget-primary', config.themeColor)

  // Mount the Preact widget tree into the shadow root
  const container = document.createElement('div')
  container.id = 'voice-widget-root'
  shadowRoot.appendChild(container)

  render(h(Widget, { config }), container)
}

// Mount after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
