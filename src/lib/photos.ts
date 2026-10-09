import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { Prisma, type Event, type Photo } from "@prisma/client";
import sharp from "sharp";
import { z } from "zod";
import { db } from "./db";
import { getCurrentUser, SESSION_COOKIE, tokenHash } from "./auth";
import { guestCookie, getGuestAlbum } from "./albums";
import { AuthError, assertAuthOrigin } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { visibleEvents } from "./events";
import { deleteMedia, getMedia, putMedia } from "./storage";
import type { PhotoDTO } from "./photo-types";
import { voterHash } from "./visitor";
import { effectiveUploadBytes, imagePixelLimit, isDemoMode, uploadConcurrencyLimit } from "./runtime-limits";

if (isDemoMode()) {
  sharp.cache(false);
  sharp.concurrency(1);
}

type Actor = { kind: "staff"; userId: string; sessionHash: string } | { kind: "guest"; grantHash?: string; accessVersion: number };
export type PhotoAccess = { event: Event; actor: Actor };
const readyStatuses = ["PUBLISHED", "PENDING", "HIDDEN"] as const;
let activeUploads = 0;

export async function staffPhotoAccess(eventId: string): Promise<PhotoAccess> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError(401, "Войдите в аккаунт.");
  const event = await db.event.findFirst({ where: { id: eventId, ...visibleEvents(user) } });
  if (!event) throw new AuthError(404, "Мероприятие не найдено.");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new AuthError(401, "Войдите в аккаунт.");
  return { event, actor: { kind: "staff", userId: user.id, sessionHash: tokenHash(token) } };
}

export async function guestPhotoAccess(slug: string): Promise<PhotoAccess> {
  const album = await getGuestAlbum(slug);
  if (!album) throw new AuthError(404, "Альбом недоступен.");
  if (album.locked || !album.event) throw new AuthError(401, "Введите пароль альбома.");
  const event = await db.event.findUniqueOrThrow({ where: { id: album.event.id } });
  const token = (await cookies()).get(guestCookie(event.id))?.value;
  return { event, actor: { kind: "guest", accessVersion: event.accessVersion, grantHash: token && /^[a-f0-9]{64}$/.test(token) ? tokenHash(token) : undefined } };
}

// Runs inside the event lock for uploads/mutations and immediately before reads.
export async function authorize(tx: Prisma.TransactionClient, event: Event, actor: Actor, upload = false) {
  if (event.deletedAt) throw new AuthError(404, "Альбом недоступен.");
  if (actor.kind === "staff") {
    const session = await tx.session.findFirst({ where: { tokenHash: actor.sessionHash, userId: actor.userId, expiresAt: { gt: new Date() }, user: { disabledAt: null } }, include: { user: true } });
    if (!session) throw new AuthError(401, "Войдите в аккаунт.");
    if (session.user.role !== "ADMIN" && event.ownerId !== actor.userId && !await tx.eventMember.count({ where: { eventId: event.id, userId: actor.userId } })) {
      throw new AuthError(404, "Мероприятие не найдено.");
    }
  } else {
    if (event.expiresAt && event.expiresAt <= new Date()) throw new AuthError(404, "Альбом недоступен.");
    if (event.passwordHash && (!actor.grantHash || !await tx.accessToken.count({ where: { eventId: event.id, tokenHash: actor.grantHash, accessVersion: event.accessVersion, expiresAt: { gt: new Date() } } }))) {
      throw new AuthError(401, "Введите пароль альбома.");
    }
    if (upload && (actor.accessVersion !== event.accessVersion || !event.allowGuestUploads)) throw new AuthError(403, "Загрузка гостей отключена или настройки доступа изменились.");
  }
}

export function photoDTO(photo: Photo, access: PhotoAccess, likes = { likeCount: 0, liked: false }): PhotoDTO {
  return { id: photo.id, filename: photo.filename, width: photo.width ?? 1, height: photo.height ?? 1, status: photo.status,
    sizeBytes: photo.sizeBytes.toString(), createdAt: photo.createdAt.toISOString(),
    thumbnailUrl: `/api/photos/${photo.id}/thumbnail`,
    downloadUrl: access.actor.kind === "staff" || access.event.allowDownloads ? `/api/photos/${photo.id}/original` : null,
    ...likes,
  };
}

export async function listPhotos(access: PhotoAccess, cursor?: string, sort = "newest") {
  if (sort !== "newest" && sort !== "likes") throw new AuthError(400, "Некорректная сортировка фотографий.");
  if (cursor && !/^[a-zA-Z0-9-]{1,100}$/.test(cursor)) throw new AuthError(400, "Некорректная страница фотографий.");
  const voter = await voterHash(access);
  return db.$transaction(async tx => {
    const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
    await authorize(tx, event, access.actor);
    const where: Prisma.PhotoWhereInput = { eventId: event.id, status: access.actor.kind === "staff" ? { in: [...readyStatuses, "DELETING"] } : "PUBLISHED" };
    let continuation: Prisma.PhotoWhereInput = {};
    if (cursor) {
      const anchor = await tx.photo.findFirst({ where: { ...where, id: cursor } });
      if (!anchor) throw new AuthError(400, "Обновите галерею: страница больше недоступна.");
      if (sort === "newest") {
        continuation = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] };
      }
    }
    // Rank the whole accessible album, including photos beyond the first page.
    // createdAt/id give equal-like photos a deterministic order and cursor boundary.
    const orderBy: Prisma.PhotoOrderByWithRelationInput[] = [
      ...(sort === "likes" ? [{ likes: { _count: "desc" as const } }] : []),
      { createdAt: "desc" }, { id: "desc" },
    ];
    const totalCount = await tx.photo.count({ where });
    const photos = await tx.photo.findMany({ where: { ...where, ...continuation }, orderBy, take: 41,
      ...(sort === "likes" && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { _count: { select: { likes: true } }, likes: { where: { voterHash: voter ?? "" }, select: { photoId: true } } },
    });
    const page = photos.slice(0, 40);
    return { photos: page.map(photo => photoDTO(photo, { ...access, event }, { likeCount: photo._count.likes, liked: photo.likes.length > 0 })), nextCursor: photos.length > 40 ? page[page.length - 1].id : null, totalCount };
  });
}

async function readUpload(request: Request, limit: number) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new AuthError(415, "Выберите файл изображения.");
  const max = limit + 65536;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new AuthError(413, "Файл превышает лимит мероприятия.");
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "Выберите фотографию.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); throw new AuthError(413, "Файл превышает лимит мероприятия."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data: FormData;
  try { data = await new Request(request.url, { method: "POST", headers: { "Content-Type": type }, body: new Uint8Array(Buffer.concat(chunks)) }).formData(); }
  catch { throw new AuthError(400, "Некорректная загрузка."); }
  const files = data.getAll("file");
  if (files.length !== 1 || [...data.keys()].some(key => key !== "file") || !(files[0] instanceof File)) throw new AuthError(400, "Передайте одну фотографию в поле file.");
  const file = files[0];
  if (file.size === 0) throw new AuthError(400, "Файл пустой.");
  if (file.size > limit) throw new AuthError(413, "Файл превышает лимит мероприятия.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new AuthError(415, "Поддерживаются JPEG, PNG и WebP.");
  return { file, buffer: Buffer.from(await file.arrayBuffer()) };
}

async function releaseDeletedPhoto(id: string) {
  await db.$transaction(async tx => {
    const record = await tx.photo.findUnique({ where: { id } });
    if (!record) return;
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${record.eventId} FOR UPDATE`;
    const photo = await tx.photo.findUnique({ where: { id } });
    if (!photo || photo.status !== "DELETING") return;
    const event = await tx.event.findUniqueOrThrow({ where: { id: photo.eventId } });
    const used = photo.reservedBytes > 0n ? 0n : photo.sizeBytes + photo.thumbnailBytes;
    await tx.event.update({ where: { id: event.id }, data: { reservedBytes: event.reservedBytes >= photo.reservedBytes ? event.reservedBytes - photo.reservedBytes : 0n, usedStorageBytes: event.usedStorageBytes >= used ? event.usedStorageBytes - used : 0n } });
    await tx.photo.delete({ where: { id } });
  });
}

async function cleanupObjects(photo: Photo) {
  await deleteMedia(photo.originalKey);
  if (photo.thumbnailKey) await deleteMedia(photo.thumbnailKey);
  await releaseDeletedPhoto(photo.id);
}

export async function uploadPhoto(request: Request, access: PhotoAccess) {
  assertAuthOrigin(request);
  if (activeUploads >= uploadConcurrencyLimit()) throw new AuthError(429, "Идёт обработка фотографий. Повторите загрузку немного позже.", 5);
  activeUploads++;
  let reserved: Photo | undefined;
  try {
    await db.$transaction(tx => authorize(tx, access.event, access.actor, true));
    await consumeRateLimit(`media:upload:${access.actor.kind === "staff" ? access.actor.userId : access.event.id}`, 120, 900);
    const { file, buffer } = await readUpload(request, effectiveUploadBytes(access.event.maxUploadBytes));
    const maxPixels = imagePixelLimit();
    let thumbnail: Buffer;
    let width: number;
    let height: number;
    let format: string;
    try {
      const metadata = await sharp(buffer, { limitInputPixels: maxPixels, failOn: "warning" }).metadata();
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new AuthError(400, "Выберите обычную фотографию без анимации.");
      if (metadata.width * metadata.height > maxPixels) throw new Error("Image pixel limit exceeded");
      format = metadata.format ?? "";
      if (!["jpeg", "png", "webp"].includes(format)) throw new AuthError(415, "Поддерживаются JPEG, PNG и WebP.");
      const actualMime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      if (actualMime !== file.type) throw new AuthError(415, "Тип файла не соответствует содержимому.");
      width = metadata.orientation && metadata.orientation >= 5 ? metadata.height : metadata.width;
      height = metadata.orientation && metadata.orientation >= 5 ? metadata.width : metadata.height;
      thumbnail = await sharp(buffer, { limitInputPixels: maxPixels, failOn: "warning" }).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(400, `Не удалось прочитать фотографию. Максимум — ${maxPixels / 1000000} мегапикселей.`);
    }
    const id = randomUUID();
    const totalBytes = BigInt(buffer.byteLength + thumbnail.byteLength);
    const filename = Array.from(file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").toWellFormed()).slice(0, 240).join("") || `photo.${format}`;
    reserved = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
      const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
      await authorize(tx, event, access.actor, true);
      if (buffer.byteLength > effectiveUploadBytes(event.maxUploadBytes)) throw new AuthError(413, "Лимит файла изменился. Выберите меньшую фотографию.");
      if (await tx.photo.count({ where: { eventId: event.id } }) >= event.maxPhotos || event.usedStorageBytes + event.reservedBytes + totalBytes > event.maxStorageBytes) throw new AuthError(409, "Лимит альбома исчерпан. Обратитесь к организатору.");
      await tx.event.update({ where: { id: event.id }, data: { reservedBytes: { increment: totalBytes } } });
      return tx.photo.create({ data: { id, eventId: event.id, uploaderId: access.actor.kind === "staff" ? access.actor.userId : null,
        originalKey: `events/${event.id}/photos/${id}/original.${format}`, thumbnailKey: `events/${event.id}/photos/${id}/thumbnail.webp`,
        filename, mimeType: file.type, sizeBytes: BigInt(buffer.byteLength), thumbnailBytes: BigInt(thumbnail.byteLength), reservedBytes: totalBytes,
        width, height, status: "PROCESSING", uploadExpiresAt: new Date(Date.now() + 900000) } });
    });
    await putMedia(reserved.originalKey, buffer, reserved.mimeType);
    await putMedia(reserved.thumbnailKey!, thumbnail, "image/webp");
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
      const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
      await authorize(tx, event, access.actor, true);
      const photo = await tx.photo.findUnique({ where: { id } });
      if (!photo || photo.status !== "PROCESSING" || !photo.uploadExpiresAt || photo.uploadExpiresAt <= new Date()) throw new AuthError(409, "Время загрузки истекло. Повторите попытку.");
      const status = "PUBLISHED";
      const finalized = await tx.photo.update({ where: { id }, data: { status, reservedBytes: 0n, uploadExpiresAt: null } });
      await tx.event.update({ where: { id: event.id }, data: { reservedBytes: { decrement: totalBytes }, usedStorageBytes: { increment: totalBytes }, mediaVersion: { increment: 1 } } });
      return photoDTO(finalized, { ...access, event });
    });
  } catch (error) {
    if (reserved) {
      try {
        await db.photo.updateMany({ where: { id: reserved.id }, data: { status: "DELETING" } });
        // Delete known keys even if the recovery worker already removed the row.
        await cleanupObjects(reserved);
      } catch { console.error("Media cleanup queued for recovery"); }
    }
    throw error;
  } finally { activeUploads--; }
}

export async function moderatePhotos(input: unknown, access: PhotoAccess) {
  if (access.actor.kind !== "staff") throw new AuthError(403, "Модерация доступна команде мероприятия.");
  const parsed = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100), action: z.enum(["publish", "hide", "delete"]) }).strict().safeParse(input);
  if (!parsed.success || new Set(parsed.success ? parsed.data.ids : []).size !== (parsed.success ? parsed.data.ids.length : -1)) throw new AuthError(400, "Выберите до 100 фотографий и действие.");
  const { ids, action } = parsed.data;
  const photos = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: access.event.id } });
    await authorize(tx, event, access.actor);
    const photos = await tx.photo.findMany({ where: { id: { in: ids }, eventId: event.id, status: { in: action === "delete" ? [...readyStatuses, "DELETING"] : [...readyStatuses] } } });
    if (photos.length !== ids.length) throw new AuthError(404, "Одна из фотографий недоступна. Обновите галерею.");
    await tx.photo.updateMany({ where: { id: { in: ids }, eventId: event.id }, data: { status: action === "publish" ? "PUBLISHED" : action === "hide" ? "HIDDEN" : "DELETING" } });
    if (photos.some(photo => action === "publish" ? photo.status !== "PUBLISHED" : photo.status === "PUBLISHED")) {
      await tx.event.update({ where: { id: event.id }, data: { mediaVersion: { increment: 1 } } });
    }
    return photos;
  });
  if (action === "delete") {
    const results = await Promise.allSettled(photos.map(cleanupObjects));
    if (results.some(result => result.status === "rejected")) throw new AuthError(503, "Фото скрыты. Удаление файлов будет повторено фоновым сервисом.");
  }
}

export async function readPhoto(id: string, variant: "thumbnail" | "original") {
  let photo = await db.photo.findUnique({ where: { id }, include: { event: true } });
  if (!photo || !readyStatuses.includes(photo.status as typeof readyStatuses[number])) throw new AuthError(404, "Фотография недоступна.");
  let access: PhotoAccess;
  try { access = await staffPhotoAccess(photo.eventId); }
  catch (error) {
    if (!(error instanceof AuthError) || ![401, 404].includes(error.status)) throw error;
    access = await guestPhotoAccess(photo.event.slug);
    if (photo.status !== "PUBLISHED") throw new AuthError(404, "Фотография недоступна.");
  }
  photo = await db.$transaction(async tx => {
    // Settings and moderation may have changed while resolving the session.
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${access.event.id} FOR UPDATE`;
    const current = await tx.photo.findUnique({ where: { id }, include: { event: true } });
    if (!current || !readyStatuses.includes(current.status as typeof readyStatuses[number]) || (access.actor.kind === "guest" && current.status !== "PUBLISHED")) throw new AuthError(404, "Фотография недоступна.");
    await authorize(tx, current.event, access.actor);
    if (variant === "original" && access.actor.kind === "guest" && !current.event.allowDownloads) throw new AuthError(403, "Скачивание отключено организатором.");
    return current;
  });
  const key = variant === "thumbnail" ? photo.thumbnailKey : photo.originalKey;
  if (!key) throw new AuthError(404, "Фотография недоступна.");
  const object = await getMedia(key);
  if (!object.Body) throw new AuthError(404, "Файл недоступен.");
  if (variant === "original") await db.$transaction([
    db.photo.updateMany({ where: { id }, data: { downloadCount: { increment: 1 } } }),
    db.event.update({ where: { id: photo.eventId }, data: { downloadCount: { increment: 1 } } }),
  ]);
  return new Response(object.Body.transformToWebStream(), { headers: {
    "Content-Type": variant === "thumbnail" ? "image/webp" : photo.mimeType,
    "Content-Length": String(object.ContentLength ?? (variant === "thumbnail" ? photo.thumbnailBytes : photo.sizeBytes)),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": variant === "original" ? `attachment; filename="photo.${photo.mimeType.split("/")[1]}"; filename*=UTF-8''${encodeURIComponent(photo.filename.toWellFormed()).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` : "inline",
  } });
}
