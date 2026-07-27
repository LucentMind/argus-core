import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_ENTRIES } from '../registry'

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')

/** Files known to carry model-facing text. A new prompt-bearing file must be added here. */
const SCANNED = [
  'app/src/shared/modes.ts',
  'app/src/shared/reviewLayers.ts',
  'app/src/shared/tourPrompts.ts',
  'app/src/main/services/agent/persona.ts',
  'app/src/main/services/agent/skillIndex.ts',
  'app/src/main/services/agent/session.ts',
  'app/src/main/services/agent/nativeTools.ts',
  'app/src/main/services/agent/risk.ts',
  'app/src/main/services/memory.ts',
  'app/src/main/services/panels/draftMessages.ts',
  'app/src/main/services/distill/caseDistillContract.ts',
  'app/src/main/services/distill/contract.ts',
  'app/src/main/services/refSync/distill.ts',
  'app/src/main/services/caseService.ts',
  'app/src/main/services/jiraPrompts.ts',
  'app/src/main/services/agent/reviewRun.ts',
  'app/src/main/services/agent/reviewWrites.ts',
  'app/src/main/services/agent/reviewActions.ts'
]

/** Files whose tool RETURNS and THROWS also reach the model, not just their long prose. */
const RETURN_SCANNED = [
  'app/src/main/services/agent/nativeTools.ts',
  'app/src/main/services/memory.ts',
  'app/src/main/services/agent/reviewWrites.ts'
]

/**
 * Model-facing strings in RETURN_SCANNED that are deliberately not registry entries, with the
 * reason. Matched as a substring of the literal. Keep this list short: it is the only escape
 * hatch left, and every addition is a claim that a string the model reads is not a prompt.
 */
const NOT_PROMPTS: { text: string; why: string }[] = [
  {
    text: 'Unknown evidence_id:',
    why: 'Security decision: identical for "missing" and "another case\'s id" so an agent cannot probe ids across cases. Must not be overridable.'
  },
  { text: 'lines ${r.from}', why: 'Data framing for the payload underneath.' },
  {
    text: "${header}\\n${shown.join('\\n')}${tail}",
    why: 'grep_lines gluing its header, hit lines and cap notice together — pure interpolation, no words of its own.'
  },
  {
    text: '${n}\\t${line}',
    why: 'One grep_lines hit as "<line number><tab><text>" — the payload itself, not framing around it.'
  },
  {
    text: '${r.from + i}\\t${l}',
    why: 'One read_lines row as "<line number><tab><text>" — same payload shape as the grep_lines hit above, produced by the other reader.'
  },
  {
    text: '«${h.caseSlug}» [${h.resolution}] ${h.signature} — ${h.snippet}',
    why: 'One search_case_history row: slug, resolution, signature and snippet read straight out of the summaries table with punctuation between them. Every word is stored data.'
  },
  {
    text: 'status → ${status}',
    why: 'update_case_status echoing the transition it just performed. Covers both arms of the ternary; the resolution arm only appends the value in parentheses.'
  },
  {
    text: 'memory/${topic}.md updated',
    why: 'Reports what a write did and is dominated by runtime data (topic, byte count, whether an index entry was added) — reword it and there is nothing left to say. Contrast tool-feedback.append_finding.ok, which IS registered: "finding appended" is a fixed sentence with no interpolation, so wording is the whole of it and worth being able to change.'
  },
  {
    text: 'is not available in this session',
    why: 'Capability error for a tool the session did not wire; carries no instruction.'
  },
  { text: 'must be a number', why: 'Argument-shape error from the num() coercion helper.' },
  {
    text: 'Invalid memory topic name',
    why: 'Argument-shape validation in topicPath(), same class as the num() coercion error.'
  },
  {
    text: 'Cannot delete the memory index',
    why: 'deleteTopic is a Settings-page action invoked by the user; no tool exposes it.'
  },
  {
    text: '${b.owner}/${b.repo}#${b.number}',
    why: "prIdentity() in reviewWrites.ts: the case's one binding as owner/repo#number, for the {bound} placeholder in review_write.unknown-pr (so the model can copy a value straight into `pr`) — pure interpolation, no words of its own. Kept as this one longer/specific pattern rather than also carrying a short '#${b.number}' entry: a short generic fragment would silently waive any FUTURE literal in reviewWrites.ts that merely happens to interpolate a PR number, e.g. a hypothetical `PR #${b.number} is closed — reopen it first` — exactly the rot this file's own comment warns about."
  }
]

/** Long enough to be prose rather than a key, a path, or a short label. */
const MIN_CHARS = 120

/** Reads like instruction text written for a model, not like code or UI copy. */
const PROMPTY =
  /\b(you are|you must|your task|do not|never |always |respond|return only|output|rules:|guidelines|cite|citation|follow every|exactly one|fenced|json block|use this tool|treat them)\b/i

/**
 * Strip comments before scanning for literals. This is a scanning heuristic, not a parser:
 * persona.ts's doc comment for DIAGRAM_FRAGMENT reads "intercepts ```mermaid fences" — an
 * odd/unbalanced run of backticks inside a `/* *\/` block comment — which desyncs the
 * balanced-backtick regex below and makes it misidentify where the next real template
 * literal starts. Stripping comments first avoids that whole class of false match. Verified
 * safe for every SCANNED file: none of them put `/*`, `*\/`, `//`, or a URL inside a string or
 * template literal, so this can't accidentally eat real prompt content.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * A plain single/double-quoted string is allowed to carry literal backtick characters (e.g. an
 * unescaped ```json fence, as case-distill's output-nudge does post-Plan-3). The regexes below
 * find template literals by pairing up backtick characters wherever they appear in the file, so
 * a stray backtick sitting inside an ordinary quoted string reads as a template-literal
 * delimiter and desyncs every match after it — the same class of bug `stripComments` guards
 * against for comments. Fix: blank out backticks inside quoted strings in a scratch copy used
 * only to find match boundaries (same length as `src`, so indices still line up); the real body
 * text is always sliced back out of the untouched `src`, so registered-literal comparisons never
 * see the placeholder.
 */
function maskBackticksInQuotedStrings(src: string): string {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/`/g, ' '))
}

/**
 * Normalize a raw source literal toward its runtime value.
 * - CRLF → LF: these files are checked out with CRLF, but esbuild/vitest normalizes template
 *   literals to LF when compiling, so a registered literal read raw from disk would never
 *   match its own runtime value.
 * - `\`` → `` ` ``: CASE_WORKING_RULES escapes its backticks because it IS a template literal;
 *   the compiled string does not carry the backslashes. Without this the entry is reported
 *   unregistered forever — the phantom `count: 1` the old deferred.ts carried for caseService.
 */
function normalize(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\\`/g, '`')
}

function literalsIn(rawSrc: string): string[] {
  const src = stripComments(rawSrc)
  const masked = maskBackticksInQuotedStrings(src)
  const out: string[] = []
  // Template literals and long single/double-quoted strings.
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.){80,}'|"(?:[^"\\\n]|\\.){80,}"/g
  for (const m of masked.matchAll(re)) {
    const raw = src.slice(m.index, m.index + m[0].length)
    const body = normalize(raw.slice(1, -1))
    if (body.length < MIN_CHARS) continue
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA|WITH)\b/i.test(body)) continue
    if (!PROMPTY.test(body)) continue
    out.push(body)
  }
  return out
}

/** One string/template literal, as a pattern fragment. Shared by every return position below. */
const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/.source

/** What may sit between `return` and the `?` of a ternary. Newlines are allowed — prettier wraps
 *  a ternary whose branches are long, which is exactly the case worth catching — but a quote, a
 *  brace or a `;` ends the scan, so it cannot wander into the next statement or read an object
 *  literal's `key: 'value'` pairs as the else-branch of a ternary that was never there. */
const TERNARY_HEAD = /[^;{}`'"]{0,120}?/.source

/**
 * Source positions from which a literal reaches the model as tool output. Each pattern ends with
 * the literal as its one capture group, so the literal's start is (match end − capture length).
 * An earlier version only accepted a literal IMMEDIATELY after `return`/`throw new Error(`, which
 * silently missed both of nativeTools.ts's ternary/arrow-returned strings. A later version added
 * the two ternary-behind-a-wrapper-call shapes below (`return cond ? wrap('x') : …` and the
 * mirror with the wrapper in the else-branch) — those are NOT "statement-level parsing" the way
 * the shapes below are, so they're absorbed as one more alternation each instead of being listed
 * as unseen.
 *
 * Still unseen, and deliberately so — each would need statement-level parsing rather than a
 * position regex, and none is currently occupied by a model-facing string in RETURN_SCANNED:
 *   - const-then-return: `const msg = \`…\`; return msg`
 *   - object-literal return: `return { message: '…' }`
 *   - a ternary not anchored to `return`: `throw new Error(cond ? '…' : '…')`
 *   - a backtick template nested inside an interpolation, e.g. `` return `${cond ? `…` : ``}` `` —
 *     structural, not just unhandled: `LITERAL` (above) cannot nest backticks, so the outer span
 *     truncates at the inner delimiter and neither the fragment nor the outer text gets scanned.
 * If you add one of those shapes, register the text or extend this list — a green run here is not
 * evidence that the string was reviewed.
 */
const RETURN_POSITIONS = [
  // return `x`  /  throw new Error(`x`)
  new RegExp(String.raw`(?:\breturn\b|throw new Error\()\s*(${LITERAL})`, 'g'),
  // return cond ? `x` : `y`, on one line or wrapped over three — anchored to `return` so a
  // ternary in an ordinary assignment (memory.ts's `const block = existing ? … : …`, which
  // writes a FILE, not a tool result) stays out.
  new RegExp(String.raw`\breturn\b${TERNARY_HEAD}\?\s*(${LITERAL})`, 'g'),
  new RegExp(String.raw`\breturn\b${TERNARY_HEAD}\?[\s\S]{0,200}?:\s*(${LITERAL})`, 'g'),
  // return cond ? wrap(`x`) : … — the true-branch literal reached only through a wrapper call.
  new RegExp(String.raw`\breturn\b${TERNARY_HEAD}\?\s*[A-Za-z_$][\w$.]*\(\s*(${LITERAL})`, 'g'),
  // return cond ? … : wrap(`x`) — same, but the wrapper sits in the else-branch.
  new RegExp(
    String.raw`\breturn\b${TERNARY_HEAD}\?[\s\S]{0,200}?:\s*[A-Za-z_$][\w$.]*\(\s*(${LITERAL})`,
    'g'
  ),
  // (x) => `y` — implicit arrow return, e.g. the `.map()` that builds search_case_history's hits.
  new RegExp(String.raw`=>\s*(${LITERAL})`, 'g'),
  // return wrap(`x`) / return await wrap(`x`) / throw new Error(wrap(`x`))
  new RegExp(
    String.raw`(?:\breturn\b|throw new Error\()\s*(?:await\s+)?[A-Za-z_$][\w$.]*\(\s*(${LITERAL})`,
    'g'
  )
]

/** Every registered prompt id (e.g. `tool-feedback.append_finding.ok`), so a prompt-registry key
 *  handed to a feedback resolver (`return fb('append_finding.ok')`) can be recognized by
 *  membership rather than shape. The text such a key resolves to is registered on its own through
 *  the module's `PromptTextSpecs` record, so scanning the key would report a string that is
 *  already covered. A shape-only check (any spaceless dotted lowercase literal) let a misrouted
 *  key like `fb('append_finding.typo')` — which resolves to nothing and silently falls back to
 *  the default — and an unrelated dotted literal like `case_notes.md` pass unexamined, because
 *  neither was ever checked against the registry it claims to reference. */
const REGISTRY_IDS = new Set(PROMPT_ENTRIES.map((e) => e.id))

/** Literals in a return/throw position — the shape of a tool's model-facing output, regardless of
 *  how short or how un-imperative it reads. Same masked-scratch-copy treatment as `literalsIn`:
 *  boundaries come from the masked copy, text from the real source. */
function returnedLiteralsIn(rawSrc: string): string[] {
  const src = stripComments(rawSrc)
  const masked = maskBackticksInQuotedStrings(src)
  // start → length, so a literal two patterns both reach (e.g. a wrapper call inside a ternary)
  // is reported once.
  const spans = new Map<number, number>()
  for (const re of RETURN_POSITIONS) {
    for (const m of masked.matchAll(re)) {
      // The literal is the tail of the match, so its start is the match end minus its length.
      spans.set(m.index + m[0].length - m[1].length, m[1].length)
    }
  }
  const out: string[] = []
  let coveredTo = 0
  for (const [start, len] of [...spans].sort((a, b) => a[0] - b[0])) {
    // A literal inside another literal's `${…}` (memory.ts's `${indexEntry ? ', index entry
    // added' : ''}`) is part of the outer string, which is scanned on its own — reporting the
    // fragment separately would demand an exemption for half a sentence.
    if (start < coveredTo) continue
    coveredTo = start + len
    const body = normalize(src.slice(start + 1, start + len - 1))
    // Below this a literal is punctuation or a single word (`'\n'`, `'agent'`), not a message.
    if (body.length < 10) continue
    if (REGISTRY_IDS.has('tool-feedback.' + body)) continue
    out.push(body)
  }
  return out
}

const registered = PROMPT_ENTRIES.filter((e) => e.category !== 'external').map((e) => e.default())

/** An entry's default covers this literal. `contains` in both directions because an extracted
 *  constant may be a slice of the literal the scanner sees (escapes, interpolation). Safe for the
 *  prose pass only, where every literal is >= MIN_CHARS: see `isRegisteredReturn`. */
function isRegistered(lit: string): boolean {
  return registered.some(
    (r) => r === lit || r.includes(lit.slice(0, 60)) || lit.includes(r.slice(0, 60))
  )
}

/**
 * Collapse both spellings of a placeholder to one token: `${index.totalLines}` as written in the
 * source, and `{total}` as written in a registered template. Lets an entry match the literal it
 * is filled from without matching on a prefix.
 */
function placeholderShape(s: string): string {
  return s
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[A-Za-z_]\w*\}/g, '{}')
    .trim()
}

const registeredShapes = new Set(registered.map(placeholderShape))

/**
 * An entry's default IS this returned literal. Equality, not containment: the return pass admits
 * literals from 10 characters up, and several registered defaults are short ('finding appended'),
 * so `isRegistered`'s 60-character-prefix containment would wave through any returned string that
 * merely embeds one — e.g. `finding appended — now re-read every file and start over`, which is
 * exactly the class this pass exists to catch.
 */
function isRegisteredReturn(lit: string): boolean {
  return registeredShapes.has(placeholderShape(lit))
}

describe('prompt coverage', () => {
  it('every scanned file exists', () => {
    for (const f of SCANNED) expect(fs.existsSync(path.join(REPO_ROOT, f)), f).toBe(true)
  })

  it('every long model-facing literal is registered', () => {
    const unexplained: string[] = []
    for (const f of SCANNED) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')
      for (const lit of literalsIn(src)) {
        if (isRegistered(lit)) continue
        unexplained.push(`${f}: ${lit.replace(/\s+/g, ' ').slice(0, 90)}`)
      }
    }
    expect(unexplained, `unregistered model-facing text:\n${unexplained.join('\n')}`).toEqual([])
  })

  it('every string a tool returns or throws is registered or listed as not-a-prompt', () => {
    const unexplained: string[] = []
    for (const f of RETURN_SCANNED) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')
      for (const lit of returnedLiteralsIn(src)) {
        if (isRegisteredReturn(lit)) continue
        if (NOT_PROMPTS.some((n) => lit.includes(n.text))) continue
        unexplained.push(`${f}: ${lit.replace(/\s+/g, ' ').slice(0, 90)}`)
      }
    }
    expect(
      unexplained,
      `model-facing tool output that is neither registered nor listed in NOT_PROMPTS:\n${unexplained.join('\n')}`
    ).toEqual([])
  })

  it('every not-a-prompt exemption states why', () => {
    for (const n of NOT_PROMPTS) expect(n.why.length, n.text).toBeGreaterThan(20)
  })

  it('every not-a-prompt exemption still waives a real literal', () => {
    // Stops the escape hatch rotting: an entry whose string no longer exists reads like a
    // standing claim that some literal was reviewed and waived, and it can silently start
    // matching a different string later. If this fails, delete the entry — do not broaden it.
    // Only literals that actually REACH the exemption check count as seen. A registered literal
    // is skipped before NOT_PROMPTS is consulted, so counting it here would let an exemption that
    // waives nothing read as live — the rot this test exists to catch.
    const seen = RETURN_SCANNED.flatMap((f) =>
      returnedLiteralsIn(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).filter(
        (lit) => !isRegisteredReturn(lit)
      )
    )
    const stale = NOT_PROMPTS.filter((n) => !seen.some((lit) => lit.includes(n.text))).map(
      (n) => n.text
    )
    expect(stale, `NOT_PROMPTS entries matching nothing:\n${stale.join('\n')}`).toEqual([])
  })

  it('every deny verdict builds its reason through the registry', () => {
    // Only DENY reasons reach the model (session.ts forwards verdict.reason as the tool_result);
    // ASK reasons render on the approval card for the user and stay hardcoded on purpose. A
    // content-based rule would flag all of them, so this matches on the verdict shape instead.
    const src = stripComments(
      fs.readFileSync(path.join(REPO_ROOT, 'app/src/main/services/agent/risk.ts'), 'utf8')
    )
    // The trailing comma is load-bearing: it selects object LITERALS. The `RiskVerdict` union
    // member in the same file reads `{ action: 'deny'; risk: Risk; reason: string }` — separated
    // by semicolons because it is a type — and would otherwise be reported as a hardcoded reason
    // of "string }". Assumes `reason` follows `action` in the literal, which is how every verdict
    // in this file is written; the all-'deny'-occurrences check below catches a verdict written
    // in a shape this pattern doesn't recognize, which this length assertion alone cannot.
    const denies = [...src.matchAll(/action:\s*'deny',[\s\S]{0,200}?reason:\s*([^\n]+)/g)]
    // Exact, not `> 0`: with three deny verdicts in the file, a refactor that hid ONE of them
    // from this pattern would leave the other two holding the assertion up and the loss would be
    // invisible. Update this number on purpose when a deny verdict is added or removed.
    expect(denies.length, 'deny verdicts risk.ts no longer exposes to this pattern').toBe(3)
    // Catches the case the length assertion above cannot: a NEW deny verdict added in a shape
    // the comma-requiring pattern misses (no trailing comma, double-quoted, reason before
    // action, …) — that verdict would never enter `denies`, so `denies.length` would stay 3 and
    // the assertion above would stay green with a hardcoded reason sitting unresolved in the
    // file. Every occurrence of the bare literal 'deny' must be accounted for instead: the `+2`
    // is two fixed, non-verdict occurrences the comma-requiring pattern correctly excludes —
    // the `RiskVerdict` type-union member (`{ action: 'deny'; risk: Risk; reason: string }`,
    // semicolons not commas) and the early-return check in the Bash segment loop below
    // (`if (v.action === 'deny') return v`) — do not "fix" this to `+1`: that underconstrains
    // the check by one, since it only counts the type member and misses the comparison.
    expect(
      (src.match(/'deny'/g) ?? []).length,
      'a deny verdict exists in risk.ts that this pattern does not see'
    ).toBe(denies.length + 2)
    const raw = denies.map((m) => m[1].trim()).filter((r) => !r.startsWith('denyReason('))
    expect(raw, `deny reasons not resolved through denyReason():\n${raw.join('\n')}`).toEqual([])
  })

  it('SCANNED covers every file the registry sources a prompt from', () => {
    // Without this, adding a prompt in a NEW file and registering it leaves the guard blind to
    // every later addition in that file, because nothing would ever scan it.
    const sourceFiles = new Set(
      PROMPT_ENTRIES.filter((e) => e.category !== 'external').map((e) => e.source.split(':')[0])
    )
    const missing = [...sourceFiles].filter((f) => !SCANNED.includes(f))
    expect(missing, `registry sources not in SCANNED:\n${missing.join('\n')}`).toEqual([])
  })

  it('RETURN_SCANNED covers every file the registry sources a tool-feedback entry from', () => {
    // risk.ts is exempt: its deny reasons reach the model as verdict.reason, never as a literal
    // return/throw the return-pass regexes look for, and the 'every deny verdict builds its
    // reason through the registry' test above is what actually guards that file.
    const RISK_EXEMPT = 'app/src/main/services/agent/risk.ts'
    const feedbackFiles = new Set(
      PROMPT_ENTRIES.filter((e) => e.category === 'tool-feedback').map(
        (e) => e.source.split(':')[0]
      )
    )
    const missing = [...feedbackFiles].filter(
      (f) => f !== RISK_EXEMPT && !RETURN_SCANNED.includes(f)
    )
    expect(missing, `tool-feedback sources not in RETURN_SCANNED:\n${missing.join('\n')}`).toEqual(
      []
    )
  })

  it('every category with entries in this build is populated as expected', () => {
    // deferred.ts is gone: nothing is parked any more, so the two categories Plan 1 left empty
    // must now be filled. A regression that dropped them would otherwise pass silently.
    const cats = new Set<string>(PROMPT_ENTRIES.map((e) => e.category))
    for (const c of ['tool-feedback', 'synthesized']) expect(cats.has(c), c).toBe(true)
  })
})
