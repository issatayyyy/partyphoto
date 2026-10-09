import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
export default function UnavailableAlbum() {
  return <main className="guest-album-page"><header><span className="brand">partyphoto<span>●</span></span><nav className="header-nav" aria-label="Навигация"><ThemeToggle /></nav></header><section className="guest-album-heading"><h1>Альбом недоступен</h1><p className="intro">Проверьте ссылку или уточните срок доступа у организатора.</p><Link className="button button-primary" href="/join">Ввести код мероприятия</Link></section></main>;
}
