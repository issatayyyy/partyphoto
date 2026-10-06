import Link from "next/link";
export default function UnavailableAlbum() {
  return <main><section className="hero"><p className="eyebrow">PARTYPHOTO</p><h1>Альбом недоступен</h1><p className="intro">Проверьте ссылку или уточните срок доступа у организатора.</p><Link className="button button-primary" href="/join">Ввести код мероприятия</Link></section></main>;
}
