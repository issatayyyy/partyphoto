export function isDemoMode() {
  return process.env.PARTYPHOTO_DEMO_MODE === "true";
}

export function effectiveUploadBytes(eventMaxBytes: number) {
  const configured = Number(process.env.MAX_UPLOAD_BYTES ?? 26214400);
  if (!Number.isSafeInteger(configured) || configured < 1) throw new Error("Invalid MAX_UPLOAD_BYTES");
  if (!Number.isSafeInteger(eventMaxBytes) || eventMaxBytes < 1) throw new Error("Invalid event upload limit");
  return Math.min(configured, eventMaxBytes, isDemoMode() ? 3 * 1048576 : Number.MAX_SAFE_INTEGER);
}

export function imagePixelLimit() {
  return isDemoMode() ? 6000000 : 40000000;
}

export function uploadConcurrencyLimit() {
  return isDemoMode() ? 1 : 2;
}

export function passwordConcurrencyLimit() {
  return isDemoMode() ? 2 : 4;
}
