import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Личный кабинет — PartyPhoto" };

const roleLabels = {
  ADMIN: "Администратор",
  ORGANIZER: "Организатор",
  PHOTOGRAPHER: "Фотограф",
};

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

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
        <p className="intro">Вы вошли в PartyPhoto. Ваш аккаунт готов к работе.</p>
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
          <span className="next-step-number" aria-hidden="true">01</span>
          <h2>Скоро — ваши мероприятия</h2>
          <p>Следующим этапом здесь появятся создание событий, ссылки на альбомы и управление фотографиями.</p>
          <span className="next-step-label">Готовим следующий шаг</span>
        </article>
      </section>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
