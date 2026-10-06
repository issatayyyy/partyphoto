import { DeleteObjectCommand } from "@aws-sdk/client-s3";

// Deletion is idempotent in S3; the event lock makes quota release idempotent too.
export async function recoverMedia(db, s3, bucket, { now = new Date(), limit = 100 } = {}) {
  const candidates = await db.photo.findMany({
    where: { OR: [
      { status: "DELETING" },
      { status: "PROCESSING", uploadExpiresAt: { lte: now } },
    ] },
    orderBy: { updatedAt: "asc" }, take: limit,
  });
  let removed = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const claimed = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${candidate.eventId} FOR UPDATE`;
        const photo = await tx.photo.findUnique({ where: { id: candidate.id } });
        if (!photo || (photo.status !== "DELETING" && !(photo.status === "PROCESSING" && photo.uploadExpiresAt && photo.uploadExpiresAt <= now))) return null;
        return tx.photo.update({ where: { id: photo.id }, data: { status: "DELETING" } });
      });
      if (!claimed) continue;
      for (const key of [claimed.originalKey, claimed.thumbnailKey].filter(Boolean)) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
      const released = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${candidate.eventId} FOR UPDATE`;
        const photo = await tx.photo.findUnique({ where: { id: candidate.id } });
        if (!photo || photo.status !== "DELETING") return false;
        const event = await tx.event.findUniqueOrThrow({ where: { id: photo.eventId } });
        const usedBytes = photo.reservedBytes > 0n ? 0n : photo.sizeBytes + photo.thumbnailBytes;
        await tx.event.update({ where: { id: event.id }, data: {
          reservedBytes: event.reservedBytes >= photo.reservedBytes ? event.reservedBytes - photo.reservedBytes : 0n,
          usedStorageBytes: event.usedStorageBytes >= usedBytes ? event.usedStorageBytes - usedBytes : 0n,
        } });
        await tx.photo.delete({ where: { id: photo.id } });
        return true;
      });
      if (released) removed++;
    } catch {
      // Keep both the row and quota until both objects are confirmed deleted.
      failed++;
    }
  }
  return { removed, failed };
}
