import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EventForm } from "@/components/event-form";
import { LogoutButton } from "@/components/logout-button";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Новое мероприятие — PartyPhoto" };

export default async function NewEventPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "PHOTOGRAPHER") redirect("/dashboard");

  return (
    <main className="dashboard-page">
      <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /><Link className="header-link" href="/dashboard">Личный кабинет</Link><LogoutButton /></nav></header>
      <section className="event-page-heading" aria-labelledby="event-title"><Link className="back-link" href="/dashboard">← Все мероприятия</Link><p className="eyebrow">СОБЕРИТЕ МОМЕНТЫ ВМЕСТЕ</p><h1 id="event-title">Новое <em>мероприятие.</em></h1><p className="intro">Настройте альбом. Ссылку, код и QR-код мы создадим автоматически.</p></section>
      <div className="new-event-layout"><EventForm /><aside className="event-tip"><span aria-hidden="true">↗</span><h2>Начните с названия</h2><p>Остальные настройки можно изменить позже в личном кабинете.</p><p>Для приватного альбома добавьте пароль и передайте его гостям вместе со ссылкой.</p></aside></div>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
