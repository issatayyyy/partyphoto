import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PartyPhoto — моменты вместе",
  description: "Фотографии вашего мероприятия в одном альбоме."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
