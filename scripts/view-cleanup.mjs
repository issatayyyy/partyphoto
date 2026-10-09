// Deduplication records expire; the album's cumulative counter is never reset.
// Use the same database clock and 24-hour boundary as the counting transaction.
export async function pruneAlbumViews(db) {
  return db.$executeRaw`DELETE FROM "AlbumView"
    WHERE "lastCountedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'`;
}

export async function pruneViewRateLimits(db) {
  return db.$executeRaw`DELETE FROM "AuthRateLimit"
    WHERE "key" LIKE 'view:%' AND "resetAt" <= CURRENT_TIMESTAMP`;
}
