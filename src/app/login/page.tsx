import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Вход — PartyPhoto" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <main className="auth-page">
      <header>
        <Link className="brand" href="/">partyphoto<span>●</span></Link>
        <nav className="header-nav" aria-label="Навигация"><ThemeToggle />
          <Link className="header-link" href="/">На главную</Link>
          <Link className="button button-outline" href="/register">Создать аккаунт</Link>
        </nav>
      </header>
      <section className="auth-shell" aria-labelledby="auth-title">
        <div className="auth-intro">
          <p className="eyebrow">ДЛЯ ТЕХ, КТО СОБИРАЕТ МОМЕНТЫ</p>
          <h1 id="auth-title">С возвращением.<br /><em>Всё начинается с вас.</em></h1>
          <p className="intro">Войдите в личный кабинет PartyPhoto, чтобы продолжить работу с сервисом.</p>
          <div className="auth-aside"><span aria-hidden="true">↗</span><p>Один аккаунт. Все ваши будущие события.</p></div>
        </div>
        <AuthForm mode="login" />
      </section>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
