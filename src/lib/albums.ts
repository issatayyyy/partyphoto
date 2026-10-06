import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "./db";
import { newSession, tokenHash } from "./auth";
import { AuthError, appOrigin } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { verifyPassword } from "./password";
import type { GuestEventDTO } from "./event-types";
import type { NextResponse } from "next/server";

const publishedCount = { _count: { select: { photos: { where: { status: "PUBLISHED" as const } } } } };
export function guestCookie(eventId: string) { return `partyphoto_event_${eventId}`; }

export async function getGuestAlbum(slug: string): Promise<{ title: string; slug: string; locked: boolean; event: GuestEventDTO | null } | null> {
  const event = await db.event.findUnique({ where: { slug }, include: publishedCount });
  if (!event || event.deletedAt || (event.expiresAt && event.expiresAt <= new Date())) return null;
  let allowed = event.passwordHash === null;
  if (!allowed) {
    const token = (await cookies()).get(guestCookie(event.id))?.value;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      allowed = (await db.accessToken.count({ where: {
        eventId: event.id, tokenHash: tokenHash(token), accessVersion: event.accessVersion, expiresAt: { gt: new Date() },
      } })) > 0;
    }
  }
  return { title: event.title, slug: event.slug, locked: !allowed, event: allowed ? {
    id: event.id, title: event.title, slug: event.slug, description: event.description,
    startsAt: event.startsAt?.toISOString() ?? null, expiresAt: event.expiresAt?.toISOString() ?? null,
    allowDownloads: event.allowDownloads, allowGuestUploads: event.allowGuestUploads, photoCount: event._count.photos,
    maxUploadMb: event.maxUploadBytes / 1048576,
  } : null };
}

export async function unlockAlbum(slug: string, input: unknown, response: NextResponse) {
  const parsed = z.object({ password: z.string().min(3).max(128) }).strict().safeParse(input);
  if (!parsed.success) throw new AuthError(400, "Пароль альбома должен содержать от 3 до 128 символов.");
  const event = await db.event.findUnique({ where: { slug } });
  if (!event || event.deletedAt || (event.expiresAt && event.expiresAt <= new Date())) throw new AuthError(404, "Альбом недоступен.");
  await consumeRateLimit("album:unlock:global", 120, 60);
  await consumeRateLimit(`album:unlock:${event.id}`, 30, 900);
  if (!event.passwordHash) return;
  if (!await verifyPassword(parsed.data.password, event.passwordHash)) throw new AuthError(401, "Неверный пароль альбома.");
  const session = newSession();
  // Guest grants are shorter than organizer sessions and capped by the album lifetime.
  session.expiresAt = new Date(Math.min(Date.now() + 86400000, event.expiresAt?.getTime() ?? Infinity));
  const previous = (await cookies()).get(guestCookie(event.id))?.value;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
    const latest = await tx.event.findUnique({ where: { id: event.id } });
    if (!latest || latest.deletedAt || (latest.expiresAt && latest.expiresAt <= new Date())) throw new AuthError(404, "Альбом недоступен.");
    if (latest.accessVersion !== event.accessVersion || latest.passwordHash !== event.passwordHash) throw new AuthError(409, "Настройки альбома изменились. Повторите вход.");
    if (previous && /^[a-f0-9]{64}$/.test(previous)) await tx.accessToken.deleteMany({ where: { eventId: event.id, tokenHash: tokenHash(previous) } });
    await tx.accessToken.deleteMany({ where: { eventId: event.id, expiresAt: { lte: new Date() } } });
    await tx.accessToken.create({ data: { eventId: event.id, tokenHash: session.tokenHash, accessVersion: latest.accessVersion, expiresAt: session.expiresAt } });
  });
  response.cookies.set(guestCookie(event.id), session.token, { httpOnly: true, sameSite: "lax", path: `/`, secure: appOrigin().startsWith("https:"), expires: session.expiresAt, maxAge: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) });
}
