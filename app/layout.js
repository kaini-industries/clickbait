import { Saira_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const saira = Saira_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-saira",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata = {
  title: "Clickbait — Sight-In & Turret Assistant",
  description:
    "MOA turret adjustment calculator for zeroing rifle and pistol optics.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${saira.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
