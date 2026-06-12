"use client";

import React, { useState, useEffect, useMemo, useRef, memo, useCallback } from "react";

/* ============================================================
   CLICKBAIT — sight-in & turret assistant
   Design: range data-book on graph paper. Signature element:
   the interactive Shoot-N-C-style splatter target.
   Palette: paper #F4F4EC · grid #C9D2C4 · ink #161914
            splatter #C8F51F · stamp red #C3271B · black face #131311
   ============================================================ */

const C = {
  paper: "#F4F4EC",
  grid: "#C9D2C4",
  ink: "#161914",
  inkSoft: "#4A5044",
  face: "#131311",
  faceRing: "#2C2C28",
  splat: "#C8F51F",
  red: "#C3271B",
  orange: "#FF7A00",
  white: "#FFFFFF",
  card: "#FBFBF5",
};

const FONT_HEAD = "var(--font-saira), 'Arial Narrow', system-ui, sans-serif";
const FONT_MONO = "var(--font-ibm-plex-mono), ui-monospace, 'SF Mono', Menlo, monospace";

const PRESET_PROFILES = [
  {
    id: "hs507c",
    name: "Holosun HS507C-X2",
    short: "HS507C-X2",
    clickMOA: 1.0,
    travelMOA: 100, // ±50 MOA from center
    rot: { UP: "counter-clockwise", DOWN: "clockwise", RIGHT: "counter-clockwise", LEFT: "clockwise" },
    builtin: true,
  },
  {
    id: "pa3x32",
    name: "Primary Arms SLx 3x32 Gen III",
    short: "SLx 3×32",
    clickMOA: 0.25,
    travelMOA: 60,
    rot: null, // direction arrows are marked on the turrets
    builtin: true,
  },
  {
    id: "ak47irons",
    name: "AK-47 / AKM iron sights",
    short: "AK irons",
    type: "irons", // absent on all turret profiles
    elev: { moaPerUnit: 6.9, step: 0.25, unit: "turn", maxUnits: 2 }, // ~20 cm @ 100 m per post turn; ±2 usable turns
    wind: { moaPerUnit: 9.1, step: 0.1, unit: "mm", maxUnits: 3 }, // ~26 cm @ 100 m per mm of drift; ±3 mm dovetail
    builtin: true,
  },
];

/* rotation helpers — `rot` is a sparse map: a missing direction key
   means "follow the arrow marked on the turret" for that axis */
const CW = "clockwise", CCW = "counter-clockwise";
const OPP_DIR = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
const oppRot = (r) => (r === CW ? CCW : CW);
const turnFor = (rot, dir) =>
  rot?.[dir] ?? (rot?.[OPP_DIR[dir]] ? oppRot(rot[OPP_DIR[dir]]) : null);
const rotToSel = (rot, anchor) =>
  !rot?.[anchor] && !rot?.[OPP_DIR[anchor]] ? "marked"
  : turnFor(rot, anchor) === CW ? "cw" : "ccw";
const buildRot = (elevSel, windSel) => {
  const m = {};
  if (elevSel !== "marked") { m.UP = elevSel === "cw" ? CW : CCW; m.DOWN = oppRot(m.UP); }
  if (windSel !== "marked") { m.RIGHT = windSel === "cw" ? CW : CCW; m.LEFT = oppRot(m.RIGHT); }
  return Object.keys(m).length ? m : null;
};

/* per-axis adjustment specs — a turret optic is the degenerate case where
   both axes share one spec (1-click steps, half of travel each way) */
const axisSpecs = (p) => {
  if (p.type === "irons") return { elev: p.elev, wind: p.wind };
  const s = { moaPerUnit: p.clickMOA, step: 1, unit: "click", maxUnits: p.travelMOA / p.clickMOA / 2 };
  return { elev: s, wind: s };
};

/* front-sight zeroing is INVERTED: move the post/drum opposite the desired impact shift */
const IRONS_ACTIONS = {
  UP: { main: "SCREW FRONT POST DOWN (clockwise from above)", note: "lowering the post raises impact" },
  DOWN: { main: "SCREW FRONT POST UP (counter-clockwise from above)", note: "raising the post lowers impact" },
  RIGHT: { main: "DRIFT FRONT SIGHT DRUM LEFT", note: "moving the drum left moves impact right" },
  LEFT: { main: "DRIFT FRONT SIGHT DRUM RIGHT", note: "moving the drum right moves impact left" },
};

const UNITS = {
  imp: {
    lin: "in", dist: "yd",
    perMOA: (d) => (1.047 * d) / 100,
    distances: [10, 15, 25, 36, 50, 100],
    spans: [6, 12, 24],
    gridStep: { 6: 1, 12: 1, 24: 2 },
  },
  met: {
    lin: "cm", dist: "m",
    perMOA: (d) => (2.908 * d) / 100,
    distances: [10, 25, 50, 100],
    spans: [15, 30, 60],
    gridStep: { 15: 1, 30: 2, 60: 5 },
  },
};

const fmt = (n, p = 1) => {
  const v = Number(n.toFixed(p));
  return Object.is(v, -0) ? "0" : String(v);
};

const QUARTERS = ["", "¼", "½", "¾"];
function fmtUnits(units, spec) {
  if (spec.unit === "turn") {
    const q = Math.round(units * 4); // integer quarter-turns
    const whole = Math.floor(q / 4), frac = QUARTERS[q % 4];
    const num = whole ? `${whole}${frac}` : frac || "0";
    return `${num} ${units > 1 ? "turns" : "turn"}`; // "½ turn", "1¼ turns"
  }
  if (spec.unit === "mm") return `${fmt(units, 1)} mm`;
  return `${units} ${units === 1 ? "click" : "clicks"}`;
}

/* ---------- small building blocks ---------- */

function Chip({ active, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
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
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: FONT_HEAD,
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.inkSoft,
        margin: "14px 0 6px",
      }}
    >
      {children}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div
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

/* circular-arrow glyph; drawn clockwise, mirrored for counter-clockwise */
function RotGlyph({ ccw, size = 30, style }) {
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

/* ---------- the splatter target ---------- */

const TARGET_SVG_STYLE = {
  width: "100%",
  display: "block",
  touchAction: "manipulation",
  cursor: "crosshair",
  background: C.paper,
  border: `2px solid ${C.ink}`,
  borderRadius: 4,
  boxShadow: `3px 3px 0 ${C.grid}`,
  marginTop: 12,
};

const Target = memo(function Target({ span, gridStep, lin, shots, ghosts = [], center, predicted, onTap }) {
  const S = 340;
  const px = (u) => S / 2 + (u * S) / span;
  const py = (u) => S / 2 - (u * S) / span;
  const pxPer = S / span;

  const gridLines = [];
  for (let u = gridStep; u <= span / 2; u += gridStep) {
    gridLines.push(u, -u);
  }

  const faceR = S * 0.46;
  const ringFracs = [0.78, 0.56, 0.34];

  const handle = (e) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    onTap({ x: (fx - 0.5) * span, y: (0.5 - fy) * span });
  };

  const holeR = Math.max(4, pxPer * 0.16);
  const splatR = holeR * 2.1;

  return (
    <svg
      viewBox={`0 0 ${S} ${S}`}
      onPointerDown={handle}
      style={TARGET_SVG_STYLE}
      role="img"
      aria-label="Tap target where your shots landed"
    >
      {/* graph-paper grid */}
      <line x1={0} y1={S / 2} x2={S} y2={S / 2} stroke={C.grid} strokeWidth={1.4} />
      <line x1={S / 2} y1={0} x2={S / 2} y2={S} stroke={C.grid} strokeWidth={1.4} />
      {gridLines.map((u, i) => (
        <g key={i}>
          <line x1={px(u)} y1={0} x2={px(u)} y2={S} stroke={C.grid} strokeWidth={0.7} />
          <line x1={0} y1={py(u)} x2={S} y2={py(u)} stroke={C.grid} strokeWidth={0.7} />
        </g>
      ))}

      {/* black target face */}
      <circle cx={S / 2} cy={S / 2} r={faceR} fill={C.face} />
      {ringFracs.map((f, i) => (
        <circle key={i} cx={S / 2} cy={S / 2} r={faceR * f} fill="none" stroke={C.faceRing} strokeWidth={1.6} />
      ))}
      {/* grid ghosted over the face */}
      {gridLines.map((u, i) => (
        <g key={`f${i}`} opacity={0.18}>
          <line x1={px(u)} y1={0} x2={px(u)} y2={S} stroke={C.grid} strokeWidth={0.7} />
          <line x1={0} y1={py(u)} x2={S} y2={py(u)} stroke={C.grid} strokeWidth={0.7} />
        </g>
      ))}

      {/* point of aim: red diamond */}
      <g transform={`rotate(45 ${S / 2} ${S / 2})`}>
        <rect x={S / 2 - 9} y={S / 2 - 9} width={18} height={18} fill={C.red} />
      </g>
      <circle cx={S / 2} cy={S / 2} r={2.4} fill={C.paper} />

      {/* ghosts: already-dialed shots from the walk-in */}
      {ghosts.map((s, i) => (
        <circle key={`g${i}`} cx={px(s.x)} cy={py(s.y)} r={holeR} fill={C.ink} stroke={C.paper} strokeWidth={1.5} opacity={0.4} />
      ))}

      {/* shots: splatter ring + bullet hole */}
      {shots.map((s, i) => (
        <g key={i}>
          <circle cx={px(s.x)} cy={py(s.y)} r={splatR} fill="none" stroke={C.splat} strokeWidth={holeR * 0.95} opacity={0.95} />
          <circle cx={px(s.x)} cy={py(s.y)} r={holeR} fill={C.ink} stroke={C.splat} strokeWidth={1.5} />
        </g>
      ))}

      {/* group center */}
      {center && shots.length > 1 && (
        <g stroke={C.orange} strokeWidth={2.4} fill="none">
          <line x1={px(center.x) - 12} y1={py(center.y)} x2={px(center.x) + 12} y2={py(center.y)} />
          <line x1={px(center.x)} y1={py(center.y) - 12} x2={px(center.x)} y2={py(center.y) + 12} />
          <circle cx={px(center.x)} cy={py(center.y)} r={7} />
        </g>
      )}

      {/* predicted POI after dialing */}
      {predicted && (
        <g>
          <circle cx={px(predicted.x)} cy={py(predicted.y)} r={11} fill="none" stroke={C.white} strokeWidth={2} strokeDasharray="4 3" />
          <circle cx={px(predicted.x)} cy={py(predicted.y)} r={2} fill={C.white} />
        </g>
      )}

      {/* scale stamp */}
      <text x={8} y={S - 8} fontFamily={FONT_MONO} fontSize={10.5} fill={C.inkSoft}>
        1 square = {gridStep} {lin}
      </text>
    </svg>
  );
});

/* ---------- results ticket ---------- */

function AdjustRow({ axis, result, type, rot, lin }) {
  const arrows = { UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→" };
  const { dir, steps, units, spec, residual } = result;
  const turn = turnFor(rot, dir);
  const irons = type === "irons";
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px dashed ${C.grid}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 14, letterSpacing: "0.12em", color: C.inkSoft, width: 86 }}>
          {axis}
        </span>
        {steps === 0 ? (
          <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 18, color: C.ink }}>HOLD — no change</span>
        ) : (
          <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 26, color: C.ink }}>
            {fmtUnits(units, spec)}{" "}
            <span style={{ color: C.red }}>
              {dir} {arrows[dir]}
            </span>
          </span>
        )}
      </div>
      {steps > 0 && (
        <div style={{ marginTop: 6, paddingLeft: 86 }}>
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              border: `2px solid ${C.ink}`, borderRadius: 4,
              background: C.card, padding: "5px 12px 5px 9px", color: C.ink,
            }}
          >
            {irons ? (
              <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 17, letterSpacing: "0.06em" }}>
                {IRONS_ACTIONS[dir].main}
              </span>
            ) : turn ? (
              <>
                <RotGlyph ccw={turn === CCW} />
                <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 19, letterSpacing: "0.06em" }}>
                  TURN {turn === CW ? "CLOCKWISE" : "COUNTER-CLOCKWISE"}
                </span>
              </>
            ) : (
              <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 17, letterSpacing: "0.06em" }}>
                TURN TOWARD THE “{dir}” ARROW
              </span>
            )}
          </div>
          {irons && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft, marginTop: 4 }}>
              {IRONS_ACTIONS[dir].note}
            </div>
          )}
          {residual > 0.05 && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 4 }}>
              ~{fmt(residual, 1)} {lin} will remain
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================ */

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.paper, fontFamily: FONT_MONO, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Something went wrong.</div>
          <button
            onClick={() => { localStorage.removeItem("clickbait-v1"); window.location.reload(); }}
            style={{ fontFamily: FONT_MONO, fontSize: 14, padding: "12px 20px", border: `2px solid ${C.ink}`, borderRadius: 4, background: C.red, color: C.white, cursor: "pointer" }}
          >
            Reset app and reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("zero");
  const [profiles, setProfiles] = useState(PRESET_PROFILES);
  const [activeId, setActiveId] = useState(PRESET_PROFILES[0].id);
  const [units, setUnits] = useState("imp");
  const [distance, setDistance] = useState(25);
  const [span, setSpan] = useState(12);
  const [shots, setShots] = useState([]);
  const [ghosts, setGhosts] = useState([]);
  const [mode, setMode] = useState("one");
  const [entryMode, setEntryMode] = useState("tap");
  const [numV, setNumV] = useState({ dir: "LOW", val: "" });
  const [numH, setNumH] = useState({ dir: "LEFT", val: "" });
  const [log, setLog] = useState([]);
  const [editing, setEditing] = useState(false);
  const [counter, setCounter] = useState({ turret: "ELEVATION", count: 0, done: false });
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);
  const handleTargetTap = useCallback(
    (pt) => setShots((s) => (mode === "one" ? [pt] : [...s, pt])),
    [mode]
  );

  const switchMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  const U = UNITS[units];
  const profile = profiles.find((p) => p.id === activeId) || profiles[0];

  /* ----- persistence ----- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem("clickbait-v1");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.profiles && s.profiles.length) {
          // append any presets the saved list doesn't know about yet
          const saved = s.profiles;
          setProfiles([...saved, ...PRESET_PROFILES.filter((p) => !saved.some((x) => x.id === p.id))]);
        }
        if (s.activeId) setActiveId(s.activeId);
        if (s.units) setUnits(s.units);
        if (s.distance) setDistance(s.distance);
        if (s.span) setSpan(s.span);
        if (s.log) setLog(s.log);
        if (s.mode) setMode(s.mode);
      }
    } catch (e) {
      /* first run — nothing saved yet */
    }
    loadedRef.current = true;
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          "clickbait-v1",
          JSON.stringify({ profiles, activeId, units, distance, span, log, mode })
        );
      } catch (e) {}
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [profiles, activeId, units, distance, span, log, mode, loaded]);

  /* ----- unit switch keeps things sane ----- */
  const switchUnits = (u) => {
    if (u === units) return;
    setUnits(u);
    setDistance(UNITS[u].distances[2] || UNITS[u].distances[0]);
    setSpan(UNITS[u].spans[1]);
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  /* ----- the math ----- */
  const calc = useMemo(() => {
    let cx = null, cy = null;
    if (entryMode === "tap" && shots.length) {
      cx = shots.reduce((a, s) => a + s.x, 0) / shots.length;
      cy = shots.reduce((a, s) => a + s.y, 0) / shots.length;
    } else if (entryMode === "type" && (numV.val !== "" || numH.val !== "")) {
      const v = parseFloat(numV.val) || 0;
      const h = parseFloat(numH.val) || 0;
      cy = numV.dir === "LOW" ? -v : v;
      cx = numH.dir === "LEFT" ? -h : h;
    }
    if (cx === null) return null;

    const axes = axisSpecs(profile);
    const solveAxis = (offset, dir, spec) => {
      const perUnit = spec.moaPerUnit * U.perMOA(distance); // linear units per 1.0 unit
      if (!perUnit || !isFinite(perUnit)) return null;
      const steps = Math.round(Math.abs(offset) / (perUnit * spec.step)); // integer count of quanta
      const units = steps * spec.step;
      return {
        dir, steps, units, spec, perUnit,
        move: units * perUnit, // linear correction applied
        residual: Math.abs(Math.abs(offset) - units * perUnit),
        overTravel: units > spec.maxUnits,
      };
    };
    const elev = solveAxis(cy, cy <= 0 ? "UP" : "DOWN", axes.elev);
    const wind = solveAxis(cx, cx <= 0 ? "RIGHT" : "LEFT", axes.wind);
    if (!elev || !wind) return null;

    const predicted = {
      x: cx + (wind.dir === "RIGHT" ? 1 : -1) * wind.move,
      y: cy + (elev.dir === "UP" ? 1 : -1) * elev.move,
    };

    let groupSize = null;
    if (entryMode === "tap" && shots.length > 1) {
      let m = 0;
      for (let i = 0; i < shots.length; i++)
        for (let j = i + 1; j < shots.length; j++)
          m = Math.max(m, Math.hypot(shots[i].x - shots[j].x, shots[i].y - shots[j].y));
      groupSize = m;
    }

    return { cx, cy, elev, wind, predicted, groupSize };
  }, [shots, entryMode, numV, numH, profile, distance, units]);

  const zeroed = calc && calc.elev.steps === 0 && calc.wind.steps === 0;

  const stampLog = () => {
    if (!calc) return;
    setLog((l) => [
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        optic: profile.short,
        dist: `${distance} ${U.dist}`,
        e: calc.elev.steps
          ? `${calc.elev.spec.unit === "click" ? calc.elev.units : fmtUnits(calc.elev.units, calc.elev.spec)}${calc.elev.dir === "UP" ? "↑" : "↓"}`
          : "—",
        w: calc.wind.steps
          ? `${calc.wind.spec.unit === "click" ? calc.wind.units : fmtUnits(calc.wind.units, calc.wind.spec)}${calc.wind.dir === "RIGHT" ? "→" : "←"}`
          : "—",
        grp: calc.groupSize ? `${fmt(calc.groupSize, 1)} ${U.lin}` : null,
        one: mode === "one" || undefined,
      },
      ...l,
    ]);
    if (mode === "one" && shots.length) setGhosts((g) => [...g, shots[0]]);
    setShots([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  /* ----- profile editing ----- */
  const updateProfile = (patch) => {
    if (patch.clickMOA !== undefined) patch = { ...patch, clickMOA: Math.max(0.05, patch.clickMOA) };
    if (patch.travelMOA !== undefined) patch = { ...patch, travelMOA: Math.max(10, patch.travelMOA) };
    if (patch.elev !== undefined) patch = { ...patch, elev: { ...patch.elev, moaPerUnit: Math.max(0.5, patch.elev.moaPerUnit) } };
    if (patch.wind !== undefined) patch = { ...patch, wind: { ...patch.wind, moaPerUnit: Math.max(0.5, patch.wind.moaPerUnit) } };

    const target = profiles.find((p) => p.id === activeId);
    if (!target) return;

    if (target.builtin) {
      const cloneId = "custom-" + crypto.randomUUID();
      const cloned = { ...target, ...patch, id: cloneId, builtin: false };
      setProfiles((ps) => {
        const idx = ps.findIndex((p) => p.id === target.id);
        const next = [...ps];
        next.splice(idx + 1, 0, cloned);
        return next;
      });
      setActiveId(cloneId);
      return;
    }

    setProfiles((ps) => ps.map((p) => (p.id === activeId ? { ...p, ...patch } : p)));
  };

  const addCustom = () => {
    const id = "custom-" + crypto.randomUUID();
    setProfiles((ps) => [...ps, { id, name: "Custom optic", short: "Custom", clickMOA: 0.5, travelMOA: 80, rot: null }]);
    setActiveId(id);
    setEditing(true);
  };

  const deleteProfile = () => {
    if (profile.builtin) return;
    setProfiles((ps) => ps.filter((p) => p.id !== activeId));
    setActiveId(PRESET_PROFILES[0].id);
    setEditing(false);
  };

  const resetPresets = () => {
    setProfiles((ps) => {
      const customs = ps.filter((p) => !p.builtin);
      return [...PRESET_PROFILES, ...customs];
    });
  };

  /* ----- counter helpers ----- */
  const lockToLock = profile.type === "irons" ? 0 : Math.round(profile.travelMOA / profile.clickMOA);
  const bump = (n) => setCounter((c) => ({ ...c, count: Math.max(0, c.count + n), done: false }));

  /* ============================ render ============================ */
  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink }}>
      <style>{`
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button:focus-visible, input:focus-visible { outline: 3px solid ${C.orange}; outline-offset: 2px; }
        input { font-family: ${FONT_MONO}; }
        @keyframes stampIn { from { transform: scale(1.04); opacity: .4; } to { transform: scale(1); opacity: 1; } }
        .stamp { animation: stampIn .18s ease-out; }
        @media (prefers-reduced-motion: reduce) { .stamp { animation: none; } }
      `}</style>

      <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 14px 40px" }}>
        {/* header */}
        <header style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "0.2em", color: C.inkSoft }}>
            RANGE DATA TOOL · MOA
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
              <circle cx="15" cy="15" r="12" fill="none" stroke={C.red} strokeWidth="2.5" />
              <circle cx="15" cy="15" r="4" fill={C.red} />
            </svg>
            <h1 style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 42, lineHeight: 1, margin: 0, letterSpacing: "0.02em" }}>
              CLICKBAIT
            </h1>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft, marginTop: 4 }}>
            Sight-in & turret assistant — every click accounted for.
          </div>
        </header>

        {/* optic selector */}
        <Label>Optic</Label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {profiles.map((p) => (
            <Chip key={p.id} active={p.id === activeId} onClick={() => { setActiveId(p.id); setEditing(false); }}>
              {p.short}
            </Chip>
          ))}
          <Chip onClick={addCustom}>+ add</Chip>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft }}>
            {profile.name} ·{" "}
            <b style={{ color: C.ink }}>
              {profile.type === "irons"
                ? `${profile.elev.moaPerUnit} MOA/turn · ${profile.wind.moaPerUnit} MOA/mm`
                : `${profile.clickMOA} MOA/click`}
            </b>
          </span>
          <button
            onClick={() => setEditing((e) => !e)}
            style={{ fontFamily: FONT_MONO, fontSize: 12, border: "none", background: "none", color: C.red, textDecoration: "underline", cursor: "pointer", padding: 4 }}
          >
            {editing ? "close" : "edit specs"}
          </button>
        </div>

        {editing && (
          <Card style={{ marginTop: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ gridColumn: "1 / -1", fontFamily: FONT_MONO, fontSize: 12 }}>
                Name
                <input
                  value={profile.name}
                  onChange={(e) => updateProfile({ name: e.target.value, short: e.target.value.slice(0, 12) })}
                  style={{ width: "100%", marginTop: 4, padding: 10, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 14, background: C.paper }}
                />
              </label>
              {profile.type === "irons" ? (
                <>
                  <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    MOA per turn (front post)
                    <input
                      type="number" step="0.1" min="0.5" inputMode="decimal"
                      value={profile.elev.moaPerUnit}
                      onChange={(e) => updateProfile({ elev: { ...profile.elev, moaPerUnit: parseFloat(e.target.value) || 6.9 } })}
                      style={{ width: "100%", marginTop: 4, padding: 10, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 14, background: C.paper }}
                    />
                  </label>
                  <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    MOA per mm of drift
                    <input
                      type="number" step="0.1" min="0.5" inputMode="decimal"
                      value={profile.wind.moaPerUnit}
                      onChange={(e) => updateProfile({ wind: { ...profile.wind, moaPerUnit: parseFloat(e.target.value) || 9.1 } })}
                      style={{ width: "100%", marginTop: 4, padding: 10, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 14, background: C.paper }}
                    />
                  </label>
                  <div style={{ gridColumn: "1 / -1", fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
                    MOA per turn depends on sight radius and thread pitch — ~6.9 for AKM-pattern (378 mm radius, M6×0.75). Shorter rifles (AKS-74U etc.) differ.
                  </div>
                </>
              ) : (
                <>
                  <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    MOA per click
                    <input
                      type="number" step="0.05" min="0.05" inputMode="decimal"
                      value={profile.clickMOA}
                      onChange={(e) => updateProfile({ clickMOA: parseFloat(e.target.value) || 0.25 })}
                      style={{ width: "100%", marginTop: 4, padding: 10, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 14, background: C.paper }}
                    />
                  </label>
                  <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    Total travel (MOA)
                    <input
                      type="number" step="5" min="10" inputMode="numeric"
                      value={profile.travelMOA}
                      onChange={(e) => updateProfile({ travelMOA: parseFloat(e.target.value) || 60 })}
                      style={{ width: "100%", marginTop: 4, padding: 10, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 14, background: C.paper }}
                    />
                  </label>
                  {[
                    { lbl: "Elevation screw", anchor: "UP", key: "elev" },
                    { lbl: "Windage screw", anchor: "RIGHT", key: "wind" },
                  ].map(({ lbl, anchor, key }) => {
                    const sel = rotToSel(profile.rot, anchor);
                    return (
                      <div key={key} style={{ gridColumn: "1 / -1" }}>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 12, marginBottom: 4 }}>{lbl}</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {[["cw", `${anchor} = CW`], ["ccw", `${anchor} = CCW`], ["marked", "marked on turret"]].map(([v, txt]) => (
                            <Chip
                              key={v}
                              active={sel === v}
                              onClick={() =>
                                updateProfile({
                                  rot: buildRot(
                                    key === "elev" ? v : rotToSel(profile.rot, "UP"),
                                    key === "wind" ? v : rotToSel(profile.rot, "RIGHT")
                                  ),
                                })
                              }
                            >
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                {v !== "marked" && <RotGlyph ccw={v === "ccw"} size={15} />}
                                {txt}
                              </span>
                            </Chip>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ gridColumn: "1 / -1", fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
                    CW/CCW = which way the screw turns to move impact UP / RIGHT. Check your optic's manual.
                  </div>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
              {!profile.builtin && (
                <button onClick={deleteProfile} style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, background: "none", border: "none", textDecoration: "underline", cursor: "pointer", padding: 4 }}>
                  delete optic
                </button>
              )}
              <button onClick={resetPresets} style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, background: "none", border: "none", textDecoration: "underline", cursor: "pointer", padding: 4 }}>
                restore preset specs
              </button>
            </div>
          </Card>
        )}

        {/* tabs */}
        <div style={{ display: "flex", gap: 6, marginTop: 18, borderBottom: `2px solid ${C.ink}` }}>
          {[
            ["zero", "ZERO TARGET"],
            ["center", profile.type === "irons" ? "SIGHT SETUP" : "CENTER TURRETS"],
            ["log", `DOPE LOG${log.length ? ` (${log.length})` : ""}`],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 14, letterSpacing: "0.08em",
                padding: "12px 10px", minHeight: 46, flex: 1,
                border: `2px solid ${C.ink}`, borderBottom: "none",
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

        {/* ================= ZERO TAB ================= */}
        {tab === "zero" && (
          <div>
            <Label>Distance to target</Label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {U.distances.map((d) => (
                <Chip key={d} active={distance === d} onClick={() => setDistance(d)}>
                  {d} {U.dist}
                </Chip>
              ))}
              <div style={{ display: "flex", gap: 0 }}>
                <input
                  type="number" min="1" inputMode="numeric" value={distance}
                  onChange={(e) => { const max = units === "imp" ? 2000 : 1800; setDistance(Math.max(1, Math.min(max, parseFloat(e.target.value) || 1))); }}
                  aria-label="Custom distance"
                  style={{ width: 74, padding: 10, minHeight: 44, border: `2px solid ${C.ink}`, borderRadius: "3px 0 0 3px", fontSize: 14, background: C.card }}
                />
                {["imp", "met"].map((u, i) => (
                  <button
                    key={u}
                    onClick={() => switchUnits(u)}
                    style={{
                      fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, padding: "10px 10px", minHeight: 44,
                      border: `2px solid ${C.ink}`, borderRadius: i === 1 ? "0 3px 3px 0" : "0",
                      borderLeft: "none",
                      background: units === u ? C.ink : C.card, color: units === u ? C.paper : C.ink, cursor: "pointer",
                    }}
                  >
                    {u === "imp" ? "yd/in" : "m/cm"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginTop: 20 }}>
              <Label>
                {mode === "one"
                  ? entryMode === "tap" ? "Tap where your shot hit" : "Type your shot offset"
                  : entryMode === "tap" ? "Tap where your shots hit" : "Type your group offset"}
              </Label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Chip active={mode === "one"} onClick={() => switchMode("one")} title="Dial after every single shot">one shot</Chip>
                <Chip active={mode === "group"} onClick={() => switchMode("group")} title="Fire a group, dial off its center">group</Chip>
                <span style={{ width: 6 }} />
                <Chip active={entryMode === "tap"} onClick={() => setEntryMode("tap")}>tap</Chip>
                <Chip active={entryMode === "type"} onClick={() => setEntryMode("type")}>type</Chip>
              </div>
            </div>

            {entryMode === "tap" ? (
              <>
                <Target
                  span={span}
                  gridStep={U.gridStep[span] || 1}
                  lin={U.lin}
                  shots={shots}
                  ghosts={mode === "one" ? ghosts : []}
                  center={calc ? { x: calc.cx, y: calc.cy } : null}
                  predicted={calc && !zeroed ? calc.predicted : null}
                  onTap={handleTargetTap}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Chip onClick={() => setShots((s) => s.slice(0, -1))}>undo</Chip>
                  <Chip onClick={() => { setShots([]); setGhosts([]); }}>clear</Chip>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft }}>
                    {mode === "one" ? (
                      <>shot #{ghosts.length + 1}{ghosts.length > 0 && ` · ${ghosts.length} dialed`}</>
                    ) : (
                      <>
                        {shots.length} shot{shots.length === 1 ? "" : "s"}
                        {calc && calc.groupSize != null && ` · group ${fmt(calc.groupSize, 1)} ${U.lin}`}
                      </>
                    )}
                  </span>
                  <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                    {U.spans.map((s) => (
                      <Chip key={s} active={span === s} onClick={() => setSpan(s)} title="Target view width">
                        {s}{U.lin}
                      </Chip>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <Card style={{ marginTop: 12 }}>
                {[
                  { st: numV, set: setNumV, opts: ["LOW", "HIGH"], lbl: "Vertical" },
                  { st: numH, set: setNumH, opts: ["LEFT", "RIGHT"], lbl: "Horizontal" },
                ].map(({ st, set, opts, lbl }) => (
                  <div key={lbl} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, width: 84, color: C.inkSoft }}>{lbl}:</span>
                    {opts.map((o) => (
                      <Chip key={o} active={st.dir === o} onClick={() => set({ ...st, dir: o })}>{o.toLowerCase()}</Chip>
                    ))}
                    <input
                      type="number" step="0.1" min="0" inputMode="decimal" placeholder="0.0" value={st.val}
                      onChange={(e) => set({ ...st, val: e.target.value })}
                      style={{ width: 84, padding: 10, minHeight: 44, border: `2px solid ${C.ink}`, borderRadius: 3, fontSize: 15, background: C.paper }}
                    />
                    <span style={{ fontFamily: FONT_MONO, fontSize: 13 }}>{U.lin}</span>
                  </div>
                ))}
                <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
                  {mode === "one"
                    ? "Measure from your shot to your point of aim."
                    : "Measure from the center of your group to your point of aim."}
                </div>
              </Card>
            )}

            {/* results ticket */}
            <Label>Dial it</Label>
            {!calc ? (
              <Card>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: C.inkSoft }}>
                  {mode === "one"
                    ? "Fire one shot, then mark it above. Dial, stamp, repeat — walk it in."
                    : "Fire a group of 3–5, then mark it above. Instructions appear here."}
                </div>
              </Card>
            ) : zeroed ? (
              <Card key="z" style={{ borderColor: C.ink }}>
                <div className="stamp" style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 30, color: C.ink }}>
                  ZEROED <span style={{ color: C.splat, textShadow: `0 0 1px ${C.ink}` }}>◉</span>
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft }}>
                  {mode === "one"
                    ? "Shot is within one adjustment of point of aim. Confirm with a group before you call it zeroed."
                    : "Group center is within one adjustment of point of aim. Send another group to confirm."}
                </div>
              </Card>
            ) : (
              <Card key={`${calc.elev.steps}${calc.elev.dir}-${calc.wind.steps}${calc.wind.dir}`}>
                <div className="stamp">
                  <AdjustRow axis="ELEVATION" result={calc.elev} type={profile.type} rot={profile.rot} lin={U.lin} />
                  <AdjustRow axis="WINDAGE" result={calc.wind} type={profile.type} rot={profile.rot} lin={U.lin} />
                  {profile.type === "irons" && (
                    <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 10 }}>
                      Adjust the FRONT sight only — set the rear leaf to its zeroing notch ("1" = 100 m) and leave it there.
                    </div>
                  )}
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: profile.type === "irons" ? 6 : 10 }}>
                    {profile.type === "irons"
                      ? `${fmtUnits(calc.elev.spec.step, calc.elev.spec)} = ${fmt(calc.elev.spec.step * calc.elev.perUnit, 2)} ${U.lin} · ${fmtUnits(calc.wind.spec.step, calc.wind.spec)} = ${fmt(calc.wind.spec.step * calc.wind.perUnit, 2)} ${U.lin}`
                      : `1 click = ${fmt(calc.elev.perUnit, 2)} ${U.lin}`}{" "}
                    at {distance} {U.dist} · dashed white ring shows where the next group should land
                  </div>
                  {profile.type === "irons" ? (
                    <>
                      {calc.elev.overTravel && (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `1px solid ${C.red}`, borderRadius: 3 }}>
                          ⚠ ELEVATION exceeds usable front-post travel (~{calc.elev.spec.maxUnits} turns) — check mounting and canting before cranking further.
                        </div>
                      )}
                      {calc.wind.overTravel && (
                        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `1px solid ${C.red}`, borderRadius: 3 }}>
                          ⚠ WINDAGE exceeds usable dovetail travel (~{calc.wind.spec.maxUnits} mm).
                        </div>
                      )}
                    </>
                  ) : (
                    (calc.elev.overTravel || calc.wind.overTravel) && (
                      <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `1px solid ${C.red}`, borderRadius: 3 }}>
                        ⚠ Adjustment exceeds half-travel ({Math.round(calc.elev.spec.maxUnits)} clicks) — turret may not have enough range.
                      </div>
                    )
                  )}
                </div>
              </Card>
            )}
            {calc && (
              <button
                onClick={stampLog}
                style={{
                  marginTop: 10, width: "100%", minHeight: 52, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 17,
                  letterSpacing: "0.1em", border: `2px solid ${C.ink}`, borderRadius: 4, background: C.splat, color: C.ink,
                  cursor: "pointer", boxShadow: `3px 3px 0 ${C.grid}`,
                }}
              >
                {mode === "one" ? "I DIALED IT — NEXT SHOT" : "I DIALED IT — STAMP TO LOG"}
              </button>
            )}
            {mode === "one" && (
              <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft, marginTop: 8 }}>
                One shot is one data point — wind, trigger, and ammo all lie. Confirm with a group when you're close.
              </div>
            )}
          </div>
        )}

        {/* ================= CENTER TAB ================= */}
        {tab === "center" && profile.type === "irons" && (
          <div>
            <Label>Sight setup</Label>
            <Card>
              <div style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22 }}>No turrets to center.</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, lineHeight: 1.7, marginTop: 8 }}>
                Iron sights have no detents or mechanical center. To start from a known baseline:
                <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                  <li>Center the windage drum in its dovetail — line up the factory witness mark.</li>
                  <li>Screw the front post to roughly mid-thread.</li>
                  <li>Set the rear leaf to "1" (100 m) for zeroing.</li>
                </ol>
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 8 }}>
                Then zero on the ZERO TARGET tab.
              </div>
            </Card>
          </div>
        )}
        {tab === "center" && profile.type !== "irons" && (
          <div>
            <Label>Turret</Label>
            <div style={{ display: "flex", gap: 8 }}>
              {["ELEVATION", "WINDAGE"].map((t) => (
                <Chip key={t} active={counter.turret === t} onClick={() => setCounter({ turret: t, count: 0, done: false })}>
                  {t.toLowerCase()}
                </Chip>
              ))}
            </div>

            <Label>Procedure</Label>
            <Card>
              <ol style={{ margin: 0, paddingLeft: 20, fontFamily: FONT_MONO, fontSize: 13.5, lineHeight: 1.7 }}>
                <li><b>Gently</b> turn the {counter.turret.toLowerCase()} screw clockwise until it stops.</li>
                <li>Turn back counter-clockwise, tapping <b>+1</b> for every click, until it stops again.</li>
                <li>Tap <b>done</b> — I'll tell you how far to come back.</li>
              </ol>
              <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 8 }}>
                Expect roughly {lockToLock} clicks lock-to-lock on the {profile.short} ({profile.travelMOA} MOA ÷ {profile.clickMOA}).
              </div>
            </Card>

            <div style={{ textAlign: "center", margin: "18px 0 10px" }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 12, letterSpacing: "0.15em", color: C.inkSoft }}>CLICKS COUNTED</div>
              <div className="stamp" key={counter.count} style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 72, lineHeight: 1.1 }}>
                {counter.count}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
              <button onClick={() => bump(1)} style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 34, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.ink, color: C.paper, cursor: "pointer", boxShadow: `3px 3px 0 ${C.grid}` }}>
                +1
              </button>
              <button onClick={() => bump(10)} style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, color: C.ink, cursor: "pointer" }}>
                +10
              </button>
              <button onClick={() => bump(-1)} style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, color: C.ink, cursor: "pointer" }}>
                −1
              </button>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => setCounter((c) => ({ ...c, count: 0, done: false }))} style={{ flex: 1, minHeight: 48, fontFamily: FONT_MONO, fontSize: 14, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, cursor: "pointer" }}>
                reset
              </button>
              <button onClick={() => setCounter((c) => ({ ...c, done: true }))} disabled={counter.count === 0} style={{ flex: 2, minHeight: 48, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 16, letterSpacing: "0.08em", border: `2px solid ${C.ink}`, borderRadius: 4, background: counter.count ? C.splat : C.grid, color: C.ink, cursor: counter.count ? "pointer" : "default" }}>
                DONE — CENTER IT
              </button>
            </div>

            {counter.done && counter.count > 0 && (
              <Card style={{ marginTop: 12 }}>
                <div className="stamp">
                  <div style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22 }}>
                    Turn{" "}
                    <span style={{ color: C.red }}>
                      <RotGlyph size={24} style={{ verticalAlign: "middle", marginRight: 2 }} />
                      {Math.round(counter.count / 2)} clicks clockwise
                    </span>
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.inkSoft, marginTop: 4 }}>
                    That puts the {counter.turret.toLowerCase()} turret at its mechanical center ({counter.count} total ÷ 2). Repeat for the other turret, then mount and zero.
                  </div>
                </div>
              </Card>
            )}

            <div style={{ marginTop: 14, padding: "10px 12px", border: `2px solid ${C.red}`, borderRadius: 4, transform: "rotate(-0.6deg)", fontFamily: FONT_MONO, fontSize: 12.5, color: C.red, fontWeight: 600 }}>
              ⚠ Never force a turret past its stop — when it binds, that's the end of travel.
            </div>
          </div>
        )}

        {/* ================= LOG TAB ================= */}
        {tab === "log" && (
          <div>
            <Label>Adjustment history</Label>
            {log.length === 0 ? (
              <Card>
                <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: C.inkSoft }}>
                  Nothing stamped yet. After you dial an adjustment on the Zero tab, stamp it here so you know where every sight stands.
                </div>
              </Card>
            ) : (
              <>
                {log.map((e, i) => (
                  <Card key={e.id || `${e.ts}-${i}`} style={{ marginBottom: 8, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                      <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 14 }}>{e.optic} · {e.dist}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
                        {new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, marginTop: 4 }}>
                      ELEV <b style={{ color: C.red }}>{e.e}</b> · WIND <b style={{ color: C.red }}>{e.w}</b>
                      {e.grp && <span style={{ color: C.inkSoft }}> · group {e.grp}</span>}
                      {e.one && <span style={{ color: C.inkSoft }}> · one-shot</span>}
                    </div>
                  </Card>
                ))}
                <button
                  onClick={() => setLog([])}
                  style={{ marginTop: 4, fontFamily: FONT_MONO, fontSize: 12.5, color: C.red, background: "none", border: "none", textDecoration: "underline", cursor: "pointer", padding: 6 }}
                >
                  clear log
                </button>
              </>
            )}
          </div>
        )}

        {/* footer */}
        <footer style={{ marginTop: 26, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.6, color: C.inkSoft, borderTop: `1px dashed ${C.grid}`, paddingTop: 10 }}>
          Click values preloaded from manufacturer manuals (HS507C-X2: 1 MOA · SLx 3×32 Gen III: ¼ MOA) — verify against your own manual; specs vary by model revision. AK irons: ~6.9 MOA per front-post turn / ~9.1 MOA per mm of drift (AKM-pattern sight radius — verify on your rifle). Follow all range safety rules. 1 MOA = 1.047 in at 100 yd / 2.908 cm at 100 m.
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
