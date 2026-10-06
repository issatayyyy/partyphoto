import { getCurrentUser } from "@/lib/auth";
import { authFailure, authResponse } from "@/lib/auth-http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return user ? authResponse({ user }) : authResponse({ error: "Войдите в аккаунт." }, 401);
  } catch (error) { return authFailure(error); }
}
