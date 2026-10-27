/** Compare elapsed browser time with the server's remaining lease, without assuming clocks are identical. */
export function bedroomReadingCurrent(generatedAt: number, receivedAt: number, expiresAt: number | null, now: number, failed = false): boolean {
  if (failed || !Number.isSafeInteger(generatedAt) || !Number.isSafeInteger(receivedAt) || expiresAt === null) return false
  const elapsed = now - receivedAt
  return elapsed >= 0 && elapsed < 15_000 && expiresAt - generatedAt > elapsed
}
