import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { clearSessionCookie, SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { assertAuthOrigin, authFailure, authResponse } from "@/lib/auth-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertAuthOrigin(request);
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
    }
    const response = authResponse({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) { return authFailure(error); }
}
