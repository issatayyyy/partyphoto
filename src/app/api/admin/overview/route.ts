import { getCurrentUser } from "@/lib/auth";
import { AuthError, authFailure, authResponse } from "@/lib/auth-http";
import { getAdminOverview } from "@/lib/admin";

export const runtime = "nodejs";
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    return authResponse({ overview: await getAdminOverview(user) });
  } catch (error) { return authFailure(error); }
}
