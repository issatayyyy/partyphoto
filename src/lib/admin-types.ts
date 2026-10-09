export type AdminUserDTO = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "ORGANIZER" | "PHOTOGRAPHER";
  disabledAt: string | null;
  createdAt: string;
  ownedEventCount: number;
};

export type AdminUsersPage = {
  users: AdminUserDTO[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminEventDTO = {
  id: string;
  title: string;
  slug: string;
  owner: { id: string; name: string; email: string };
  photoCount: number;
  usedStorageBytes: string;
  viewCount: string;
  downloadCount: string;
  createdAt: string;
  expiresAt: string | null;
};

export type AdminEventsPage = {
  events: AdminEventDTO[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminOverview = {
  usersCount: number;
  activeUsersCount: number;
  eventsCount: number;
  photosCount: number;
  activeSessionsCount: number;
  usedStorageBytes: string;
  reservedStorageBytes: string;
  viewCount: string;
  downloadCount: string;
  mediaJobs: { queued: number; running: number; failed: number };
};
