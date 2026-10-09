import { getCurrentUser } from "@/lib/auth";
import { AuthError, authFailure, authResponse } from "@/lib/auth-http";
import { listAdminEvents } from "@/lib/admin";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    return authResponse(await listAdminEvents(new URL(request.url).searchParams, user));
  } catch (error) { return authFailure(error); }
}
