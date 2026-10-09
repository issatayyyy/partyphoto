import "server-only";
import { z } from "zod";
import { db } from "./db";
import { tokenHash } from "./auth";
import { AuthError } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { authorize, guestPhotoAccess } from "./photos";
import { visitorToken } from "./visitor";

export async function recordAlbumView(slug: string, input: unknown) {
  if (!z.object({}).strict().safeParse(input).success) throw new AuthError(400, "Некорректный запрос просмотра.");
  const access = await guestPhotoAccess(slug);
  const token = await visitorToken();
  if (!token) throw new AuthError(409, "Обновите галерею и повторите попытку.");
  const visitorHash = tokenHash(`visitor:${token}`);
  await consumeRateLimit(`view:visitor:${visitorHash}`, 120, 60);
  await consumeRateLimit(`view:event:${access.event.id}`, 3600, 60);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
    const event = await tx.event.findUnique({ where: { id: access.event.id } });
    if (!event) throw new AuthError(404, "Альбом недоступен.");
    await authorize(tx, event, access.actor);
    // PostgreSQL owns the clock and uniqueness across concurrent app instances.
    // Refreshes do not extend the window: a new view is eligible after 24 hours.
    const counted = await tx.$queryRaw<{ eventId: string }[]>`
      INSERT INTO "AlbumView" ("eventId", "visitorHash", "lastCountedAt")
      VALUES (${event.id}, ${visitorHash}, CURRENT_TIMESTAMP)
      ON CONFLICT ("eventId", "visitorHash") DO UPDATE
      SET "lastCountedAt" = CURRENT_TIMESTAMP
      WHERE "AlbumView"."lastCountedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      RETURNING "eventId"
    `;
    if (counted.length) await tx.event.update({ where: { id: event.id }, data: { viewCount: { increment: 1 } } });
    return { counted: counted.length > 0 };
  });
}
