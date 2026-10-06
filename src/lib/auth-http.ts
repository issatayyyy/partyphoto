import "server-only";
import { NextResponse } from "next/server";

export class AuthError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export function authResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function authFailure(error: unknown) {
  if (error instanceof AuthError) {
    const response = authResponse({ error: error.message }, error.status);
    if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
  // Never log request payloads, database parameters, passwords or session tokens.
  console.error("Auth operation failed", error instanceof Error ? error.name : "UnknownError");
  return authResponse({ error: "Сервис временно недоступен. Попробуйте позже." }, 503);
}

export function appOrigin() {
  const value = process.env.APP_URL;
  if (!value) throw new Error("APP_URL must be configured");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid APP_URL");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Production APP_URL must use HTTPS");
  }
  return url.origin;
}

export function assertAuthOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin()) {
    throw new AuthError(403, "Откройте форму на адресе сайта и повторите попытку.");
  }
}

export async function readAuthJson(request: Request): Promise<unknown> {
  assertAuthOrigin(request);
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new AuthError(415, "Ожидается JSON-запрос.");
  const maxBytes = 8192;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AuthError(413, "Запрос слишком большой.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "Заполните форму.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AuthError(413, "Запрос слишком большой.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(400, "Некорректный запрос.");
  } finally {
    reader.releaseLock();
  }
}
