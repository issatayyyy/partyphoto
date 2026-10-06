import { authFailure, authResponse, readAuthJson } from "@/lib/auth-http";
import { consumeRateLimit } from "@/lib/auth-rate-limit";
import { staffPhotoAccess, moderatePhotos } from "@/lib/photos";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const data = await readAuthJson(request);
    const access = await staffPhotoAccess((await params).id);
    await consumeRateLimit(`media:moderate:${access.event.id}`, 120, 900);
    await moderatePhotos(data, access);
    return authResponse({ ok: true });
  } catch (error) { return authFailure(error); }
}
