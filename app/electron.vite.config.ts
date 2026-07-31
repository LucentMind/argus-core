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
      // Emit every asset as a file instead of inlining small ones as base64 `data:` URIs.
      // Both windows ship `default-src 'self'` with `data:` widened for images only, so an
      // inlined font is blocked at runtime — and only in a packaged build, since dev serves
      // the same asset same-origin over http and never inlines. Vite's default 4096-byte
      // threshold caught exactly one file, the 2028-byte JetBrains Mono Cyrillic-Extended
      // subset, which shipped blocked. Keeping this at 0 makes "every bundled asset is
      // same-origin" true by construction, so no future small asset can reintroduce this.
      // Guarded by scripts/check-renderer-csp.mjs, which runs at the end of `npm run build`.
      assetsInlineLimit: 0,
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
