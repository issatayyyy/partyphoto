import { authFailure, authResponse, assertAuthOrigin } from "@/lib/auth-http";
import { staffPhotoAccess, listPhotos, uploadPhoto } from "@/lib/photos";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return authResponse(await listPhotos(await staffPhotoAccess((await params).id), new URL(request.url).searchParams.get("cursor") ?? undefined)); }
  catch (error) { return authFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { assertAuthOrigin(request); return authResponse({ photo: await uploadPhoto(request, await staffPhotoAccess((await params).id)) }, 201); }
  catch (error) { return authFailure(error); }
}
