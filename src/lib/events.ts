import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import type { CurrentUser } from "./auth";
import type { EventDTO } from "./event-types";
import { AuthError, appOrigin } from "./auth-http";
import { hashPassword } from "./password";

const mb = 1048576;
const date = z.string().datetime({ offset: true }).nullable();
const fields = {
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000),
  slug: z.string().trim().toLowerCase()
    .refine(value => value === "" || /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/.test(value), "Слаг: 3–64 латинских символа, цифры и дефисы.")
    .refine(value => value !== "resolve", "Этот адрес зарезервирован. Выберите другой."),
  startsAt: date,
  expiresAt: date,
  allowGuestUploads: z.boolean(),
  moderateUploads: z.boolean(),
  allowDownloads: z.boolean(),
  maxPhotos: z.number().int().min(1).max(10000),
  maxStorageMb: z.number().int().min(10).max(102400),
  maxUploadMb: z.number().int().min(1).max(25),
  password: z.string().max(128).refine(value => value === "" || value.length >= 3, "Пароль альбома: 3–128 символов."),
};
const createSchema = z.object({
  title: fields.title,
  description: fields.description.default(""),
  slug: fields.slug.default(""),
  startsAt: fields.startsAt.default(null),
  expiresAt: fields.expiresAt.default(null),
  allowGuestUploads: fields.allowGuestUploads.default(false),
  moderateUploads: fields.moderateUploads.default(true),
  allowDownloads: fields.allowDownloads.default(true),
  maxPhotos: fields.maxPhotos.default(1000),
  maxStorageMb: fields.maxStorageMb.default(10240),
  maxUploadMb: fields.maxUploadMb.default(25),
  password: fields.password.default(""),
}).strict();
const patchSchema = z.object(fields).partial().strict().refine(input => Object.keys(input).length > 0, "Укажите настройки для изменения.");
const include = { members: true, _count: { select: { photos: true } } } as const;
type EventRecord = Prisma.EventGetPayload<{ include: typeof include }>;

export function visibleEvents(user: CurrentUser): Prisma.EventWhereInput {
  return { deletedAt: null, ...(user.role === "ADMIN" ? {} : { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] }) };
}

function canManageEvent(event: EventRecord, user: CurrentUser) {
  return user.role === "ADMIN" || (user.role === "ORGANIZER" && (event.ownerId === user.id || event.members.some(member => member.userId === user.id && member.role === "ORGANIZER")));
}

function dto(event: EventRecord, user: CurrentUser): EventDTO {
  return {
    id: event.id, title: event.title, slug: event.slug, code: event.code, description: event.description,
    startsAt: event.startsAt?.toISOString() ?? null, expiresAt: event.expiresAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(), allowGuestUploads: event.allowGuestUploads,
    moderateUploads: event.moderateUploads, allowDownloads: event.allowDownloads,
    maxPhotos: event.maxPhotos, maxStorageMb: Number(event.maxStorageBytes / BigInt(mb)), maxUploadMb: event.maxUploadBytes / mb,
    usedStorageBytes: event.usedStorageBytes.toString(), viewCount: event.viewCount.toString(), downloadCount: event.downloadCount.toString(),
    photoCount: event._count.photos, hasPassword: event.passwordHash !== null, canManage: canManageEvent(event, user),
    url: `${appOrigin()}/e/${event.slug}`,
  };
}

export async function listEvents(user: CurrentUser) {
  const events = await db.event.findMany({ where: visibleEvents(user), include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  return events.map(event => dto(event, user));
}

export async function getEventForUser(id: string, user: CurrentUser) {
  const event = await db.event.findFirst({ where: { id, ...visibleEvents(user) }, include });
  return event ? dto(event, user) : null;
}

function checkDates(startsAt: Date | null, expiresAt: Date | null) {
  if (expiresAt && (expiresAt <= new Date() || (startsAt && expiresAt <= startsAt))) {
    throw new AuthError(400, "Срок доступа должен быть в будущем и позже начала мероприятия.");
  }
}

function code() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  // Rejection sampling avoids modulo bias for a non-power-of-two alphabet.
  let value = "";
  while (value.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < Math.floor(256 / alphabet.length) * alphabet.length) value += alphabet[byte % alphabet.length];
      if (value.length === 8) break;
    }
  }
  return value;
}

export async function createEvent(input: unknown, user: CurrentUser) {
  if (!["ADMIN", "ORGANIZER"].includes(user.role)) throw new AuthError(403, "Создавать мероприятия может организатор.");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new AuthError(400, parsed.error.issues[0].message);
  const data = parsed.data;
  const startsAt = data.startsAt ? new Date(data.startsAt) : null;
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  checkDates(startsAt, expiresAt);
  const passwordHash = data.password ? await hashPassword(data.password) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = data.slug || `event-${randomBytes(6).toString("hex")}`;
    try {
      const event = await db.event.create({
        data: {
          ownerId: user.id, title: data.title, description: data.description, slug, code: code(), startsAt, expiresAt, passwordHash,
          allowGuestUploads: data.allowGuestUploads, moderateUploads: data.moderateUploads, allowDownloads: data.allowDownloads,
          maxPhotos: data.maxPhotos, maxStorageBytes: BigInt(data.maxStorageMb) * BigInt(mb), maxUploadBytes: data.maxUploadMb * mb,
        }, include,
      });
      return dto(event, user);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      if (data.slug && Array.isArray(error.meta?.target) && error.meta.target.includes("slug")) {
        throw new AuthError(409, "Этот адрес альбома уже занят. Выберите другой.");
      }
    }
  }
  throw new AuthError(409, "Не удалось создать уникальный адрес. Попробуйте ещё раз.");
}

export async function updateEvent(id: string, input: unknown, user: CurrentUser) {
  // Authorize before validating data or hashing a password for an inaccessible event.
  const current = await db.event.findFirst({ where: { id, ...visibleEvents(user) }, include });
  if (!current) throw new AuthError(404, "Мероприятие не найдено.");
  if (!canManageEvent(current, user)) throw new AuthError(403, "Настройки доступны организатору мероприятия.");
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) throw new AuthError(400, parsed.error.issues[0].message);
  const data = parsed.data;
  const passwordHash = data.password === undefined ? undefined : data.password ? await hashPassword(data.password) : null;
  return db.$transaction(async tx => {
    // Serialize settings updates against quota reservation and guest unlock.
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${id} FOR UPDATE`;
    const event = await tx.event.findFirst({ where: { id, ...visibleEvents(user) }, include });
    if (!event) throw new AuthError(404, "Мероприятие не найдено.");
    if (!canManageEvent(event, user)) throw new AuthError(403, "Настройки доступны организатору мероприятия.");
    const startsAt = data.startsAt === undefined ? event.startsAt : data.startsAt ? new Date(data.startsAt) : null;
    const expiresAt = data.expiresAt === undefined ? event.expiresAt : data.expiresAt ? new Date(data.expiresAt) : null;
    // An already expired album can still be edited without extending its lifetime.
    const datesChanged = startsAt?.getTime() !== event.startsAt?.getTime() || expiresAt?.getTime() !== event.expiresAt?.getTime();
    if (datesChanged) checkDates(startsAt, expiresAt);
    if (data.maxStorageMb !== undefined && BigInt(data.maxStorageMb) * BigInt(mb) < event.usedStorageBytes + event.reservedBytes) {
      throw new AuthError(400, "Лимит хранилища меньше уже занятого и зарезервированного объёма.");
    }
    if (data.maxPhotos !== undefined && data.maxPhotos < event._count.photos) throw new AuthError(400, "Лимит фотографий меньше текущего количества.");
    const revoke = data.password !== undefined || expiresAt?.getTime() !== event.expiresAt?.getTime()
      || (data.allowGuestUploads !== undefined && data.allowGuestUploads !== event.allowGuestUploads)
      || (data.allowDownloads !== undefined && data.allowDownloads !== event.allowDownloads);
    const updated = await tx.event.update({ where: { id }, data: {
      title: data.title, description: data.description, slug: data.slug || undefined, startsAt, expiresAt,
      passwordHash, allowGuestUploads: data.allowGuestUploads, moderateUploads: data.moderateUploads,
      allowDownloads: data.allowDownloads, maxPhotos: data.maxPhotos,
      maxStorageBytes: data.maxStorageMb === undefined ? undefined : BigInt(data.maxStorageMb) * BigInt(mb),
      maxUploadBytes: data.maxUploadMb === undefined ? undefined : data.maxUploadMb * mb,
      accessVersion: revoke ? { increment: 1 } : undefined,
    }, include });
    if (revoke) await tx.accessToken.deleteMany({ where: { eventId: id } });
    return dto(updated, user);
  });
}
