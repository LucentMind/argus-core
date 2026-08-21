import { IPC } from '../../../../shared/ipc'
import type { AdapterId, CurrencyPayload } from '../../../../shared/currency'

const ADAPTER_IDS: readonly AdapterId[] = ['core', 'packs', 'hive']

/** Structural, not the CurrencyService class — matches the house DI convention. */
export interface CurrencyServiceLike {
  payload(): CurrencyPayload
  surveyNow(id: AdapterId): Promise<void>
  subscribe(cb: (p: CurrencyPayload) => void): () => void
}

export interface CurrencyIpcDeps {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ipcMain.handle's own
     permissive signature; a narrower type would reject the differently-shaped listeners below
     (one takes no args, the other takes an adapter id). */
  handle(channel: string, fn: (...args: any[]) => unknown): void
  broadcast(channel: string, payload: unknown): void
  service: CurrencyServiceLike
  /** Only the two methods the first-run notice ack needs — not the whole `CurrencyAnchorStore`,
   *  which also owns per-adapter survey scheduling this channel has no business touching. */
  anchors: { firstMirrorNoticeShown(): boolean; markFirstMirrorNoticeShown(): void }
}

/** Registers the currency channels. Returns a disposer that stops the change broadcasts. */
export function registerCurrencyIpc({
  handle,
  broadcast,
  service,
  anchors
}: CurrencyIpcDeps): () => void {
  handle(IPC.currencyGet, () => service.payload())
  handle(IPC.currencySurveyNow, async (id: unknown) => {
    // Validated against the closed set rather than passed through: the renderer is not the
    // authority on which adapters exist.
    if (!ADAPTER_IDS.includes(id as AdapterId)) return
    await service.surveyNow(id as AdapterId)
  })
  // The flag is set HERE, by the renderer's acknowledgement, not by the broadcast that triggers
  // it: `noticeStore` only renders inside the case header, so a notice pushed with no case open
  // is silently dropped. If main set the flag when it broadcasts, that would consume the one
  // chance to show it — see `onAdopted` in `index.ts` for the other half of this.
  handle(IPC.currencyAckAdopted, () => {
    anchors.markFirstMirrorNoticeShown()
  })
  return service.subscribe((p) => broadcast(IPC.currencyChanged, p))
}
