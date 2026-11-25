let kicker: () => void = () => {};

/** Wakes the worker after an enqueue. The worker installs itself; tests may leave it a no-op. */
export function kick(): void {
  kicker();
}

export function setKicker(fn: () => void): void {
  kicker = fn;
}
