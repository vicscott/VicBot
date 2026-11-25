import type { BusMessage } from "./types";

type Listener = (message: BusMessage) => void;
const listeners = new Set<Listener>();

export const bus = {
  emit(message: BusMessage): void {
    for (const listener of listeners) listener(message);
  },
  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
