import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteNavigation } from "@/components/site-navigation";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";
export const metadata: Metadata = {
  title: "PartyPhoto — моменты вместе",
  description: "Фотографии вашего мероприятия в одном альбоме."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" data-theme="light" suppressHydrationWarning>
    <head><script id="partyphoto-theme-init" dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
    <body><ThemeProvider>{children}<SiteNavigation /></ThemeProvider></body>
  </html>;
}
