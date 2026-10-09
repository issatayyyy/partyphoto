import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

export const metadata: Metadata = { title: "Восстановление доступа — PartyPhoto", robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return <main className="auth-page">
    <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /><Link className="header-link" href="/">На главную</Link><Link className="button button-outline" href="/login" prefetch={false}>Войти</Link></nav></header>
    <section className="auth-shell" aria-labelledby="auth-title">
      <div className="auth-intro"><h1 id="auth-title">Восстановление пароля</h1></div>
      <ForgotPasswordForm />
    </section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
