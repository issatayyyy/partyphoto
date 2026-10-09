import { ThemeToggle } from "@/components/theme-toggle";
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
        <nav className="header-nav" aria-label="Навигация"><ThemeToggle />
          {user.role === "ADMIN" && <Link className="header-link admin-nav-link" href="/admin">Суперадмин</Link>}
          <Link className="header-link" href="/">На главную</Link>
          <LogoutButton />
        </nav>
      </header>
      <section className="dashboard-heading dashboard-welcome" aria-labelledby="dashboard-title">
        <h1 id="dashboard-title">Добро пожаловать, {user.name}.</h1>
      </section>
      <section className="events-section" aria-labelledby="events-heading">
        <div className="events-section-heading">
          <h2 id="events-heading">{user.role === "ADMIN" ? "Мероприятия" : "Ваши мероприятия"} <span>{events.length}</span></h2>
          {canCreate && <Link className="button button-primary" href="/dashboard/events/new">Создать мероприятие <span aria-hidden="true">↗</span></Link>}
        </div>
        {events.length ? <div className="event-list">{events.map((event) => <article className="event-list-card" key={event.id}><div className="event-list-top"><span className="status-pill">{event.hasPassword ? "С паролем" : "По ссылке"}</span><span className="event-list-code">{event.code}</span></div><h3><Link href={`/dashboard/events/${event.id}`}>{event.title}</Link></h3>{event.description && <p className="event-list-description">{event.description}</p>}<div className="event-list-bottom"><span>{event.photoCount.toLocaleString("ru-RU")} фото{event.startsAt && <> · <EventDate value={event.startsAt}/></>}</span><Link className="event-list-open" href={`/dashboard/events/${event.id}`} aria-label={`Открыть мероприятие ${event.title}`}><span aria-hidden="true">↗</span></Link></div></article>)}</div> : <div className="events-empty"><h3>Пока ни одного мероприятия</h3><p>{canCreate ? "Создайте альбом и поделитесь ссылкой с гостями." : "Мероприятия появятся здесь, когда организатор предоставит вам доступ."}</p></div>}
      </section>
      <details className="account-card account-disclosure">
        <summary>Мой аккаунт</summary>
        <dl className="account-details">
          <div><dt>Имя</dt><dd>{user.name}</dd></div>
          <div><dt>Email</dt><dd>{user.email}</dd></div>
          <div><dt>Роль</dt><dd>{roleLabels[user.role]}</dd></div>
        </dl>
      </details>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
