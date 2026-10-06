import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EventDate } from "@/components/event-date";
import { LogoutButton } from "@/components/logout-button";
import { getCurrentUser } from "@/lib/auth";
import { listEvents } from "@/lib/events";

export const metadata: Metadata = { title: "Личный кабинет — PartyPhoto" };

const roleLabels = {
  ADMIN: "Администратор",
  ORGANIZER: "Организатор",
  PHOTOGRAPHER: "Фотограф",
};

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const events = await listEvents(user);
  const canCreate = user.role !== "PHOTOGRAPHER";

  return (
    <main className="dashboard-page">
      <header>
        <Link className="brand" href="/">partyphoto<span>●</span></Link>
        <nav className="header-nav" aria-label="Навигация">
          <Link className="header-link" href="/">На главную</Link>
          <LogoutButton />
        </nav>
      </header>
      <section className="dashboard-heading" aria-labelledby="dashboard-title">
        <p className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</p>
        <h1 id="dashboard-title">Добро пожаловать,<br /><em>{user.name}.</em></h1>
        <p className="intro">Ваши мероприятия, гостевые ссылки и настройки альбомов — в одном месте.</p>
      </section>
      <section className="dashboard-grid" aria-label="Ваш аккаунт">
        <article className="account-card">
          <div className="card-title-row"><h2>Профиль</h2><span className="status-pill">Активен</span></div>
          <dl className="account-details">
            <div><dt>Имя</dt><dd>{user.name}</dd></div>
            <div><dt>Email</dt><dd>{user.email}</dd></div>
            <div><dt>Роль</dt><dd>{roleLabels[user.role]}</dd></div>
          </dl>
        </article>
        <article className="dashboard-next">
          <span className="next-step-number" aria-hidden="true">↗</span>
          <h2>{canCreate ? "Для больших и маленьких событий" : "Ваш взгляд на событие"}</h2>
          <p>{canCreate ? "Создайте мероприятие, настройте доступ и пригласите гостей в общий альбом по ссылке или QR-коду." : "Здесь отображаются мероприятия, к которым организатор предоставил вам доступ."}</p>
          {canCreate && <Link className="button button-primary" href="/dashboard/events/new">Создать мероприятие <span aria-hidden="true">↗</span></Link>}
        </article>
      </section>
      <section className="events-section" aria-labelledby="events-heading">
        <div className="events-section-heading"><div><p className="eyebrow">МЕСТО ДЛЯ ВОСПОМИНАНИЙ</p><h2 id="events-heading">{user.role === "ADMIN" ? "Мероприятия" : "Ваши мероприятия"} <span>{events.length}</span></h2></div></div>
        {events.length ? <div className="event-list">{events.map((event) => <article className="event-list-card" key={event.id}><div className="event-list-top"><span className="status-pill">{event.hasPassword ? "С паролем" : "По ссылке"}</span><span className="event-list-code">{event.code}</span></div><h3><Link href={`/dashboard/events/${event.id}`}>{event.title}</Link></h3><p className="event-list-description">{event.description || "Все фотографии мероприятия в одном альбоме."}</p><div className="event-list-bottom"><span>{event.photoCount.toLocaleString("ru-RU")} фото{event.startsAt && <> · <EventDate value={event.startsAt}/></>}</span><Link className="event-list-open" href={`/dashboard/events/${event.id}`} aria-label={`Открыть мероприятие ${event.title}`}><span aria-hidden="true">↗</span></Link></div></article>)}</div> : <div className="events-empty"><span aria-hidden="true">○</span><h3>Пока ни одного мероприятия</h3><p>{canCreate ? "Создайте первый альбом — и у ваших гостей будет одно место для воспоминаний." : "Ваши мероприятия появятся здесь, когда организатор предоставит вам доступ."}</p>{canCreate && <Link className="text-link" href="/dashboard/events/new">Создать первое мероприятие ↗</Link>}</div>}
      </section>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
