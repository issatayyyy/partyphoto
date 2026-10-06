export type EventDTO = {
  id: string;
  title: string;
  slug: string;
  code: string;
  description: string;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  allowGuestUploads: boolean;
  moderateUploads: boolean;
  allowDownloads: boolean;
  maxPhotos: number;
  maxStorageMb: number;
  maxUploadMb: number;
  usedStorageBytes: string;
  viewCount: string;
  downloadCount: string;
  photoCount: number;
  hasPassword: boolean;
  canManage: boolean;
  url: string;
};

export type GuestEventDTO = Pick<EventDTO, "id" | "title" | "slug" | "description" | "startsAt" | "expiresAt" | "allowGuestUploads" | "allowDownloads" | "maxUploadMb" | "photoCount">;
