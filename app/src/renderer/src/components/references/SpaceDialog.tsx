import { useEffect, useState } from 'react'
import { Btn } from '../ui'
import { PageTree } from './PageTree'
import { SyncReportView } from './SyncReportView'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import {
  toggleSelection,
  DEFAULT_ROUTING_RULES,
  type SpaceConfig,
  type TreeNodeVM,
  type SyncReport
} from '../../../../shared/referenceSync'

type Step =
  | { step: 'entry'; keyInput: string; busy: boolean; error: string | null }
  | { step: 'curate'; space: SpaceConfig; root: TreeNodeVM; busy: boolean; error: string | null }
  | { step: 'report'; report: SyncReport }

/**
 * Multi-step add/manage-space dialog (spec §3.2): entry (space key →
 * validate) → curate (tri-state tree) → confirm (Save / Save & Sync) →
 * report (SyncReportView). In manage mode (`existing` set) we skip straight
 * to validating the existing key and keep its selection/rules, only
 * refreshing the space name/homepage/root from the server.
 */
export function SpaceDialog({
  existing,
  onClose
}: {
  existing?: SpaceConfig
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<Step>({
    step: 'entry',
    keyInput: existing?.key ?? '',
    busy: false,
    error: null
  })
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    const off = window.argus.refsync.onProgress((p) => setProgress(p.message))
    return off
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const validate = async (key: string): Promise<void> => {
    setState({ step: 'entry', keyInput: key, busy: true, error: null })
    const r = await window.argus.refsync.validateSpace(key.trim())
    if (!r.ok) {
      setState({ step: 'entry', keyInput: key, busy: false, error: r.message })
      return
    }
    // manage mode: keep the existing selection/rules, just refresh identity fields
    const space: SpaceConfig = existing
      ? {
          ...existing,
          name: r.value.space.name,
          homepageId: r.value.space.homepageId
        }
      : {
          key: r.value.space.key,
          name: r.value.space.name,
          homepageId: r.value.space.homepageId,
          includeRoots: [],
          excludedSubtrees: [],
          routingRules: DEFAULT_ROUTING_RULES
        }
    setState({ step: 'curate', space, root: r.value.root, busy: false, error: null })
  }

  // manage-selection mode: jump straight into validation of the existing key
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only probe with controlled setState
    if (existing) void validate(existing.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (space: SpaceConfig, root: TreeNodeVM, runSync: boolean): Promise<void> => {
    setState({ step: 'curate', space, root, busy: true, error: null })
    referenceSyncStore.set(await window.argus.refsync.saveSpace(space))
    if (!runSync) {
      onClose()
      return
    }
    const r = await window.argus.refsync.sync(space.key)
    setProgress(null)
    if (!r.ok) {
      setState({ step: 'curate', space, root, busy: false, error: r.message })
      return
    }
    setState({ step: 'report', report: r.value })
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={existing ? `manage · ${existing.key}` : 'add confluence space'}
        className="flex max-h-[85vh] w-[42rem] flex-col gap-3 overflow-y-auto rounded-r4 border border-hair2 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {state.step === 'entry' && (
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">
              {existing ? `Manage · ${existing.key}` : 'Add Confluence space'}
            </div>
            <input
              aria-label="space key"
              className="rounded-r2 bg-black/20 px-2 py-1 text-sm"
              placeholder="Space key, e.g. NAVNATIVE"
              value={state.keyInput}
              disabled={state.busy}
              onChange={(e) => setState({ ...state, keyInput: e.target.value })}
            />
            {state.error && (
              <div role="alert" className="text-danger text-xs">
                {state.error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={onClose}>
                Cancel
              </Btn>
              <Btn
                variant="primary"
                disabled={state.busy || !state.keyInput.trim()}
                onClick={() => void validate(state.keyInput)}
              >
                Validate
              </Btn>
            </div>
          </div>
        )}
        {state.step === 'curate' && (
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">
              {state.space.name} <span className="text-faint">({state.space.key})</span>
            </div>
            <PageTree
              space={state.space}
              root={state.root}
              loadChildren={async (id) => {
                const r = await window.argus.refsync.children(state.space.key, id)
                return r.ok ? r.value : []
              }}
              onToggle={(id, ancestors) =>
                setState({ ...state, space: toggleSelection(state.space, id, ancestors) })
              }
            />
            <div className="text-dim text-xs">
              {state.space.includeRoots.length} selected, {state.space.excludedSubtrees.length}{' '}
              excluded
            </div>
            {progress && <div className="text-faint text-xs">{progress}</div>}
            {state.error && (
              <div role="alert" className="text-danger text-xs">
                {state.error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={onClose}>
                Cancel
              </Btn>
              <Btn
                variant="outline"
                disabled={state.busy}
                onClick={() => void save(state.space, state.root, false)}
              >
                Save
              </Btn>
              <Btn
                variant="primary"
                disabled={state.busy || state.space.includeRoots.length === 0}
                onClick={() => void save(state.space, state.root, true)}
              >
                Save & Sync
              </Btn>
            </div>
          </div>
        )}
        {state.step === 'report' && <SyncReportView report={state.report} onClose={onClose} />}
      </div>
    </div>
  )
}
