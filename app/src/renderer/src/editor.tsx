import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/michroma'
import './assets/main.css'

// Side-effect import: subscribes to editor:open-tab at module scope, before React renders.
import './components/editor/editorBootstrap'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorApp } from './components/editor/EditorApp'
import { uiStore } from './lib/uiStore'

// This window's import graph never reaches App, which is what pulls uiStore into the main
// window. Without this call `data-theme` is never set (theme.css's dark tokens live on bare
// `:root`, so a light-theme user gets a black editor window) and the UI zoom factor — a
// per-renderer webFrame setting — stays at 1.0 whatever the user chose.
uiStore.applyToDocument()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>
)
