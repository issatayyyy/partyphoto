import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import { AlbumAccess } from "@/components/album-access";
export const metadata = { title: "Открыть альбом — PartyPhoto" };
export default function JoinPage() {
  return <main className="auth-page"><header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /><Link className="header-link" href="/login">Я организатор</Link></nav></header>
    <section className="auth-shell"><div className="auth-intro"><p className="eyebrow">ВАШИ ВОСПОМИНАНИЯ РЯДОМ</p><h1>Найдите<br/><em>своё мероприятие.</em></h1><p className="intro">Введите код от организатора или откройте ссылку из QR-кода.</p></div><div className="auth-card"><h2>Открыть альбом</h2><AlbumAccess/></div></section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer></main>;
}
