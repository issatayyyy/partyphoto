"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { EventDate } from "@/components/event-date";
import type { AdminEventsPage, AdminOverview, AdminUserDTO, AdminUsersPage } from "@/lib/admin-types";

type Role = AdminUserDTO["role"];
type UserPatch = { role?: Role; disabled?: boolean };
type Confirmation = { user: AdminUserDTO; patch: UserPatch; sourceId: string };
type Props = {
  currentUserId: string;
  initialOverview: AdminOverview;
  initialUsers: AdminUsersPage;
  initialEvents: AdminEventsPage;
};

const roleLabels: Record<Role, string> = { ADMIN: "Суперадмин", ORGANIZER: "Организатор", PHOTOGRAPHER: "Фотограф" };

function formatCount(value: number | string) {
  return typeof value === "number" ? value.toLocaleString("ru-RU") : BigInt(value).toLocaleString("ru-RU");
}

function formatBytes(value: string) {
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes.toLocaleString("ru-RU")} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  return `${(bytes / 1024 ** 3).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось загрузить данные. Попробуйте ещё раз.";
}

function queryUrl(endpoint: "users" | "events", page: number, query: string) {
  const params = new URLSearchParams({ page: String(page) });
  if (query) params.set("q", query);
  return `/api/admin/${endpoint}?${params}`;
}

function Pagination({ page, total, pageSize, disabled, label, onPage }: {
  page: number; total: number; pageSize: number; disabled: boolean; label: string; onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="admin-pagination" aria-label={label}>
    <p>Страница {page} из {pages} · всего {formatCount(total)}</p>
    <div><button className="button button-outline" type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>← Назад</button><button className="button button-outline" type="button" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Далее →</button></div>
  </nav>;
}

export function AdminPanel({ currentUserId, initialOverview, initialUsers, initialEvents }: Props) {
  const [overview, setOverview] = useState(initialOverview);
  const [users, setUsers] = useState(initialUsers);
  const [events, setEvents] = useState(initialEvents);
  const [usersQuery, setUsersQuery] = useState("");
  const [eventsQuery, setEventsQuery] = useState("");
  const [appliedUsersQuery, setAppliedUsersQuery] = useState("");
  const [appliedEventsQuery, setAppliedEventsQuery] = useState("");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role>>({});
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [usersBusy, setUsersBusy] = useState(false);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutationPending = useRef(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [usersError, setUsersError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const controlsBusy = mutating || usersBusy || eventsBusy || overviewBusy || accessDenied;

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) setAccessDenied(true);
      throw new Error(typeof result?.error === "string" ? result.error : "Не удалось загрузить данные. Попробуйте ещё раз.");
    }
    if (!result || typeof result !== "object") throw new Error("Не удалось загрузить данные. Попробуйте ещё раз.");
    return result as T;
  }

  async function refreshOverview() {
    if (controlsBusy) return;
    setOverviewBusy(true);
    setOverviewError("");
    try { setOverview((await request<{ overview: AdminOverview }>("/api/admin/overview")).overview); }
    catch (error) { setOverviewError(errorMessage(error)); }
    finally { setOverviewBusy(false); }
  }

  async function loadUsers(page: number, query = appliedUsersQuery) {
    if (usersBusy || mutating || accessDenied) return;
    setUsersBusy(true);
    setUsersError("");
    setConfirmation(null);
    setActionError("");
    try {
      setUsers(await request<AdminUsersPage>(queryUrl("users", page, query)));
      setAppliedUsersQuery(query);
      setRoleDrafts({});
    } catch (error) { setUsersError(errorMessage(error)); }
    finally { setUsersBusy(false); }
  }

  async function loadEvents(page: number, query = appliedEventsQuery) {
    if (eventsBusy || mutating || accessDenied) return;
    setEventsBusy(true);
    setEventsError("");
    try {
      setEvents(await request<AdminEventsPage>(queryUrl("events", page, query)));
      setAppliedEventsQuery(query);
    } catch (error) { setEventsError(errorMessage(error)); }
    finally { setEventsBusy(false); }
  }

  function openConfirmation(user: AdminUserDTO, patch: UserPatch, sourceId: string) {
    if (controlsBusy || user.id === currentUserId) return;
    setActionError("");
    setFeedback("");
    setConfirmation({ user, patch, sourceId });
  }

  function cancelConfirmation() {
    if (mutating) return;
    const sourceId = confirmation?.sourceId;
    setConfirmation(null);
    setActionError("");
    if (sourceId) requestAnimationFrame(() => document.getElementById(sourceId)?.focus());
  }

  async function saveUser() {
    if (!confirmation || mutationPending.current || accessDenied || confirmation.user.id === currentUserId) return;
    mutationPending.current = true;
    setMutating(true);
    setActionError("");
    const change = confirmation;
    try {
      const { user } = await request<{ user: AdminUserDTO }>(`/api/admin/users/${encodeURIComponent(change.user.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change.patch),
      });
      setUsers((current) => ({ ...current, users: current.users.map((item) => item.id === user.id ? user : item) }));
      setRoleDrafts((current) => ({ ...current, [user.id]: user.role }));
      setFeedback(change.patch.role ? `Роль пользователя ${user.name} (${user.email}) изменена на «${roleLabels[user.role]}».` : `Пользователь ${user.name} (${user.email}) ${user.disabledAt ? "заблокирован" : "разблокирован"}.`);
      setConfirmation(null);
      setOverviewError("");
      setUsersError("");
      setEventsError("");
      const [overviewResult, usersResult, eventsResult] = await Promise.allSettled([
        request<{ overview: AdminOverview }>("/api/admin/overview"),
        request<AdminUsersPage>(queryUrl("users", users.page, appliedUsersQuery)),
        request<AdminEventsPage>(queryUrl("events", events.page, appliedEventsQuery)),
      ]);
      if (overviewResult.status === "fulfilled") setOverview(overviewResult.value.overview);
      else setOverviewError(errorMessage(overviewResult.reason));
      if (usersResult.status === "fulfilled") { setUsers(usersResult.value); setRoleDrafts({}); }
      else setUsersError(errorMessage(usersResult.reason));
      if (eventsResult.status === "fulfilled") setEvents(eventsResult.value);
      else setEventsError(errorMessage(eventsResult.reason));
      requestAnimationFrame(() => document.getElementById(change.sourceId)?.focus());
    } catch (error) { setActionError(errorMessage(error)); }
    finally { mutationPending.current = false; setMutating(false); }
  }

  function submitUsers(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void loadUsers(1, usersQuery.trim()); }
  function submitEvents(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void loadEvents(1, eventsQuery.trim()); }

  return <div className="admin-panel">
    {accessDenied && <div className="form-error admin-access-error" role="alert"><p>Доступ к панели изменился или сеанс завершён. Войдите снова, чтобы проверить свои права.</p><Link className="text-link" href="/login" prefetch={false}>Перейти ко входу ↗</Link></div>}

    <section className="admin-section" aria-labelledby="admin-overview-title" aria-busy={overviewBusy || mutating}>
      <div className="admin-section-heading"><div><p className="eyebrow">СЕРВИС В ЦИФРАХ</p><h2 id="admin-overview-title">Общая статистика</h2></div><button className="button button-outline" type="button" disabled={controlsBusy} onClick={() => void refreshOverview()}>{overviewBusy ? "Обновляем…" : "Обновить статистику"}</button></div>
      {overviewError && <p className="form-error" role="alert">{overviewError}</p>}
      <dl className="admin-statistics">
        <div><dt>Пользователи</dt><dd>{formatCount(overview.usersCount)}</dd><small>Активных: {formatCount(overview.activeUsersCount)}</small></div>
        <div><dt>Мероприятия</dt><dd>{formatCount(overview.eventsCount)}</dd></div>
        <div><dt>Фотографии</dt><dd>{formatCount(overview.photosCount)}</dd></div>
        <div><dt>Занято места</dt><dd>{formatBytes(overview.usedStorageBytes)}</dd><small>Оригиналы и превью в медиахранилище, без временных ZIP.<br />Зарезервировано для загрузок: {formatBytes(overview.reservedStorageBytes)}</small></div>
        <div><dt>Просмотры альбомов</dt><dd>{formatCount(overview.viewCount)}</dd><small>Один браузер — один просмотр за 24 часа.</small></div>
        <div><dt>Скачивания</dt><dd>{formatCount(overview.downloadCount)}</dd></div>
      </dl>
      <div className="admin-service-status"><article><h3>Активные сеансы</h3><strong>{formatCount(overview.activeSessionsCount)}</strong><p>Сеансы входа, срок которых ещё не истёк.</p></article><article><h3>Обработка медиа</h3><dl><div><dt>В очереди</dt><dd>{formatCount(overview.mediaJobs.queued)}</dd></div><div><dt>В работе</dt><dd>{formatCount(overview.mediaJobs.running)}</dd></div><div><dt>С ошибкой</dt><dd>{formatCount(overview.mediaJobs.failed)}</dd></div></dl></article></div>
    </section>

    <section className="admin-section" aria-labelledby="admin-users-title" aria-busy={usersBusy || mutating}>
      <div className="admin-section-heading"><div><p className="eyebrow">ДОСТУП И РОЛИ</p><h2 id="admin-users-title">Пользователи <span>{formatCount(users.total)}</span></h2></div></div>
      <form className="admin-search" noValidate onSubmit={submitUsers}><div className="form-field"><label htmlFor="admin-users-search">Поиск пользователей</label><input id="admin-users-search" name="q" type="search" maxLength={100} value={usersQuery} onChange={(event) => setUsersQuery(event.target.value)} disabled={usersBusy || mutating || accessDenied} placeholder="Имя или email" /></div><button className="button button-primary" type="submit" disabled={usersBusy || mutating || accessDenied}>Найти пользователей</button>{appliedUsersQuery && <button className="button button-outline" type="button" disabled={usersBusy || mutating || accessDenied} onClick={() => { setUsersQuery(""); void loadUsers(1, ""); }}>Сбросить поиск</button>}</form>
      {usersBusy && <p className="admin-loading" role="status">Загружаем пользователей…</p>}
      {usersError && <p className="form-error" role="alert">{usersError}</p>}
      {feedback && <p className="form-success admin-feedback" role="status">{feedback}</p>}
      <div className="admin-user-list">{users.users.map((user) => {
        const self = user.id === currentUserId;
        const role = roleDrafts[user.id] ?? user.role;
        const confirming = confirmation?.user.id === user.id;
        const roleButtonId = `admin-user-${user.id}-role-save`;
        const accessButtonId = `admin-user-${user.id}-access`;
        return <article className="admin-user-card" key={user.id}>
          <div className="admin-user-heading"><div><h3>{user.name}</h3><p className="admin-user-email">{user.email}</p></div><div className="admin-user-badges"><span className={`status-pill${user.disabledAt ? " admin-status-blocked" : ""}`}>{user.disabledAt ? "Заблокирован" : "Активен"}</span>{self && <span className="admin-self-badge">Ваш аккаунт</span>}</div></div>
          <dl className="admin-user-details"><div><dt>Мероприятий</dt><dd>{formatCount(user.ownedEventCount)}</dd></div><div><dt>Регистрация</dt><dd><EventDate value={user.createdAt} /></dd></div></dl>
          <div className="admin-user-actions"><div className="form-field"><label htmlFor={`admin-role-${user.id}`}>Роль {user.email}</label><select id={`admin-role-${user.id}`} value={role} disabled={self || controlsBusy || Boolean(confirmation)} aria-describedby={self ? `admin-self-${user.id}` : undefined} onChange={(event) => setRoleDrafts((current) => ({ ...current, [user.id]: event.target.value as Role }))}><option value="ORGANIZER">Организатор</option><option value="PHOTOGRAPHER">Фотограф</option><option value="ADMIN">Суперадмин</option></select></div><button className="button button-outline" id={roleButtonId} type="button" disabled={self || controlsBusy || role === user.role || Boolean(confirmation)} onClick={() => openConfirmation(user, { role }, roleButtonId)}>Сохранить роль</button><button className={`button ${user.disabledAt ? "button-outline" : "button-danger"}`} id={accessButtonId} type="button" disabled={self || controlsBusy || Boolean(confirmation)} onClick={() => openConfirmation(user, { disabled: !user.disabledAt }, accessButtonId)}>{user.disabledAt ? "Разблокировать" : "Заблокировать"}</button></div>
          {self && <p className="field-help admin-self-help" id={`admin-self-${user.id}`}>Вы не можете изменить роль или заблокировать собственный аккаунт в этой панели.</p>}
          {user.disabledAt && <p className="field-help">Заблокирован <EventDate value={user.disabledAt} /></p>}
          {confirming && confirmation && <div className="admin-confirmation" role="region" aria-label="Подтверждение изменения" tabIndex={-1} ref={confirmationRef}><h4>{confirmation.patch.role ? "Изменить роль?" : confirmation.patch.disabled ? "Заблокировать пользователя?" : "Разблокировать пользователя?"}</h4><p><strong>{user.name}</strong> ({user.email})</p><p>{confirmation.patch.role ? <>Новая роль: <strong>{roleLabels[confirmation.patch.role]}</strong>. Все активные сеансы пользователя будут завершены.</> : confirmation.patch.disabled ? "Пользователь не сможет войти в аккаунт. Все его активные сеансы будут завершены." : "Пользователь снова сможет войти в аккаунт со своим паролем."}</p>{actionError && <p className="form-error" role="alert">{actionError}</p>}<div className="admin-confirmation-actions"><button className="button button-outline" type="button" disabled={mutating} onClick={cancelConfirmation}>Отмена</button><button className={`button ${confirmation.patch.disabled ? "button-danger" : "button-primary"}`} type="button" disabled={mutating || accessDenied} onClick={() => void saveUser()}>{mutating ? "Сохраняем…" : "Подтвердить изменение"}</button></div></div>}
        </article>;
      })}</div>
      {!users.users.length && <p className="admin-empty">Пользователи не найдены. Попробуйте другой запрос.</p>}
      <Pagination page={users.page} pageSize={users.pageSize} total={users.total} disabled={usersBusy || mutating || accessDenied || Boolean(confirmation)} label="Страницы пользователей" onPage={(page) => void loadUsers(page)} />
    </section>

    <section className="admin-section" aria-labelledby="admin-events-title" aria-busy={eventsBusy || mutating}>
      <div className="admin-section-heading"><div><p className="eyebrow">ОБЩИЙ СПИСОК АЛЬБОМОВ</p><h2 id="admin-events-title">Мероприятия <span>{formatCount(events.total)}</span></h2></div></div>
      <form className="admin-search" noValidate onSubmit={submitEvents}><div className="form-field"><label htmlFor="admin-events-search">Поиск мероприятий</label><input id="admin-events-search" name="q" type="search" maxLength={100} value={eventsQuery} onChange={(event) => setEventsQuery(event.target.value)} disabled={eventsBusy || mutating || accessDenied} placeholder="Название, адрес альбома или владелец" /></div><button className="button button-primary" type="submit" disabled={eventsBusy || mutating || accessDenied}>Найти мероприятия</button>{appliedEventsQuery && <button className="button button-outline" type="button" disabled={eventsBusy || mutating || accessDenied} onClick={() => { setEventsQuery(""); void loadEvents(1, ""); }}>Сбросить поиск</button>}</form>
      {eventsBusy && <p className="admin-loading" role="status">Загружаем мероприятия…</p>}
      {eventsError && <p className="form-error" role="alert">{eventsError}</p>}
      <div className="admin-event-list">{events.events.map((event) => <article className="admin-event-card" key={event.id}><div className="admin-event-heading"><div><h3><Link href={`/dashboard/events/${event.id}`}>{event.title}</Link></h3><p className="admin-event-slug">/e/{event.slug}</p></div><Link className="button button-outline" href={`/dashboard/events/${event.id}`} aria-label={`Открыть мероприятие ${event.title}`}>Открыть <span aria-hidden="true">↗</span></Link></div><p className="admin-event-owner">Владелец: <strong>{event.owner.name}</strong><span>{event.owner.email}</span></p><dl className="admin-event-statistics"><div><dt>Фотографии</dt><dd>{formatCount(event.photoCount)}</dd></div><div><dt>Хранилище</dt><dd>{formatBytes(event.usedStorageBytes)}</dd></div><div><dt>Просмотры</dt><dd>{formatCount(event.viewCount)}</dd></div><div><dt>Скачивания</dt><dd>{formatCount(event.downloadCount)}</dd></div></dl><p className="field-help">Создано <EventDate value={event.createdAt} />{event.expiresAt && <> · Доступ до <EventDate value={event.expiresAt} /></>}</p></article>)}</div>
      {!events.events.length && <p className="admin-empty">Мероприятия не найдены. Попробуйте другой запрос.</p>}
      <Pagination page={events.page} pageSize={events.pageSize} total={events.total} disabled={eventsBusy || mutating || accessDenied} label="Страницы мероприятий" onPage={(page) => void loadEvents(page)} />
    </section>
  </div>;
}
