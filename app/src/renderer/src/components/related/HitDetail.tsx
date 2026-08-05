import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  RelatedDefectRecord,
  RelatedDefectResult,
  RelatedDistilled,
  RelatedHit
} from '../../../../shared/relatedHistory'
import { Btn, Chip, SectionLabel } from '../ui'
import { isOpenableUrl } from '../../lib/openableUrl'
import { composerDraft } from '../../lib/composerDraft'
import { formatRelatedCitation } from '../../lib/relatedCitation'
import type { RelatedAttachResult } from '../../../../shared/relatedHistory'

/** Just enough to fetch the canonical record (`related.defect(sourceId, key)`)
 *  and follow a link within this pane. Deliberately NOT the full `CorpusRef`:
 *  the rendered url always comes from the fetched `RelatedDefectRecord`
 *  (`record.url` below), never from this — carrying an unused `url` here
 *  would be an untrusted string sitting in a return shape with no reader,
 *  one careless edit away from an ungated `href`. */
interface CorpusLookup {
  sourceId: string
  key: string
}

/** The corpus record this hit can show, if any: a corpus hit is its own ref, and
 *  a merged local row carries one (spec §3.3). */
function corpusRefOf(hit: RelatedHit): CorpusLookup | null {
  if (hit.kind === 'corpus') return { sourceId: hit.sourceId, key: hit.key }
  return hit.corpusRef ? { sourceId: hit.corpusRef.sourceId, key: hit.corpusRef.key } : null
}

function Row({ label, values }: { label: string; values: string[] }): React.JSX.Element | null {
  if (values.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-mute">{label}</span>
      {values.map((v) => (
        <Chip key={v}>{v}</Chip>
      ))}
    </div>
  )
}

function DistilledBlock({ d }: { d: RelatedDistilled }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-xs text-dim">
      <p className="text-ink">{d.signature}</p>
      {d.symptoms && <p>{d.symptoms}</p>}
      {d.rootCause && (
        <p>
          <span className="text-mute">Root cause: </span>
          {d.rootCause}
        </p>
      )}
      {d.fix && (
        <p>
          <span className="text-mute">Fix: </span>
          {d.fix}
        </p>
      )}
      <Row label="Terms" values={d.terms} />
    </div>
  )
}

/** Spec §12.1: `description` and comment `body` are untrusted third-party
 *  markdown. react-markdown's default `urlTransform` only blanks dangerous
 *  *schemes* (`javascript:`, `file:`, app protocols) — an ordinary
 *  `https://` link still renders with no `target`/`rel`, which is a
 *  same-window top-level navigation that never reaches the main-process
 *  `setWindowOpenHandler` guard. Force every markdown link through the same
 *  `isOpenableUrl` gate as the record's own `url` above, and force it to
 *  open via `target="_blank"` so a click is routed through that guard
 *  instead of replacing this window. */
function MarkdownAnchor({ href, children }: ComponentProps<'a'>): React.JSX.Element {
  if (href && isOpenableUrl(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  return <>{children}</>
}

const MARKDOWN_COMPONENTS = { a: MarkdownAnchor }

function CorpusRecord({ record }: { record: RelatedDefectRecord }): React.JSX.Element {
  const [showComments, setShowComments] = useState(false)
  const comments = record.comments ?? []
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Spec §12.1: a corpus-controlled url is untrusted. A non-http(s) one
            renders as inert text — never as an anchor whose click main would
            then have to refuse. */}
        {isOpenableUrl(record.url) ? (
          <a
            href={record.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-signal"
          >
            {record.key}
          </a>
        ) : (
          <span className="font-mono text-xs text-dim">{record.key}</span>
        )}
        <span className="min-w-0 flex-1 text-sm text-ink">{record.summary}</span>
        <Chip tone={record.resolution ? 'neutral' : 'signal'}>
          {record.resolution ? `${record.status} / ${record.resolution}` : record.status}
        </Chip>
      </div>
      <Row label="Project" values={[record.project]} />
      <Row label="Components" values={record.components} />
      <Row label="Labels" values={record.labels} />
      <Row label="Affects" values={record.affectsVersions} />
      <Row label="Fix versions" values={record.fixVersions} />
      {record.distilled && (
        <>
          <SectionLabel>Distilled</SectionLabel>
          <DistilledBlock
            d={{
              signature: record.distilled.signature,
              symptoms: record.distilled.symptoms,
              rootCause: record.distilled.rootCause,
              fix: record.distilled.fix,
              terms: record.distilled.errorStrings
            }}
          />
        </>
      )}
      <SectionLabel>Description</SectionLabel>
      {/* Already markdown per SPEC §6 — no ADF handling here. react-markdown
          without rehype-raw renders no HTML, which is the sanitizing path spec
          §12.2 requires; do not add rehype-raw to this subtree. */}
      <div className="markdown-body text-xs leading-relaxed text-dim">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {record.description}
        </Markdown>
      </div>
      {record.commentCount > 0 && (
        <>
          {/* Labeled from `commentCount`, not `comments.length`: the wire
              contract guarantees the count even when a service legitimately
              omits bodies, and `comments.length` would then be 0 and hide the
              disclosure entirely even though there ARE comments — just none
              in hand to render. */}
          <Btn
            variant="ghost"
            aria-expanded={showComments}
            onClick={() => setShowComments(!showComments)}
          >
            {`${record.commentCount} comment${record.commentCount === 1 ? '' : 's'}`}
          </Btn>
          {showComments &&
            comments.map((c, i) => (
              <div key={`${c.author}:${c.createdAt}:${i}`} className="flex flex-col gap-0.5">
                <span className="font-mono text-[10.5px] text-mute">
                  {c.author} · {c.createdAt.slice(0, 10)}
                </span>
                <div className="markdown-body text-xs text-dim">
                  <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                    {c.body}
                  </Markdown>
                </div>
              </div>
            ))}
        </>
      )}
    </div>
  )
}

/**
 * The two pull-into-case actions (spec §10). Rendered only when the explorer is
 * case-scoped — the standalone entry point passes no `caseSlug`, and the actions
 * are then ABSENT rather than disabled (spec §8).
 *
 * Neither action is approval-gated. Spec §10 says so explicitly: these are
 * user-initiated renderer actions, not panel or agent writes, so the part-3d-2
 * HITL card does not apply. Do not add one by analogy.
 */
function HitActions({
  hit,
  caseSlug,
  sessionId,
  corpus,
  onReferenced
}: {
  hit: RelatedHit
  caseSlug: string
  sessionId: number | null
  corpus: CorpusLookup | null
  onReferenced?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null)

  function reference(): void {
    if (sessionId === null) return
    // Staged as a DRAFT, never sent — the same seam a panel's `sendToAgent`
    // uses. This is the one path from corpus text to the model (spec §12.4)
    // and the user reads it in the composer before it ever becomes a turn.
    composerDraft.set(caseSlug, sessionId, formatRelatedCitation(hit))
    onReferenced?.()
  }

  function attach(): void {
    if (!corpus || busy) return
    setBusy(true)
    void window.argus.related
      .attachEvidence(caseSlug, corpus.sourceId, corpus.key)
      .then((res: RelatedAttachResult) => {
        setStatus(
          res.ok
            ? {
                text: res.deduped
                  ? 'Already attached to this case.'
                  : `Attached as ${res.record.relPath.split('/').pop()}`,
                bad: false
              }
            : { text: res.error, bad: true }
        )
      })
      .catch((e: unknown) => {
        setStatus({ text: e instanceof Error ? e.message : String(e), bad: true })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-2">
      <Btn
        variant="outline"
        onClick={reference}
        disabled={sessionId === null}
        title={
          sessionId === null
            ? 'No chat session in this case yet'
            : 'Stage a citation in the composer to edit and send'
        }
      >
        Reference in chat
      </Btn>
      {/* Corpus-only: a local hit IS your case, so there is nothing external to
          freeze. Absent rather than disabled — the spec §8 precedent. */}
      {corpus && (
        <Btn variant="outline" onClick={attach} disabled={busy}>
          Attach as evidence
        </Btn>
      )}
      {status && (
        <span className={`text-[11px] ${status.bad ? 'text-danger' : 'text-mute'}`}>
          {status.text}
        </span>
      )}
    </div>
  )
}

/**
 * Detail for one hit (spec §9).
 *
 * A LOCAL hit renders from the search result it already has — no fetch, because
 * the distilled block travelled with the hit. A CORPUS hit (and a merged row's
 * corpus half) fetches the canonical record, which is the only place `comments[]`
 * is populated. A merged row shows both.
 */
export function HitDetail({
  hit,
  onOpenCase,
  caseSlug = null,
  sessionId = null,
  onReferenced
}: {
  hit: RelatedHit
  onOpenCase?: (slug: string) => void
  /** Case-scoped entry point only. Absent → no pull-into-case actions at all. */
  caseSlug?: string | null
  sessionId?: number | null
  onReferenced?: () => void
}): React.JSX.Element {
  const ref = corpusRefOf(hit)
  const [key, setKey] = useState<string | null>(ref?.key ?? null)
  // Result is tagged with the key it was fetched for, rather than reset up front:
  // resetting synchronously in the effect body (`setRecord(null)` before the
  // fetch) trips `react-hooks/set-state-in-effect` — only setState from inside
  // the async callback is allowed. Comparing `result.key` to the current `key`
  // at render time gives "loading" as a derived value instead, with no
  // synchronous setState in the effect at all. It also means a stale record
  // never flashes while a newly-followed link is loading.
  const [result, setResult] = useState<{
    key: string
    record: RelatedDefectRecord | null
    error: string | null
  } | null>(null)

  // No effect resets `key` when the selected hit changes: the explorer keys this
  // component on `hit.id`, so a different hit is a fresh mount.
  useEffect(() => {
    if (!ref || !key) return
    let alive = true
    void window.argus.related
      .defect(ref.sourceId, key)
      .then((res: RelatedDefectResult) => {
        if (!alive) return
        setResult(
          res.ok ? { key, record: res.value, error: null } : { key, record: null, error: res.error }
        )
      })
      .catch((e: unknown) => {
        if (alive) {
          setResult({ key, record: null, error: e instanceof Error ? e.message : String(e) })
        }
      })
    return () => {
      alive = false
    }
    // `ref` is derived from `hit`, which is mount-stable per hit (the explorer
    // keys this component on `hit.id`); only `ref?.sourceId` and `key` vary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.sourceId, key])

  const record = result?.key === key ? result.record : null
  const error = result?.key === key ? result.error : null

  return (
    <div className="flex flex-col gap-3">
      {hit.kind === 'local' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <SectionLabel>Your case</SectionLabel>
            <Btn variant="outline" onClick={() => onOpenCase?.(hit.caseSlug)}>
              Open case
            </Btn>
          </div>
          {hit.distilled ? (
            <DistilledBlock d={hit.distilled} />
          ) : (
            <p className="text-xs text-dim">{hit.title}</p>
          )}
        </div>
      )}
      {ref && (
        <div className="flex flex-col gap-2">
          {hit.kind === 'local' && <SectionLabel>Also in the corpus</SectionLabel>}
          {error && <p className="text-xs text-danger">{error}</p>}
          {!error && !record && <p className="text-xs text-dim">Loading…</p>}
          {record && <CorpusRecord record={record} />}
          {record && record.links.length > 0 && (
            <div className="flex flex-col gap-1">
              <SectionLabel>Links</SectionLabel>
              {record.links.map((l) => (
                <div key={`${l.type}:${l.key}`} className="flex items-center gap-2">
                  <span className="text-[11px] text-mute">{l.type}</span>
                  {/* A link carries a key, never a url — following it is another
                      `related.defect` call in this same pane, so no untrusted
                      url is involved at all. */}
                  <Btn variant="ghost" onClick={() => setKey(l.key)}>
                    {l.key}
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {caseSlug && (
        <HitActions
          hit={hit}
          caseSlug={caseSlug}
          sessionId={sessionId}
          corpus={ref}
          onReferenced={onReferenced}
        />
      )}
    </div>
  )
}
