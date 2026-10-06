import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { tokenHash } from "./auth";
import { appOrigin } from "./auth-http";
import type { PhotoAccess } from "./photos";

export const VISITOR_COOKIE = "partyphoto_visitor";
export async function visitorToken() {
  const token = (await cookies()).get(VISITOR_COOKIE)?.value;
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function ensureVisitor(response: NextResponse) {
  if (!await visitorToken()) response.cookies.set(VISITOR_COOKIE, randomBytes(32).toString("hex"), {
    httpOnly: true, sameSite: "lax", path: "/", secure: appOrigin().startsWith("https:"), maxAge: 31536000,
  });
  return response;
}
export async function voterHash(access: PhotoAccess) {
  if (access.actor.kind === "staff") return tokenHash(`user:${access.actor.userId}`);
  const token = await visitorToken();
  return token ? tokenHash(`visitor:${token}`) : null;
}
