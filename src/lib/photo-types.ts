export type PhotoDTO = {
  id: string;
  filename: string;
  width: number;
  height: number;
  status: "UPLOADING" | "PROCESSING" | "PENDING" | "PUBLISHED" | "HIDDEN" | "FAILED" | "DELETING";
  sizeBytes: string;
  createdAt: string;
  thumbnailUrl: string;
  downloadUrl: string | null;
};
