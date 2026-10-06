import { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { insertSession, newSession, SESSION_COOKIE, setSessionCookie, userFields } from "@/lib/auth";
import { authFailure, authResponse, AuthError, readAuthJson } from "@/lib/auth-http";
import { limitAuthAttempt } from "@/lib/auth-rate-limit";
import { parseRegistration } from "@/lib/auth-validation";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = parseRegistration(await readAuthJson(request));
    await limitAuthAttempt("register", input.email);
    const passwordHash = await hashPassword(input.password);
    const session = newSession();
    const previousToken = (await cookies()).get(SESSION_COOKIE)?.value;
    const user = await db.$transaction(async tx => {
      const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash, role: "ORGANIZER" }, select: userFields });
      await insertSession(tx, user.id, session, previousToken);
      return user;
    });
    const response = authResponse({ user }, 201);
    setSessionCookie(response, session);
    return response;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return authFailure(new AuthError(409, "Не удалось создать аккаунт с этим email. Попробуйте войти."));
    }
    return authFailure(error);
  }
}
