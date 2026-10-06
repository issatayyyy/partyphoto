import { authFailure } from "@/lib/auth-http";
import { zipDownload } from "@/lib/zips";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return await zipDownload((await params).id); }
  catch (error) { return authFailure(error); }
}
