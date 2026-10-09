"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UiIcon } from "./ui-icon";

export function SiteNavigation() {
  const pathname = usePathname();
  // An event link has its own guest navigation, scoped to that album.
  if (pathname.startsWith("/e/")) return null;
  const sections = [
    { href: "/", label: "Главная", icon: "home" as const, active: pathname === "/" },
    { href: "/join", label: "Альбом", icon: "album" as const, active: pathname === "/join" || pathname.startsWith("/e/") },
    { href: "/dashboard", label: "Кабинет", icon: "user" as const, active: pathname.startsWith("/dashboard") || pathname.startsWith("/admin") || ["/login", "/register", "/forgot-password", "/reset-password"].includes(pathname) },
  ];

  return <nav className="site-navigation" aria-label="Основные разделы">
    <div className="site-navigation-inner">
      {sections.map(section => <Link key={section.href} href={section.href} className={section.active ? "site-navigation-link is-active" : "site-navigation-link"} aria-current={section.active ? "location" : undefined}>
        <UiIcon name={section.icon} /><span>{section.label}</span>
      </Link>)}
    </div>
  </nav>;
}
