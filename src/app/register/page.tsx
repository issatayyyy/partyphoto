import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Создать аккаунт — PartyPhoto" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <main className="auth-page">
      <header>
        <Link className="brand" href="/">partyphoto<span>●</span></Link>
        <nav className="header-nav" aria-label="Навигация"><ThemeToggle />
          <Link className="header-link" href="/">На главную</Link>
          <Link className="button button-outline" href="/login">Войти</Link>
        </nav>
      </header>
      <section className="auth-shell" aria-labelledby="auth-title">
        <div className="auth-intro">
          <p className="eyebrow">ВАШИ СОБЫТИЯ. ВАШИ ВОСПОМИНАНИЯ.</p>
          <h1 id="auth-title">Хорошие моменты<br /><em>заслуживают места.</em></h1>
          <p className="intro">Создайте аккаунт организатора — первый шаг к общему фотоальбому вашего мероприятия.</p>
          <div className="auth-aside"><span aria-hidden="true">↗</span><p>Собирайте людей. Сохраняйте то, что вас объединяет.</p></div>
        </div>
        <AuthForm mode="register" />
      </section>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
