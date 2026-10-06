import { getGuestAlbum } from "@/lib/albums";
import { authFailure, authResponse, AuthError } from "@/lib/auth-http";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const album = await getGuestAlbum((await params).slug);
    if (!album) throw new AuthError(404, "Альбом недоступен.");
    if (album.locked) throw new AuthError(401, "Введите пароль альбома.");
    return authResponse({ event: album.event });
  } catch (error) { return authFailure(error); }
}
