export function GET() {
  // Liveness only. /api/health/ready probes PostgreSQL and storage.
  return Response.json({ status: "ok", service: "partyphoto", stage: "sharing" });
}
