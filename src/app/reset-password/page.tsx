import type { Metadata } from "next";
import Link from "next/link";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = { title: "Смена пароля — PartyPhoto", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function ResetPasswordPage() {
  return <main className="auth-page">
    <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><Link className="header-link" href="/">На главную</Link><Link className="button button-outline" href="/login" prefetch={false}>Войти</Link></nav></header>
    <section className="auth-shell" aria-labelledby="auth-title"><div className="auth-intro"><p className="eyebrow">ВОССТАНОВИТЕ ДОСТУП</p><h1 id="auth-title">Снова<br /><em>в вашем аккаунте.</em></h1><p className="intro">Установите новый пароль и продолжайте собирать моменты вместе с PartyPhoto.</p><div className="auth-aside"><span aria-hidden="true">↗</span><p>Ваши мероприятия и права доступа сохранятся.</p></div></div><PasswordResetForm /></section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
