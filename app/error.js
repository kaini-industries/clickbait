"use client";

import { useEffect, useRef } from "react";

const shellStyle = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "#F4F4EC",
  color: "#161914",
};

const cardStyle = {
  width: "min(100%, 560px)",
  padding: 28,
  border: "3px solid #161914",
  borderRadius: 4,
  background: "#FBFBF5",
  boxShadow: "5px 5px 0 #C9D2C4",
  fontFamily:
    "var(--font-ibm-plex-mono), ui-monospace, 'SF Mono', Menlo, monospace",
};

const buttonStyle = {
  minHeight: 44,
  padding: "9px 16px",
  border: "2px solid #161914",
  borderRadius: 3,
  background: "#C8F51F",
  color: "#161914",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

export default function ErrorPage({ error, unstable_retry }) {
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();

    if (process.env.NODE_ENV === "production") {
      console.error("Clickbait route render failed", {
        digest: error.digest ?? "client-error",
      });
    } else {
      console.error(error);
    }
  }, [error]);

  return (
    <main style={shellStyle}>
      <section role="alert" aria-labelledby="route-error-title" style={cardStyle}>
        <h1
          id="route-error-title"
          ref={headingRef}
          tabIndex={-1}
          style={{
            margin: "0 0 10px",
            fontFamily:
              "var(--font-saira), 'Arial Narrow', system-ui, sans-serif",
            fontSize: 34,
            letterSpacing: "0.04em",
          }}
        >
          SOMETHING WENT WRONG
        </h1>
        <p style={{ margin: "0 0 20px", lineHeight: 1.6 }}>
          Your saved data remains on this device. Try rendering the calculator
          again.
        </p>
        <button type="button" onClick={() => unstable_retry()} style={buttonStyle}>
          Try again
        </button>
        {error.digest ? (
          <p style={{ margin: "18px 0 0", fontSize: 12, color: "#4A5044" }}>
            Reference: {error.digest}
          </p>
        ) : null}
      </section>
    </main>
  );
}
