import Link from "next/link";

export const metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#F4F4EC",
        color: "#161914",
      }}
    >
      <section
        aria-labelledby="not-found-title"
        style={{
          width: "min(100%, 520px)",
          padding: 28,
          border: "3px solid #161914",
          borderRadius: 4,
          background: "#FBFBF5",
          boxShadow: "5px 5px 0 #C9D2C4",
          fontFamily:
            "var(--font-ibm-plex-mono), ui-monospace, 'SF Mono', Menlo, monospace",
        }}
      >
        <h1
          id="not-found-title"
          style={{
            margin: "0 0 10px",
            fontFamily:
              "var(--font-saira), 'Arial Narrow', system-ui, sans-serif",
            fontSize: 36,
          }}
        >
          TARGET NOT FOUND
        </h1>
        <p style={{ margin: "0 0 20px", lineHeight: 1.6 }}>
          That page does not exist. Return to the sight-in assistant.
        </p>
        <Link
          href="/"
          style={{
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 16px",
            border: "2px solid #161914",
            borderRadius: 3,
            background: "#C8F51F",
            color: "#161914",
            fontWeight: 600,
          }}
        >
          Back to Clickbait
        </Link>
      </section>
    </main>
  );
}
