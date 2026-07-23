export default function manifest() {
  return {
    id: "/",
    name: "Clickbait — Sight-In & Turret Assistant",
    short_name: "Clickbait",
    description:
      "Calculate MOA turret adjustments and keep a range-side sight-in log.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F4F4EC",
    theme_color: "#F4F4EC",
    orientation: "any",
    categories: ["sports", "utilities"],
    prefer_related_applications: false,
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
