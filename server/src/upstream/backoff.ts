export interface BackoffInput {
  failures: number;
  connectedAtMs: number | null;
  nowMs: number;
  random: number;
  closeCode: number;
}

/** Injected wall time and uniform [0,1] random value: no clocks/IO here. */
export function reconnectDelay(input: BackoffInput) {
  const stable = input.connectedAtMs !== null && input.nowMs - input.connectedAtMs >= 300_000;
  const failures = stable ? 0 : input.failures;
  const baseMs = input.closeCode === 4029
    ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
  const jitter = 0.8 + 0.4 * Math.max(0, Math.min(1, input.random));
  return {
    delayMs: Math.min(60_000, Math.round(baseMs * jitter)),
    // Once a 4029 starts at the cap, subsequent short-lived failures stay there.
    nextFailures: input.closeCode === 4029 ? 6 : Math.min(failures + 1, 6),
  };
}
