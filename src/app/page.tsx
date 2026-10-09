import { ThemeToggle } from "@/components/theme-toggle";
import { UiIcon } from "@/components/ui-icon";
import Link from "next/link";

export default function Home() {
  return <main className="home-page">
    <header>
      <Link className="brand" href="/">partyphoto<span>●</span></Link>
      <nav className="header-nav" aria-label="Навигация"><ThemeToggle />
        <Link className="header-link" href="/login">Войти</Link>
        <Link className="button button-outline" href="/register">Создать аккаунт</Link>
      </nav>
    </header>
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-camera" aria-hidden="true"><UiIcon name="camera" /><span>✦</span></div>
      <h1 id="home-title">Ваши фото.<br/><em>Ваши воспоминания.</em></h1>
      <p className="home-intro">Соберите моменты вашего события<br className="home-intro-break" /> в одном альбоме. И поделитесь ими.</p>
      <div className="home-actions">
        <Link className="button button-primary" href="/join"><UiIcon name="album" />Открыть альбом по коду</Link>
        <Link className="button button-outline" href="/dashboard"><UiIcon name="user" />Мои мероприятия</Link>
        <Link className="home-create" href="/register"><UiIcon name="plus" />Создать своё событие</Link>
      </div>
      <p className="home-caption">По ссылке или QR-коду. Вместе с гостями.</p>
    </section>
  </main>;
}
