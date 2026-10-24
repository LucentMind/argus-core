import { LangfuseSink, type TracingApi, type ObservationHandle } from '../sink'
import { describeSinkContract, type ContractHarness } from '../../__tests__/sinkContract'

const ROOT_NAME = 'case-x · session 77'

function harness(opts: { captureContent: boolean }): ContractHarness {
  const starts: { name: string; attrs: Record<string, unknown>; parentSpanId: string }[] = []
  let attempts = 0
  let rootSpanId: string | null = null
  const scores: { traceId: string }[] = []
  let throwNext = false
  const api: TracingApi = {
    createTraceId: async (seed) => `trace-${seed}`,
    startObservation: (name, attrs, opts) => {
      attempts++
      if (throwNext) throw new Error('backend down')
      starts.push({
        name,
        attrs: attrs as Record<string, unknown>,
        parentSpanId: opts.parentSpanContext.spanId
      })
      const h: ObservationHandle = { spanId: `span-${starts.length}`, end: () => {} }
      if (name === ROOT_NAME && rootSpanId === null) rootSpanId = h.spanId
      return h
    },
    createScore: async (o) => {
      attempts++
      if (throwNext) throw new Error('backend down')
      scores.push({ traceId: o.traceId })
    },
    forceFlush: async () => {},
    shutdown: async () => {}
  }
  const sink = new LangfuseSink(api, opts)
  return {
    sink,
    settle: async () => {
      await new Promise((r) => setTimeout(r, 0))
    },
    backendThrows: () => {
      throwNext = true
    },
    recorded: () => ({
      roots: starts.filter((s) => s.name === ROOT_NAME).length,
      childrenOfRoot: starts.filter((s) => s.name !== ROOT_NAME && s.parentSpanId === rootSpanId)
        .length,
      attempts,
      scoresForSeed: (seed) => scores.filter((s) => s.traceId === `trace-${seed}`).length,
      containsText: (t) => JSON.stringify(starts).includes(t)
    })
  }
}

describeSinkContract('LangfuseSink', harness)
