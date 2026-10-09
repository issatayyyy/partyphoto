import { getCurrentUser } from "@/lib/auth";
import { AuthError, authFailure, authResponse, readAuthJson } from "@/lib/auth-http";
import { updateAdminUser } from "@/lib/admin";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    if (user.role !== "ADMIN") throw new AuthError(403, "Доступ разрешён только суперадминистратору.");
    const { id } = await context.params;
    return authResponse({ user: await updateAdminUser(id, await readAuthJson(request), user) });
  } catch (error) { return authFailure(error); }
}
