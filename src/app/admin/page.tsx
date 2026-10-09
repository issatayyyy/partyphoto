import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/admin-panel";
import { LogoutButton } from "@/components/logout-button";
import { getAdminOverview, listAdminEvents, listAdminUsers } from "@/lib/admin";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Суперадмин — PartyPhoto",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/dashboard");

  const [overview, users, events] = await Promise.all([
    getAdminOverview(user),
    listAdminUsers(new URLSearchParams(), user),
    listAdminEvents(new URLSearchParams(), user),
  ]);

  return (
    <main className="dashboard-page admin-page">
      <header>
        <Link className="brand" href="/">partyphoto<span>●</span></Link>
        <nav className="header-nav" aria-label="Навигация"><ThemeToggle />
          <Link className="header-link" href="/dashboard">Личный кабинет</Link>
          <LogoutButton />
        </nav>
      </header>
      <section className="dashboard-heading admin-heading" aria-labelledby="admin-title">
        <Link className="back-link" href="/dashboard">← Личный кабинет</Link>
        <p className="eyebrow">СУПЕРАДМИН</p>
        <h1 id="admin-title">Управление PartyPhoto</h1>
        <p className="intro">Пользователи, мероприятия и состояние сервиса — в одном месте.</p>
      </section>
      <AdminPanel currentUserId={user.id} initialOverview={overview} initialUsers={users} initialEvents={events} />
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
