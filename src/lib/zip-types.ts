export type ZipDTO = {
  id: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  totalPhotos: number;
  processedPhotos: number;
  downloadUrl: string | null;
  error: string | null;
  expiresAt: string | null;
};
