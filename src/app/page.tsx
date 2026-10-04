export default function Home() {
  return <main>
    <header><a className="brand" href="/">partyphoto<span>●</span></a><span>Моменты, которые остаются</span></header>
    <section className="hero">
      <p className="eyebrow">ОДНО СОБЫТИЕ. СОТНИ ВОСПОМИНАНИЙ.</p>
      <h1>Вечер закончится.<br/><em>Фотографии останутся.</em></h1>
      <p className="intro">Все снимки вашего мероприятия — в одном месте. Откройте альбом по ссылке или QR-коду от организатора.</p>
      <div className="notice"><strong>PartyPhoto в разработке</strong><p>Это стартовая страница проекта. Подключение альбомов и вход для организаторов появятся на следующем этапе.</p></div>
    </section>
    <section className="features" aria-label="Как это работает">
      {[['01', 'Откройте альбом', 'Получите ссылку или отсканируйте QR-код на мероприятии.'], ['02', 'Найдите свои моменты', 'Смотрите фотографии с телефона, делитесь впечатлениями.'], ['03', 'Сохраните воспоминания', 'Скачивайте любимые кадры в оригинальном качестве.']].map(([n, title, description]) => <article key={n}><span>{n}</span><h2>{title}</h2><p>{description}</p></article>)}
    </section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
  </main>;
}
