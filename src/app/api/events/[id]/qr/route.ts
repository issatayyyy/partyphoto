import QRCode from "qrcode";
import { getCurrentUser } from "@/lib/auth";
import { authFailure, AuthError } from "@/lib/auth-http";
import { getEventForUser } from "@/lib/events";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new AuthError(401, "Войдите в аккаунт.");
    const event = await getEventForUser((await params).id, user);
    if (!event) throw new AuthError(404, "Мероприятие не найдено.");
    const png = await QRCode.toBuffer(event.url, { type: "png", width: 512, margin: 4, errorCorrectionLevel: "M" });
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(png), { headers: {
      "Content-Type": "image/png", "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="partyphoto-${event.slug}.png"`,
    } });
  } catch (error) { return authFailure(error); }
}
