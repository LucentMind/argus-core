import { LangfuseSink, type TracingApi, type ObservationHandle } from '../sink'
import { describeSinkContract, type ContractHarness } from '../../__tests__/sinkContract'

function harness(opts: { captureContent: boolean }): ContractHarness {
  const starts: { name: string; attrs: Record<string, unknown> }[] = []
  const scores: { traceId: string }[] = []
  let throwNext = false
  const api: TracingApi = {
    createTraceId: async (seed) => `trace-${seed}`,
    startObservation: (name, attrs) => {
      if (throwNext) throw new Error('backend down')
      starts.push({ name, attrs: attrs as Record<string, unknown> })
      const h: ObservationHandle = { spanId: `span-${starts.length}`, end: () => {} }
      return h
    },
    createScore: async (o) => {
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
      roots: starts.filter((s) => s.name === 'case-x · session 77').length,
      scoresForSeed: (seed) => scores.filter((s) => s.traceId === `trace-${seed}`).length,
      containsText: (t) => JSON.stringify(starts).includes(t)
    })
  }
}

describeSinkContract('LangfuseSink', harness)
