import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  build: {
    lib: {
      entry: 'src/main.js',
      name: 'VoiceWidget',
      fileName: 'widget',
      formats: ['iife'],
    },
    rollupOptions: {
      // Nothing external — everything bundled in
    },
    cssCodeSplit: false,
  },
})
