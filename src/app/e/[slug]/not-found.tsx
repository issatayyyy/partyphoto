import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
export default function UnavailableAlbum() {
  return <main><header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /></nav></header><section className="hero"><p className="eyebrow">PARTYPHOTO</p><h1>Альбом недоступен</h1><p className="intro">Проверьте ссылку или уточните срок доступа у организатора.</p><Link className="button button-primary" href="/join">Ввести код мероприятия</Link></section></main>;
}
