import { authFailure, authResponse, readAuthJson } from "@/lib/auth-http";
import { setPhotoLike } from "@/lib/likes";
export const runtime = "nodejs";
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return authResponse(await setPhotoLike((await params).id, await readAuthJson(request))); }
  catch (error) { return authFailure(error); }
}
