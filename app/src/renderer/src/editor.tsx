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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>
)
