import "@fontsource/saira-condensed/latin-600.css";
import "@fontsource/saira-condensed/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./globals.css";
import ServiceWorkerRegistrar from "./ServiceWorkerRegistrar";

const productionHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (productionHost ? `https://${productionHost}` : "http://localhost:3000");

export const metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Clickbait",
  title: {
    default: "Clickbait — Sight-In & Turret Assistant",
    template: "%s · Clickbait",
  },
  description:
    "MOA turret adjustment calculator for zeroing rifle and pistol optics.",
  manifest: "/manifest.webmanifest",
  category: "utilities",
  keywords: [
    "sight-in calculator",
    "MOA calculator",
    "turret adjustment",
    "optic zero",
  ],
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Clickbait",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Clickbait",
    title: "Clickbait — Sight-In & Turret Assistant",
    description:
      "Calculate precise MOA turret adjustments and keep a range-side sight-in log.",
    images: [
      {
        url: "/social-card.png",
        width: 1200,
        height: 630,
        alt: "Clickbait sight-in and turret assistant",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Clickbait — Sight-In & Turret Assistant",
    description:
      "Calculate precise MOA turret adjustments and keep a range-side sight-in log.",
    images: ["/social-card.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

/** @type {import("next").Viewport} */
export const viewport = {
  themeColor: "#F4F4EC",
  colorScheme: "light",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      style={{
        "--font-saira": '"Saira Condensed"',
        "--font-ibm-plex-mono": '"IBM Plex Mono"',
      }}
    >
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
