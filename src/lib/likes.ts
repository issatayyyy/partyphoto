import "server-only";
import { z } from "zod";
import { db } from "./db";
import { AuthError } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { authorize, guestPhotoAccess, staffPhotoAccess, type PhotoAccess } from "./photos";
import { voterHash } from "./visitor";

export async function setPhotoLike(id: string, input: unknown) {
  const parsed = z.object({ liked: z.boolean() }).strict().safeParse(input);
  if (!parsed.success) throw new AuthError(400, "Укажите, поставить или убрать лайк.");
  const photo = await db.photo.findUnique({ where: { id }, include: { event: true } });
  if (!photo || photo.status !== "PUBLISHED") throw new AuthError(404, "Фотография недоступна.");
  let access: PhotoAccess;
  try { access = await staffPhotoAccess(photo.eventId); }
  catch (error) {
    if (!(error instanceof AuthError) || ![401, 404].includes(error.status)) throw error;
    access = await guestPhotoAccess(photo.event.slug);
  }
  const voter = await voterHash(access);
  if (!voter) throw new AuthError(409, "Обновите галерею и повторите нажатие.");
  await consumeRateLimit(`like:voter:${voter}`, 180, 60);
  await consumeRateLimit(`like:event:${photo.eventId}`, 1200, 60);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${photo.eventId} FOR UPDATE`;
    const current = await tx.photo.findUnique({ where: { id }, include: { event: true } });
    if (!current || current.status !== "PUBLISHED") throw new AuthError(404, "Фотография недоступна.");
    await authorize(tx, current.event, access.actor);
    if (parsed.data.liked) await tx.photoLike.createMany({ data: [{ photoId: id, voterHash: voter }], skipDuplicates: true });
    else await tx.photoLike.deleteMany({ where: { photoId: id, voterHash: voter } });
    return { liked: parsed.data.liked, likeCount: await tx.photoLike.count({ where: { photoId: id } }) };
  });
}
