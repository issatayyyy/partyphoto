import { authFailure } from "@/lib/auth-http";
import { readPhoto } from "@/lib/photos";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return await readPhoto((await params).id, "original"); }
  catch (error) { return authFailure(error); }
}
