/**
 * Backoff exponencial puro: `baseMs * 2^attempt`, limitado a `maxMs`.
 * `attempt` negativo é tratado como 0.
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt)), maxMs);
}

