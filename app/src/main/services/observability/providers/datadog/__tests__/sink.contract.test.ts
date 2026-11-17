import {
  DatadogSink,
  datadogTraceId,
  rootSpanIdFromSeed,
  type DatadogEval,
  type DatadogSpan
} from '../sink'
import type { DatadogIntake } from '../intake'
import {
  describeSinkContract,
  CONTRACT_SEED,
  type ContractHarness
} from '../../__tests__/sinkContract'

/**
 * A fake intake that keeps every body it ACCEPTS and counts every record it is handed BEFORE it
 * accepts or rejects it (`attempts`). `backendThrows` makes every later call throw synchronously,
 * the harshest failure an intake can produce.
 */
function harness(opts: { captureContent: boolean }): ContractHarness {
  const spans: DatadogSpan[] = []
  const evals: DatadogEval[] = []
  const bodies: unknown[] = []
  let attempts = 0
  let throwing = false
  const intake: DatadogIntake = {
    postSpans: async (body) => {
      const b = body as { data: { attributes: { spans: DatadogSpan[] } } }
      attempts += b.data.attributes.spans.length
      // Like the real intake: duration must be > 0, and a bad span rejects the whole request.
      if (b.data.attributes.spans.some((x) => x.duration <= 0))
        throw new Error('HTTP 400 · span duration has to be greater than zero')
      if (throwing) throw new Error('backend down')
      bodies.push(body)
      spans.push(...b.data.attributes.spans)
    },
    postEvals: async (body) => {
      const b = body as { data: { attributes: { metrics: DatadogEval[] } } }
      attempts += b.data.attributes.metrics.length
      if (throwing) throw new Error('backend down')
      bodies.push(body)
      evals.push(...b.data.attributes.metrics)
    }
  }
  const sink = new DatadogSink(intake, {
    captureContent: opts.captureContent,
    mlApp: 'argus',
    tags: ['service:argus']
  })
  return {
    sink,
    settle: async () => {
      await new Promise((r) => setTimeout(r, 0))
    },
    backendThrows: () => {
      throwing = true
    },
    recorded: () => {
      const rootId = rootSpanIdFromSeed(CONTRACT_SEED)
      const traceId = datadogTraceId(CONTRACT_SEED)
      return {
        roots: spans.filter((s) => s.parent_id === 'undefined').length,
        childrenOfRoot: spans.filter((s) => s.parent_id === rootId && s.trace_id === traceId)
          .length,
        attempts,
        scoresForSeed: (seed) =>
          evals.filter((e) => e.join_on.span.trace_id === datadogTraceId(seed)).length,
        containsText: (t) => JSON.stringify(bodies).includes(t)
      }
    }
  }
}

describeSinkContract('DatadogSink', harness)
