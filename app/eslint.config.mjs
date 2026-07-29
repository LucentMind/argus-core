import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // Plain Node .mjs spike scripts (Phase-2 Copilot SDK capture harness) live
  // outside the TS project and are not built; exclude them from the
  // TypeScript-oriented lint rules (e.g. explicit-function-return-type).
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'scripts/spike-copilot/**',
      'scripts/testscript/**',
      'scripts/acp-spike.mjs'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  // electron-builder hooks (build/*.cjs) are loaded with require() by
  // electron-builder itself and must stay CommonJS.
  {
    files: ['build/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // Plain Node .mjs utility scripts (fixtures, smoke checks, runtime probes) run directly under
  // `node`, never compiled — TypeScript return-type annotations aren't valid syntax here.
  // @electron-toolkit/eslint-config-ts already turns this rule off for `*.mjs`, but that glob is
  // root-only in flat config and doesn't reach nested `scripts/**`, so restate it for this dir.
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
