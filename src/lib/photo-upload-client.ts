import type { PhotoDTO } from "@/lib/photo-types";

export function photoFileError(file: File, maxUploadMb: number): string | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) && (file.type || !/\.(jpe?g|png|webp)$/i.test(file.name))) {
    return "Поддерживаются только JPEG, PNG и WebP.";
  }
  if (!file.size || file.size > maxUploadMb * 1024 * 1024) {
    return `Файл должен быть непустым и не больше ${maxUploadMb} МБ.`;
  }
  return null;
}

// Camera captures and file batches use the same authenticated server endpoint.
export async function uploadPhotoFile(endpoint: string, file: File, signal: AbortSignal): Promise<PhotoDTO> {
  const body = new FormData();
  const inferredType = /\.png$/i.test(file.name) ? "image/png" : /\.webp$/i.test(file.name) ? "image/webp" : "image/jpeg";
  body.append("file", file.type ? file : new File([file], file.name, { type: inferredType, lastModified: file.lastModified }));
  const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", body, signal });
  const result = await response.json().catch(() => null) as { photo?: PhotoDTO; error?: string } | null;
  if (!response.ok || !result?.photo) throw new Error(result?.error || "Не удалось загрузить фотографию. Попробуйте ещё раз.");
  return result.photo;
}
