import type { CaseDistillInput } from '../../../../shared/distill'
import type { Dossier, DossierCite } from '../../../../shared/distillV3'
import type { PromptTextSpecs } from '../../../../shared/promptSpec'
import {
  ASSET_KINDS,
  ASSET_VERDICTS,
  MAX_INVENTORY_ITEMS,
  type AssetInventoryEntry,
  type AssetKind,
  type AssetVerdict,
  type AssetVerdictValue,
  type AttributionOutput
} from '../../../../shared/attribution'
import { DistillParseError } from '../contract'
import { citeKnownIn } from './dossier'

export const REASON_MAX = 240

/** Stage 2c: did each knowledge asset that appeared in the case help, do nothing, or mislead?
 *  Tool-less; sees the dossier, the inventory, the derived outcome and domain. */
export const ATTRIBUTION_CONTRACT = `You are grading the knowledge assets an AI assistant had available while investigating one root-cause-analysis case: skills (procedures it invoked), references (documents it read) and memories (notes it recalled). You see an evidence dossier prepared from the transcript and the list of assets that appeared in the case. Decide, per asset, whether the assistant actually APPLIED it and whether applying it HELPED, was NEUTRAL, or MISLED the investigation.

Rules:
1. ONLY INVENTORIED ASSETS: grade exactly the assets listed under the assets section, by their exact "kind" and "name". Never invent an asset; never rename one.
2. APPLIED means the assistant acted on the asset's content: followed its steps, used a value or fact from it, or ruled something out because of it. Merely loading or reading it is NOT applied → "applied": false, "verdict": null, "cites": [].
3. VERDICT for an applied asset: "helped" when the dossier's diagnostic path, root cause or confirmed fix depends on what the asset supplied; "misled" when the asset sent the investigation toward a rejected hypothesis or a user correction; otherwise "neutral".
4. CITES: every applied verdict carries ≥ 1 cite of exactly one form {"finding": id}, {"session": id, "turn": n}, {"evidence": "relPath"}, pointing at where the asset's effect is visible. An applied verdict you cannot cite must not be emitted.
5. OUTCOME AND DOMAIN are given to you as context; you never change or restate them in the output, and an outcome of handed-off/rejected does not by itself make an asset "misled".
6. BE SPARING: when the dossier does not show an asset's effect, say "applied": false rather than guessing "helped".
7. OUTPUT: exactly one fenced \`\`\`json block containing {"verdicts": [ {"kind": "skill"|"reference"|"memory", "name": string, "applied": boolean, "verdict": "helped"|"neutral"|"misled"|null, "reason": string (one line, ≤ 240 chars), "cites": [cite, ...]} ]}. Use exactly these item keys: "kind", "name", "applied", "verdict", "reason", "cites". No other top-level keys.`

export const ATTRIBUTION_SECTIONS: PromptTextSpecs = {
  case: { title: 'Attribution section — case context', text: '# Case' },
  assets: { title: 'Attribution section — assets that appeared in the case', text: '# Assets' },
  dossier: { title: 'Attribution section — dossier', text: '# Dossier' },
  'output-nudge': {
    title: 'Attribution — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function buildAttributionPrompt(
  input: CaseDistillInput,
  dossier: Dossier,
  resolve?: (id: string) => string
): string {
  const m = input.caseMeta
  const sec = (key: string): string =>
    resolve
      ? resolve(`headless.case-distill.attribution.section.${key}`)
      : ATTRIBUTION_SECTIONS[key as keyof typeof ATTRIBUTION_SECTIONS].text
  const assets = input.assets ?? []
  const full = assets.slice(0, MAX_INVENTORY_ITEMS)
  const rest = assets.slice(MAX_INVENTORY_ITEMS)
  const describe = (a: AssetInventoryEntry): string => {
    const desc =
      a.kind === 'skill'
        ? input.skillsIndex.find((s) => s.name === a.name)?.description
        : a.kind === 'reference'
          ? input.referencesIndex.find((r) => r.name === a.name)?.summary
          : undefined
    return `- ${a.kind} ${a.name} · used ${a.callCount}× · first seen session ${a.firstSeen.sessionId}${a.firstSeen.turnId !== null ? ` turn ${a.firstSeen.turnId}` : ''}${desc ? `\n  ${desc}` : ''}`
  }
  return [
    resolve ? resolve('headless.case-distill.attribution.contract') : ATTRIBUTION_CONTRACT,
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\noutcome: ${input.caseOutcome ?? 'open'}\ndomain: ${input.caseDomain ?? 'unassigned'}`,
    `${sec('assets')}\n${full.map(describe).join('\n')}${rest.length ? `\n- also present (name only): ${rest.map((a) => `${a.kind} ${a.name}`).join(', ')}` : ''}`,
    `${sec('dossier')}\n${JSON.stringify(dossier, null, 2)}`,
    sec('output-nudge')
  ].join('\n\n')
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isCite = (c: unknown): c is DossierCite =>
  isObj(c) &&
  ((Object.keys(c).length === 1 && typeof c.finding === 'number') ||
    (Object.keys(c).length === 1 && typeof c.evidence === 'string') ||
    (Object.keys(c).length === 2 && typeof c.session === 'number' && typeof c.turn === 'number'))

export function parseAttribution(
  text: string,
  inventory: AssetInventoryEntry[]
): AttributionOutput {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1)
    throw new DistillParseError(`expected exactly 1 json fence, got ${fences.length}`, text)
  let obj: unknown
  try {
    obj = JSON.parse(fences[0][1])
  } catch (e) {
    throw new DistillParseError(`invalid JSON: ${(e as Error).message}`, text)
  }
  if (!isObj(obj)) throw new DistillParseError('output is not an object', text)
  for (const k of Object.keys(obj))
    if (k !== 'verdicts' && k !== 'outcome') throw new DistillParseError(`unknown key "${k}"`, text)
  if (!Array.isArray(obj.verdicts)) throw new DistillParseError('verdicts is not an array', text)

  const known = new Set(inventory.map((a) => `${a.kind}/${a.name}`))
  const out: AttributionOutput = {
    verdicts: [],
    malformedDropped: {},
    unknownAssetDropped: {},
    uncitedDropped: 0,
    duplicateDropped: 0
  }
  const malformed = (k: string): void => {
    out.malformedDropped[k] = (out.malformedDropped[k] ?? 0) + 1
  }
  const seen = new Set<string>()
  for (const item of obj.verdicts) {
    if (!isObj(item)) {
      malformed('item')
      continue
    }
    if (!ASSET_KINDS.includes(item.kind as AssetKind)) {
      malformed('kind')
      continue
    }
    if (!isStr(item.name)) {
      malformed('name')
      continue
    }
    const key = `${item.kind}/${item.name}`
    if (!known.has(key)) {
      out.unknownAssetDropped[key] = (out.unknownAssetDropped[key] ?? 0) + 1
      continue
    }
    if (typeof item.applied !== 'boolean') {
      malformed('applied')
      continue
    }
    const verdictOk = item.applied
      ? ASSET_VERDICTS.includes(item.verdict as AssetVerdictValue)
      : item.verdict === null || item.verdict === undefined
    if (!verdictOk) {
      malformed('verdict')
      continue
    }
    if (!isStr(item.reason)) {
      malformed('reason')
      continue
    }
    const cites = Array.isArray(item.cites) ? item.cites.filter(isCite) : null
    if (cites === null) {
      malformed('cites')
      continue
    }
    if (item.applied && cites.length === 0) {
      out.uncitedDropped++
      continue
    }
    if (seen.has(key)) {
      out.duplicateDropped++
      continue
    }
    seen.add(key)
    out.verdicts.push({
      kind: item.kind as AssetKind,
      name: item.name,
      applied: item.applied,
      verdict: item.applied ? (item.verdict as AssetVerdictValue) : null,
      reason: item.reason.trim().slice(0, REASON_MAX),
      cites: item.applied ? cites : []
    })
  }
  return out
}

/** Same gate the dossier gets: a cite the frozen input cannot verify is dropped; an applied
 *  verdict left with none is uncited (it claimed an effect nobody can check). */
export function pruneAttributionCites(
  out: AttributionOutput,
  input: CaseDistillInput
): AttributionOutput {
  const known = citeKnownIn(input)
  const verdicts: AssetVerdict[] = []
  let uncited = out.uncitedDropped
  for (const v of out.verdicts) {
    if (!v.applied) {
      verdicts.push(v)
      continue
    }
    const cites = v.cites.filter(known)
    if (cites.length === 0) {
      uncited++
      continue
    }
    verdicts.push({ ...v, cites })
  }
  return { ...out, verdicts, uncitedDropped: uncited }
}

/** Every inventoried asset the judge said nothing about gets an explicit silent row, so coverage
 *  is visible and "silent" is distinguishable from "not inventoried". */
export function completeVerdicts(
  out: AttributionOutput,
  inventory: AssetInventoryEntry[]
): AttributionOutput {
  const have = new Set(out.verdicts.map((v) => `${v.kind}/${v.name}`))
  const silent: AssetVerdict[] = inventory
    .filter((a) => !have.has(`${a.kind}/${a.name}`))
    .map((a) => ({
      kind: a.kind,
      name: a.name,
      applied: null,
      verdict: null,
      reason: '',
      cites: []
    }))
  return { ...out, verdicts: [...out.verdicts, ...silent] }
}
