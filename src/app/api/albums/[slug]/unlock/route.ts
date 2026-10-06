import { unlockAlbum } from "@/lib/albums";
import { authFailure, authResponse, readAuthJson } from "@/lib/auth-http";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const input = await readAuthJson(request);
    const response = authResponse({ ok: true });
    await unlockAlbum((await params).slug, input, response);
    return response;
  } catch (error) { return authFailure(error); }
}
