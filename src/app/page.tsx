import Link from "next/link";

export default function Home() {
  return <main>
    <header>
      <Link className="brand" href="/">partyphoto<span>●</span></Link>
      <nav className="header-nav" aria-label="Навигация">
        <Link className="header-link" href="/login">Войти</Link>
        <Link className="button button-outline" href="/register">Создать аккаунт</Link>
      </nav>
    </header>
    <section className="hero">
      <p className="eyebrow">ОДНО СОБЫТИЕ. СОТНИ ВОСПОМИНАНИЙ.</p>
      <h1>Вечер закончится.<br/><em>Фотографии останутся.</em></h1>
      <p className="intro">Все снимки вашего мероприятия — в одном месте. Откройте альбом по ссылке или QR-коду от организатора.</p>
      <div className="hero-actions"><Link className="button button-primary" href="/register">Я организатор <span aria-hidden="true">↗</span></Link><Link className="text-link" href="/login">У меня уже есть аккаунт</Link></div>
      <div className="notice"><strong>Уже можно создать аккаунт</strong><p>Регистрация и личный кабинет готовы. Галереи мероприятий и загрузка фотографий появятся на следующем этапе.</p></div>
    </section>
    <section className="features" aria-label="Как это работает">
      {[['01', 'Откройте альбом', 'Получите ссылку или отсканируйте QR-код на мероприятии.'], ['02', 'Найдите свои моменты', 'Смотрите фотографии с телефона, делитесь впечатлениями.'], ['03', 'Сохраните воспоминания', 'Скачивайте любимые кадры в оригинальном качестве.']].map(([n, title, description]) => <article key={n}><span>{n}</span><h2>{title}</h2><p>{description}</p></article>)}
    </section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
