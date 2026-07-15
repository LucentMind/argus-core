import { useSyncExternalStore } from 'react'

interface TourState {
  open: boolean
  index: number
}

class TourStore {
  private state: TourState = { open: false, index: 0 }
  private listeners = new Set<() => void>()

  get(): TourState { return this.state }
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private set(s: TourState): void {
    this.state = s
    for (const cb of this.listeners) cb()
  }
  startTour(): void { this.set({ open: true, index: 0 }) }
  exitTour(): void { this.set({ open: false, index: 0 }) }
  next(): void { this.set({ ...this.state, index: this.state.index + 1 }) }
  back(): void { this.set({ ...this.state, index: Math.max(0, this.state.index - 1) }) }
  goto(i: number): void { this.set({ ...this.state, index: Math.max(0, i) }) }
}

export const tourStore = new TourStore()

export function useTour(): TourState {
  return useSyncExternalStore(tourStore.subscribe, () => tourStore.get())
}
