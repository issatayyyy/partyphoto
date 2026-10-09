import { authFailure, authResponse, readAuthJson } from "@/lib/auth-http";
import { recordAlbumView } from "@/lib/views";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try { return authResponse(await recordAlbumView((await params).slug, await readAuthJson(request))); }
  catch (error) { return authFailure(error); }
}
