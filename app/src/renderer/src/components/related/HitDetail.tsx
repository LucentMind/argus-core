import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  RelatedAttachResult,
  RelatedDefectRecord,
  RelatedDefectResult,
  RelatedDistilled,
  RelatedHit
} from '../../../../shared/relatedHistory'
import { Btn, Chip, SectionLabel } from '../ui'
import { isOpenableUrl } from '../../lib/openableUrl'
import { MARKDOWN_COMPONENTS } from '../../lib/markdownLinks'
import { composerDraft } from '../../lib/composerDraft'
import { notice } from '../../lib/noticeStore'
import { formatDefectRecordCitation, formatRelatedCitation } from '../../lib/relatedCitation'

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

/** The display name of the CORPUS provider behind this hit, for a citation
 *  header. `formatRelatedCitation` can read `provenance[0]` because a corpus
 *  hit has exactly one entry; a merged row carries the local provider too
 *  (spec §3.3) and its first entry is 'Your cases', so search by kind rather
 *  than by position. Falls back to the raw source id, never to a local name. */
function corpusSourceNameOf(hit: RelatedHit, sourceId: string): string {
  return hit.provenance.find((p) => p.kind === 'corpus')?.providerName ?? sourceId
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
 *
 * Both actions follow WHAT THE PANE DISPLAYS, not the hit that was selected in
 * the list. Following a `links[]` entry swaps the displayed record without
 * changing the hit, and a user who reads KAN-9 and clicks attach means KAN-9 —
 * `corpus.key` is therefore the live displayed key, and `hitKey` (the hit's own
 * corpus key) is here only so the citation can tell "a link was followed" from
 * "nothing was followed".
 */
function HitActions({
  hit,
  hitKey,
  record,
  caseSlug,
  sessionId,
  corpus,
  onReferenced
}: {
  hit: RelatedHit
  /** The hit's OWN corpus key, or null when the hit has no corpus half. */
  hitKey: string | null
  /** The record currently on screen, or null while it loads / on a local-only hit. */
  record: RelatedDefectRecord | null
  caseSlug: string
  sessionId: number | null
  /** `sourceId` from the hit; `key` is whatever the pane currently shows. */
  corpus: CorpusLookup | null
  onReferenced?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null)

  // Only when a link has actually been followed does the hit stop describing
  // what the user is reading. Keyed off the displayed KEY rather than
  // `record.key`, so a corpus that echoes a key in different casing cannot
  // reroute an ordinary citation through the record formatter.
  const followed = record && corpus && hitKey && corpus.key !== hitKey ? record : null

  // A link was followed (the displayed key no longer matches the hit's own
  // key) but its record is not in hand yet — either the round-trip is still
  // in flight, or it errored and never will be. `followed` is null in both
  // cases, which would otherwise make `reference()` silently fall back to
  // citing the hit the user navigated AWAY from. Attach does not need this
  // guard: it sends `corpus.key` and main re-fetches, so it is correct
  // throughout the same window.
  const awaitingFollowed = corpus !== null && hitKey !== null && corpus.key !== hitKey && !record

  function reference(): void {
    if (sessionId === null || awaitingFollowed) return
    // Staged as a DRAFT, never sent — the same seam a panel's `sendToAgent`
    // uses. This is the one path from corpus text to the model (spec §12.4)
    // and the user reads it in the composer before it ever becomes a turn.
    const text =
      followed && corpus
        ? formatDefectRecordCitation(followed, corpusSourceNameOf(hit, corpus.sourceId))
        : formatRelatedCitation(hit)
    composerDraft.set(caseSlug, sessionId, text)
    // Plan decision 6: the caller closes the modal on this callback, which takes
    // the inline status line with it — so the only confirmation that can survive
    // is a notice, which renders in the case header behind the modal.
    notice('Citation staged in the composer — edit it before sending.')
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
        disabled={sessionId === null || awaitingFollowed}
        title={
          sessionId === null
            ? 'No chat session in this case yet'
            : awaitingFollowed
              ? 'The linked record has not loaded yet — wait for it before citing'
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
          hitKey={ref?.key ?? null}
          record={record}
          caseSlug={caseSlug}
          sessionId={sessionId}
          // The DISPLAYED key, not `ref.key`: following a `links[]` entry
          // refetches within this same pane, so `sourceId` is stable but the
          // record on screen is a different ticket. Passing `ref` wholesale is
          // what made attach freeze the ticket the user had navigated away from.
          corpus={ref ? { sourceId: ref.sourceId, key: key ?? ref.key } : null}
          onReferenced={onReferenced}
        />
      )}
    </div>
  )
}
