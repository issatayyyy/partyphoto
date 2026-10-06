import "server-only";
import { randomUUID } from "node:crypto";
import type { Event, MediaJob, Prisma } from "@prisma/client";
import { db } from "./db";
import { AuthError } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { authorize, guestPhotoAccess, staffPhotoAccess, type PhotoAccess } from "./photos";
import { voterHash } from "./visitor";
import { getMedia } from "./storage";
import type { ZipDTO } from "./zip-types";

function limit(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || (name === "MAX_ZIP_PHOTOS" && value > 10000)) throw new Error(`Invalid ${name}`);
  return value;
}
function prefix(event: Event) { return `zip:${event.id}:${event.mediaVersion}:${event.accessVersion}:`; }
async function allowed(tx: Prisma.TransactionClient, event: Event, access: PhotoAccess) {
  await authorize(tx, event, access.actor);
  if (event.expiresAt && event.expiresAt <= new Date()) throw new AuthError(404, "Срок доступа к альбому истёк.");
  if (access.actor.kind === "guest" && !event.allowDownloads) throw new AuthError(403, "Скачивание отключено организатором.");
}
function dto(job: MediaJob): ZipDTO {
  return { id: job.id, status: job.status, totalPhotos: job.totalPhotos, processedPhotos: job.processedPhotos,
    downloadUrl: job.status === "DONE" && job.resultKey ? `/api/zip/${job.id}/download` : null,
    error: job.status === "FAILED" ? "Не удалось собрать архив. Повторите попытку." : null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
  };
}
export async function getZip(access: PhotoAccess) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
    await allowed(tx, event, access);
    const job = await tx.mediaJob.findFirst({ where: { eventId: event.id, kind: "ZIP", dedupeKey: { startsWith: prefix(event) }, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    return job ? dto(job) : null;
  });
}
export async function queueZip(access: PhotoAccess) {
  const subject = await voterHash(access) ?? access.event.id;
  await consumeRateLimit(`zip:create:${subject}`, 10, 900);
  return db.$transaction(async tx => {
    // Serialize the shared queue cap before taking an individual event lock.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('partyphoto:zip:queue'))::text`;
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
    await allowed(tx, event, access);
    const existing = await tx.mediaJob.findFirst({ where: { eventId: event.id, kind: "ZIP", dedupeKey: { startsWith: prefix(event) }, expiresAt: { gt: new Date() }, status: { in: ["QUEUED", "RUNNING", "DONE"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (existing) return dto(existing);
    const photos = await tx.photo.findMany({ where: { eventId: event.id, status: "PUBLISHED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, sizeBytes: true }, take: limit("MAX_ZIP_PHOTOS", 10000) + 1 });
    if (!photos.length) throw new AuthError(400, "В альбоме пока нет опубликованных фотографий.");
    if (photos.length > limit("MAX_ZIP_PHOTOS", 10000) || photos.reduce((sum, photo) => sum + photo.sizeBytes, 0n) > BigInt(limit("MAX_ZIP_BYTES", 1073741824))) throw new AuthError(413, "Альбом слишком большой для одного ZIP-архива. Скачайте фотографии отдельно.");
    const active = await tx.mediaJob.count({ where: { kind: "ZIP", status: { in: ["QUEUED", "RUNNING"] }, expiresAt: { gt: new Date() } } });
    if (active >= 10) throw new AuthError(429, "Очередь архивов заполнена. Попробуйте немного позже.", 30);
    const job = await tx.mediaJob.create({ data: {
      eventId: event.id, kind: "ZIP", dedupeKey: `${prefix(event)}${randomUUID()}`,
      payload: { mediaVersion: event.mediaVersion, accessVersion: event.accessVersion, photoIds: photos.map(photo => photo.id) },
      totalPhotos: photos.length, expiresAt: new Date(Date.now() + 3600000),
    } });
    return dto(job);
  });
}
export async function zipDownload(id: string) {
  const job = await db.mediaJob.findFirst({ where: { id, kind: "ZIP" }, include: { event: true } });
  if (!job) throw new AuthError(404, "Архив недоступен.");
  let access: PhotoAccess;
  try { access = await staffPhotoAccess(job.eventId); }
  catch (error) {
    if (!(error instanceof AuthError) || ![401, 404].includes(error.status)) throw error;
    access = await guestPhotoAccess(job.event.slug);
  }
  const current = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${job.eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: job.eventId } });
    await allowed(tx, event, access);
    const latest = await tx.mediaJob.findUniqueOrThrow({ where: { id } });
    if (!latest.expiresAt || latest.expiresAt <= new Date()) throw new AuthError(410, "Срок хранения архива истёк. Соберите его заново.");
    if (!latest.dedupeKey.startsWith(prefix(event))) throw new AuthError(409, "Альбом изменился. Соберите архив заново.");
    if (latest.status !== "DONE" || !latest.resultKey) throw new AuthError(409, "Архив ещё не готов.");
    const payload = latest.payload as { photoIds?: unknown };
    if (!Array.isArray(payload.photoIds) || payload.photoIds.some(value => typeof value !== "string") || await tx.photo.count({ where: { id: { in: payload.photoIds }, eventId: event.id, status: "PUBLISHED" } }) !== payload.photoIds.length) throw new AuthError(409, "Состав альбома изменился. Соберите архив заново.");
    return { job: latest, event, ids: payload.photoIds as string[] };
  });
  const object = await getMedia(current.job.resultKey!);
  if (!object.Body) throw new AuthError(404, "Архив недоступен.");
  await db.$transaction([
    db.event.update({ where: { id: current.event.id }, data: { downloadCount: { increment: 1 } } }),
    db.photo.updateMany({ where: { id: { in: current.ids }, eventId: current.event.id }, data: { downloadCount: { increment: 1 } } }),
  ]);
  return new Response(object.Body.transformToWebStream(), { headers: {
    "Content-Type": "application/zip", "Content-Length": String(object.ContentLength ?? current.job.sizeBytes),
    "Content-Disposition": `attachment; filename="${current.event.slug}.zip"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
