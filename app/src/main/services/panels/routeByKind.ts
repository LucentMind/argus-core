export type WindowKind = 'webPanel' | 'externalApp'

/** Resolve which host owns a window, by kind. Returns null for an unknown window. */
export function routeByKind(
  kindOf: (packId: string, windowId: string) => WindowKind | null,
  packId: string,
  windowId: string
): WindowKind | null {
  return kindOf(packId, windowId)
}
