import "server-only";
import { cookies } from "next/headers";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { SESSION_COOKIE, tokenHash, type CurrentUser } from "./auth";
import { AuthError } from "./auth-http";
import type { AdminEventsPage, AdminOverview, AdminUserDTO, AdminUsersPage } from "./admin-types";

const userSelect = {
  id: true, email: true, name: true, role: true, disabledAt: true, createdAt: true,
  _count: { select: { ownedEvents: { where: { deletedAt: null } } } },
} as const;
type UserRecord = Prisma.UserGetPayload<{ select: typeof userSelect }>;
const pageSize = 20;

function userDTO(user: UserRecord): AdminUserDTO {
  return {
    id: user.id, email: user.email, name: user.name, role: user.role,
    disabledAt: user.disabledAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(), ownedEventCount: user._count.ownedEvents,
  };
}

async function assertAdmin(user: CurrentUser) {
  if (user.role !== "ADMIN" || !await db.user.count({ where: { id: user.id, role: "ADMIN", disabledAt: null } })) {
    throw new AuthError(403, "Доступ разрешён только суперадминистратору.");
  }
}

function listQuery(query: URLSearchParams) {
  for (const key of query.keys()) {
    if (!["page", "q"].includes(key) || query.getAll(key).length !== 1) throw new AuthError(400, "Некорректные параметры списка.");
  }
  const rawPage = query.get("page") ?? "1";
  const q = (query.get("q") ?? "").trim();
  if (!/^[1-9]\d{0,4}$/.test(rawPage) || q.length > 100) throw new AuthError(400, "Некорректные параметры списка.");
  return { page: Number(rawPage), q };
}

export async function getAdminOverview(user: CurrentUser): Promise<AdminOverview> {
  await assertAdmin(user);
  const [usersCount, activeUsersCount, eventsCount, photosCount, activeSessionsCount, counters, queued, running, failed] = await db.$transaction([
    db.user.count(),
    db.user.count({ where: { disabledAt: null } }),
    db.event.count({ where: { deletedAt: null } }),
    db.photo.count({ where: { event: { deletedAt: null } } }),
    db.session.count({ where: { expiresAt: { gt: new Date() }, user: { disabledAt: null } } }),
    db.event.aggregate({ where: { deletedAt: null }, _sum: {
      usedStorageBytes: true, reservedBytes: true, viewCount: true, downloadCount: true,
    } }),
    db.mediaJob.count({ where: { status: "QUEUED" } }),
    db.mediaJob.count({ where: { status: "RUNNING" } }),
    db.mediaJob.count({ where: { status: "FAILED" } }),
  ]);
  return {
    usersCount, activeUsersCount, eventsCount, photosCount, activeSessionsCount,
    usedStorageBytes: (counters._sum.usedStorageBytes ?? 0n).toString(),
    reservedStorageBytes: (counters._sum.reservedBytes ?? 0n).toString(),
    viewCount: (counters._sum.viewCount ?? 0n).toString(),
    downloadCount: (counters._sum.downloadCount ?? 0n).toString(),
    mediaJobs: { queued, running, failed },
  };
}

export async function listAdminUsers(query: URLSearchParams, user: CurrentUser): Promise<AdminUsersPage> {
  await assertAdmin(user);
  const { page, q } = listQuery(query);
  const where: Prisma.UserWhereInput = q ? { OR: [
    { email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } },
  ] } : {};
  const [users, total] = await db.$transaction([
    db.user.findMany({ where, select: userSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db.user.count({ where }),
  ]);
  return { users: users.map(userDTO), total, page, pageSize };
}

export async function listAdminEvents(query: URLSearchParams, user: CurrentUser): Promise<AdminEventsPage> {
  await assertAdmin(user);
  const { page, q } = listQuery(query);
  const where: Prisma.EventWhereInput = { deletedAt: null, ...(q ? { OR: [
    { title: { contains: q, mode: "insensitive" as const } }, { slug: { contains: q, mode: "insensitive" as const } },
    { owner: { email: { contains: q, mode: "insensitive" as const } } },
    { owner: { name: { contains: q, mode: "insensitive" as const } } },
  ] } : {}) };
  const [events, total] = await db.$transaction([
    db.event.findMany({ where, select: {
      id: true, title: true, slug: true, createdAt: true, expiresAt: true,
      usedStorageBytes: true, viewCount: true, downloadCount: true,
      owner: { select: { id: true, name: true, email: true } }, _count: { select: { photos: true } },
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db.event.count({ where }),
  ]);
  return { events: events.map(event => ({
    id: event.id, title: event.title, slug: event.slug, owner: event.owner,
    createdAt: event.createdAt.toISOString(), expiresAt: event.expiresAt?.toISOString() ?? null,
    usedStorageBytes: event.usedStorageBytes.toString(), viewCount: event.viewCount.toString(),
    downloadCount: event.downloadCount.toString(), photoCount: event._count.photos,
  })), total, page, pageSize };
}

const updateSchema = z.object({
  role: z.enum(["ADMIN", "ORGANIZER", "PHOTOGRAPHER"]).optional(),
  disabled: z.boolean().optional(),
}).strict().refine(input => Object.keys(input).length > 0);

export async function updateAdminUser(id: string, input: unknown, actor: CurrentUser) {
  if (actor.role !== "ADMIN") throw new AuthError(403, "Доступ разрешён только суперадминистратору.");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new AuthError(400, "Укажите корректную роль или состояние аккаунта.");
  if (id === actor.id) throw new AuthError(400, "Свою роль и доступ нельзя изменить из этой панели.");
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken)) throw new AuthError(401, "Войдите в аккаунт.");
  return db.$transaction(async tx => {
    // Serialize changes to the administrator set; bootstrap uses the same lock.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(726873, 1)`;
    // Coordinate revocation with login/reset. Stable order also prevents admin
    // actions on different users from acquiring user locks in opposite order.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${actor.id}, ${id}) ORDER BY "id" FOR UPDATE`;
    const currentActor = await tx.user.findFirst({ where: { id: actor.id, role: "ADMIN", disabledAt: null }, select: { id: true } });
    if (!currentActor) throw new AuthError(403, "Доступ разрешён только суперадминистратору.");
    const activeSession = await tx.session.findFirst({ where: {
      userId: actor.id, tokenHash: tokenHash(sessionToken), expiresAt: { gt: new Date() },
    }, select: { id: true } });
    if (!activeSession) throw new AuthError(401, "Сессия завершена. Войдите заново.");
    const target = await tx.user.findUnique({ where: { id }, select: userSelect });
    if (!target) throw new AuthError(404, "Пользователь не найден.");
    const role = parsed.data.role ?? target.role;
    const disabled = parsed.data.disabled ?? Boolean(target.disabledAt);
    if (target.role === "ADMIN" && !target.disabledAt && (role !== "ADMIN" || disabled)) {
      const admins = await tx.user.count({ where: { role: "ADMIN", disabledAt: null } });
      if (admins <= 1) throw new AuthError(409, "Нельзя отключить последнего суперадминистратора.");
    }
    if (role === target.role && disabled === Boolean(target.disabledAt)) return userDTO(target);
    const updated = await tx.user.update({ where: { id }, data: {
      role, disabledAt: disabled ? target.disabledAt ?? new Date() : null,
    }, select: userSelect });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.passwordResetToken.deleteMany({ where: { userId: id } });
    return userDTO(updated);
  });
}
