import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: [/^@langfuse\//, /^@opentelemetry\//]
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          panel: resolve('src/preload/panel.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // Both entries must be listed: naming an explicit input replaces
        // electron-vite's default (index.html), so omitting it breaks the main window.
        input: {
          index: resolve('src/renderer/index.html'),
          editor: resolve('src/renderer/editor.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
