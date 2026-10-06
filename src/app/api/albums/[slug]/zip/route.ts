import { z } from "zod";
import { authFailure, authResponse, AuthError, readAuthJson } from "@/lib/auth-http";
import { guestPhotoAccess } from "@/lib/photos";
import { getZip, queueZip } from "@/lib/zips";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try { return authResponse({ job: await getZip(await guestPhotoAccess((await params).slug)) }); }
  catch (error) { return authFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    if (!z.object({}).strict().safeParse(await readAuthJson(request)).success) throw new AuthError(400, "Некорректный запрос архива.");
    const job = await queueZip(await guestPhotoAccess((await params).slug));
    return authResponse({ job }, job.status === "DONE" ? 200 : 202);
  } catch (error) { return authFailure(error); }
}
