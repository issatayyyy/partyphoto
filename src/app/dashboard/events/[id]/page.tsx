import { ThemeToggle } from "@/components/theme-toggle";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EventDate } from "@/components/event-date";
import { EventForm } from "@/components/event-form";
import { EventShare } from "@/components/event-share";
import { LogoutButton } from "@/components/logout-button";
import { PhotoGallery } from "@/components/photo-gallery";
import { getCurrentUser } from "@/lib/auth";
import { getEventForUser } from "@/lib/events";
import { effectiveUploadBytes } from "@/lib/runtime-limits";

export const metadata: Metadata = { title: "Мероприятие — PartyPhoto" };

function formatBytes(bytes: string) {
  const value = Number(bytes);
  return value < 1024 * 1024 ? `${Math.round(value / 1024)} КБ` : `${(value / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const event = await getEventForUser(id, user);
  if (!event) notFound();

  return (
    <main className="dashboard-page">
      <header><Link className="brand" href="/">partyphoto<span>●</span></Link><nav className="header-nav" aria-label="Навигация"><ThemeToggle /><Link className="header-link" href="/dashboard">Личный кабинет</Link><LogoutButton /></nav></header>
      <section className="event-page-heading" aria-labelledby="event-title"><Link className="back-link" href="/dashboard">← Все мероприятия</Link><p className="eyebrow">{event.canManage ? "УПРАВЛЕНИЕ МЕРОПРИЯТИЕМ" : "ВАШЕ МЕРОПРИЯТИЕ"}</p><h1 id="event-title">{event.title}</h1><div className="event-heading-tags"><span className="status-pill">{event.hasPassword ? "С паролем" : "Доступ по ссылке"}</span>{event.expiresAt && <span className="event-expiry">До <EventDate value={event.expiresAt}/></span>}</div></section>
      <section className="event-statistics" aria-label="Статистика мероприятия"><div><span>Фотографии</span><strong>{event.photoCount.toLocaleString("ru-RU")}</strong><small>из {event.maxPhotos.toLocaleString("ru-RU")}</small></div><div><span>Просмотры</span><strong>{BigInt(event.viewCount).toLocaleString("ru-RU")}</strong><small>Один браузер — один просмотр за 24 часа.</small></div><div><span>Скачивания</span><strong>{BigInt(event.downloadCount).toLocaleString("ru-RU")}</strong></div><div><span>Занято места</span><strong>{formatBytes(event.usedStorageBytes)}</strong><small>из {event.maxStorageMb.toLocaleString("ru-RU")} МБ</small></div></section>
      <PhotoGallery eventId={event.id} maxUploadMb={effectiveUploadBytes(event.maxUploadMb * 1048576) / 1048576} />
      <div className="event-detail-layout"><div>{event.canManage ? <EventForm event={event} /> : <section className="event-readonly"><h2>О мероприятии</h2><p>{event.description || "Организатор пока не добавил описание."}</p><p className="field-help">Настройки этого альбома изменяет организатор.</p></section>}</div><EventShare event={event} /></div>
      <footer>PartyPhoto <span>Собираем моменты вместе.</span></footer>
    </main>
  );
}
