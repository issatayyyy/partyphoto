import { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { authFailure, authResponse, AuthError, readAuthJson } from "@/lib/auth-http";
import { consumeRateLimit } from "@/lib/auth-rate-limit";
import { getEventForUser, updateEvent } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    const event = await getEventForUser((await params).id, user);
    if (!event) throw new AuthError(404, "Мероприятие не найдено.");
    return authResponse({ event });
  } catch (error) { return authFailure(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    const input = await readAuthJson(request);
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    await consumeRateLimit(`event:update:${user.id}`, 120, 3600);
    return authResponse({ event: await updateEvent((await params).id, input, user) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return authFailure(new AuthError(409, "Этот адрес альбома уже занят."));
    return authFailure(error);
  }
}
