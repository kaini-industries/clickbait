import { forwardRef } from "react";

export const C = {
  paper: "#F4F4EC",
  grid: "#C9D2C4",
  gridStrong: "#687164",
  ink: "#161914",
  inkSoft: "#4A5044",
  face: "#131311",
  faceRing: "#777E73",
  splat: "#C8F51F",
  red: "#C3271B",
  orange: "#FF7A00",
  white: "#FFFFFF",
  card: "#FBFBF5",
};

export const FONT_HEAD = "var(--font-saira), 'Arial Narrow', system-ui, sans-serif";
export const FONT_MONO = "var(--font-ibm-plex-mono), ui-monospace, 'SF Mono', Menlo, monospace";

export const fmt = (n, precision = 1) => {
  const value = Number(n.toFixed(precision));
  return Object.is(value, -0) ? "0" : String(value);
};

const QUARTERS = ["", "¼", "½", "¾"];

export function fmtUnits(units, spec) {
  if (spec.unit === "turn") {
    const quarterTurns = Math.round(units * 4);
    const whole = Math.floor(quarterTurns / 4);
    const fraction = QUARTERS[quarterTurns % 4];
    const number = whole ? `${whole}${fraction}` : fraction || "0";
    return `${number} ${units > 1 ? "turns" : "turn"}`;
  }
  if (spec.unit === "mm") return `${fmt(units, 1)} mm`;
  return `${units} ${units === 1 ? "click" : "clicks"}`;
}

export function Chip({ active, onClick, children, title, disabled = false, ...props }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={typeof active === "boolean" ? active : undefined}
      {...props}
      style={{
        fontFamily: FONT_MONO,
        fontSize: 13,
        fontWeight: 600,
        padding: "10px 12px",
        minHeight: 44,
        border: `2px solid ${C.ink}`,
        background: active ? C.ink : C.card,
        color: active ? C.paper : C.ink,
        borderRadius: 3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        ...props.style,
      }}
    >
      {children}
    </button>
  );
}

export const Label = forwardRef(function Label(
  { children, as: Tag = "h2", id, style, ...props },
  ref
) {
  return (
    <Tag
      id={id}
      ref={ref}
      {...props}
      style={{
        fontFamily: FONT_HEAD,
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.inkSoft,
        margin: "14px 0 6px",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
});

export function Card({ children, style, ...props }) {
  return (
    <div
      {...props}
      style={{
        background: C.card,
        border: `2px solid ${C.ink}`,
        borderRadius: 4,
        boxShadow: `3px 3px 0 ${C.grid}`,
        padding: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function RotGlyph({ ccw, size = 30, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ flexShrink: 0, transform: ccw ? "scaleX(-1)" : undefined, ...style }}
    >
      <path
        d="M 23.8 7.3 A 11 11 0 1 0 27 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M 19.6 2.6 L 25.4 8.6 L 17.8 10.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
