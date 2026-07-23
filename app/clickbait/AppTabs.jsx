import { C, FONT_HEAD } from "./ui";

export default function AppTabs({ tab, profile, logCount, tabRefs, onSelect, onKeyDown }) {
  const tabs = [
    ["zero", "ZERO TARGET"],
    ["center", profile.type === "irons" ? "SIGHT SETUP" : "CENTER TURRETS"],
    ["log", `DOPE LOG${logCount ? ` (${logCount})` : ""}`],
  ];

  return (
    <div role="tablist" aria-label="Range tool sections" style={{ display: "flex", gap: 6, marginTop: 18, borderBottom: `2px solid ${C.ink}` }}>
      {tabs.map(([id, label]) => (
        <button
          key={id}
          ref={(element) => { tabRefs.current[id] = element; }}
          id={`tab-${id}`}
          type="button"
          role="tab"
          aria-selected={tab === id}
          aria-controls={`panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onSelect(id, label)}
          onKeyDown={(event) => onKeyDown(event, id)}
          style={{
            fontFamily: FONT_HEAD,
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: "0.08em",
            padding: "12px 10px",
            minHeight: 46,
            flex: 1,
            border: `2px solid ${C.ink}`,
            borderBottom: "none",
            borderRadius: "5px 5px 0 0",
            background: tab === id ? C.ink : C.card,
            color: tab === id ? C.paper : C.inkSoft,
            cursor: "pointer",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
