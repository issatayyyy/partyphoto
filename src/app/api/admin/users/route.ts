import { getCurrentUser } from "@/lib/auth";
import { AuthError, authFailure, authResponse } from "@/lib/auth-http";
import { listAdminUsers } from "@/lib/admin";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    return authResponse(await listAdminUsers(new URL(request.url).searchParams, user));
  } catch (error) { return authFailure(error); }
}
