import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

export const metadata: Metadata = { title: "Восстановление доступа — PartyPhoto", robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return <main className="auth-page">
    <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><Link className="header-link" href="/">На главную</Link><Link className="button button-outline" href="/login" prefetch={false}>Войти</Link></nav></header>
    <section className="auth-shell" aria-labelledby="auth-title"><div className="auth-intro"><p className="eyebrow">ВОССТАНОВИТЕ ДОСТУП</p><h1 id="auth-title">Забыли пароль?<br /><em>Вернёмся к вашим событиям.</em></h1><p className="intro">Получите ссылку по email и выберите новый пароль для аккаунта PartyPhoto.</p><div className="auth-aside"><span aria-hidden="true">↗</span><p>Ваши мероприятия и фотографии останутся на месте.</p></div></div><ForgotPasswordForm /></section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
