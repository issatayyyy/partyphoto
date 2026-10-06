import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { insertSession, newSession, SESSION_COOKIE, setSessionCookie, userFields } from "@/lib/auth";
import { authFailure, authResponse, AuthError, readAuthJson } from "@/lib/auth-http";
import { limitAuthAttempt } from "@/lib/auth-rate-limit";
import { parseLogin } from "@/lib/auth-validation";
import { verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = parseLogin(await readAuthJson(request));
    await limitAuthAttempt("login", input.email);
    const credential = await db.user.findUnique({ where: { email: input.email }, select: { id: true, passwordHash: true, disabledAt: true } });
    const matches = await verifyPassword(input.password, credential && !credential.disabledAt ? credential.passwordHash : null);
    if (!credential || credential.disabledAt || !matches) throw new AuthError(401, "Неверный email или пароль.");
    const session = newSession();
    const previousToken = (await cookies()).get(SESSION_COOKIE)?.value;
    const user = await db.$transaction(async tx => {
      const user = await tx.user.findFirst({ where: { id: credential.id, disabledAt: null, passwordHash: credential.passwordHash }, select: userFields });
      if (!user) throw new AuthError(401, "Неверный email или пароль.");
      await insertSession(tx, user.id, session, previousToken);
      return user;
    });
    const response = authResponse({ user });
    setSessionCookie(response, session);
    return response;
  } catch (error) { return authFailure(error); }
}
