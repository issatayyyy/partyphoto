import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { appOrigin } from "./auth-http";

export const SESSION_COOKIE = "partyphoto_session";
export const userFields = { id: true, email: true, name: true, role: true } as const;
export type CurrentUser = Prisma.UserGetPayload<{ select: typeof userFields }>;
const sessionSeconds = 7 * 24 * 60 * 60;

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { expiresAt: true, user: { select: { ...userFields, disabledAt: true } } }
  });
  if (!session || session.expiresAt <= new Date() || session.user.disabledAt) return null;
  const { disabledAt: _disabledAt, ...user } = session.user;
  return user;
}

export function newSession() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + sessionSeconds * 1000) };
}

export async function insertSession(tx: Prisma.TransactionClient, userId: string, session: ReturnType<typeof newSession>, previousToken?: string) {
  // Replace this browser's old session; keep valid sessions on other devices.
  if (previousToken && /^[a-f0-9]{64}$/.test(previousToken)) {
    await tx.session.deleteMany({ where: { tokenHash: tokenHash(previousToken) } });
  }
  await tx.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
  await tx.session.create({ data: { userId, tokenHash: session.tokenHash, expiresAt: session.expiresAt } });
}

function cookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: appOrigin().startsWith("https:"), path: "/" };
}

export function setSessionCookie(response: NextResponse, session: ReturnType<typeof newSession>) {
  response.cookies.set(SESSION_COOKIE, session.token, { ...cookieOptions(), expires: session.expiresAt, maxAge: sessionSeconds });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), expires: new Date(0), maxAge: 0 });
}
