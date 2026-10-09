import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

export default function NotFound() {
  return <main className="auth-page">
    <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /></nav></header>
    <section className="hero"><p className="eyebrow">ОШИБКА 404</p><h1>Страница<br /><em>не найдена.</em></h1><p className="intro">Проверьте адрес или вернитесь на главную страницу.</p><Link className="button button-primary" href="/">На главную <span aria-hidden="true">↗</span></Link></section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
