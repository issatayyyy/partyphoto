import { authFailure, authResponse, readAuthJson } from "@/lib/auth-http";
import { resetPassword } from "@/lib/password-reset";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { return authResponse(await resetPassword(await readAuthJson(request))); }
  catch (error) { return authFailure(error); }
}
