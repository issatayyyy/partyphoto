import { z } from "zod";
import { db } from "@/lib/db";
import { authFailure, authResponse, AuthError, readAuthJson } from "@/lib/auth-http";
import { consumeRateLimit } from "@/lib/auth-rate-limit";

export async function POST(request: Request) {
  try {
    const input = z.object({ code: z.string().trim().toUpperCase().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/) }).strict().safeParse(await readAuthJson(request));
    if (!input.success) throw new AuthError(400, "Введите код мероприятия из 8 символов.");
    await consumeRateLimit("album:resolve", 300, 60);
    const event = await db.event.findUnique({ where: { code: input.data.code }, select: { slug: true, deletedAt: true, expiresAt: true } });
    if (!event || event.deletedAt || (event.expiresAt && event.expiresAt <= new Date())) throw new AuthError(404, "Альбом с таким кодом недоступен.");
    return authResponse({ url: `/e/${event.slug}` });
  } catch (error) { return authFailure(error); }
}
