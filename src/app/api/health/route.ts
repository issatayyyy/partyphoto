export function GET() {
  // Liveness only. A separate readiness check will probe PostgreSQL and storage.
  return Response.json({ status: "ok", service: "partyphoto", stage: "media" });
}
