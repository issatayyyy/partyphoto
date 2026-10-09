import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import { AlbumAccess } from "@/components/album-access";
export const metadata = { title: "Открыть альбом — PartyPhoto" };
export default function JoinPage() {
  return <main className="auth-page"><header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /><Link className="header-link" href="/login">Я организатор</Link></nav></header>
    <section className="auth-shell" aria-labelledby="auth-title">
      <div className="auth-intro"><h1 id="auth-title">Найдите свой альбом</h1></div>
      <div className="auth-card">
        <div className="auth-card-heading"><h2>Открыть альбом</h2><p>Введите код от организатора или откройте ссылку из QR-кода.</p></div>
        <AlbumAccess />
      </div>
    </section>
    <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer></main>;
}
