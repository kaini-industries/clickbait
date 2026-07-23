import { useEffect, useRef, useState } from "react";
import { C, Card, Chip, FONT_HEAD, FONT_MONO, Label, RotGlyph } from "./ui";

export default function CenterPanel({
  profile,
  counter,
  centerGuidance,
  lockToLock,
  maxCounterClicks,
  onSelectTurret,
  onBump,
  onReset,
  onDone,
}) {
  const resetIdentity = `${profile.id}:${counter.turret}`;
  const [resetCandidate, setResetCandidate] = useState(null);
  const resetPending = resetCandidate === resetIdentity;
  const resetRequestRef = useRef(null);
  const resetConfirmRef = useRef(null);
  const countRef = useRef(null);

  useEffect(() => {
    if (resetCandidate && resetCandidate !== resetIdentity) {
      // A confirmation belongs to exactly one physical optic and axis. The
      // derived flag is already false on this render; this removes stale state
      // so it cannot reappear if the shooter later returns to that context.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResetCandidate(null);
    }
  }, [resetCandidate, resetIdentity]);

  if (profile.type === "irons") {
    return (
      <section id="panel-center" role="tabpanel" aria-labelledby="tab-center" tabIndex={0}>
        <Label>Sight setup</Label>
        <Card>
          <div style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22 }}>No turrets to center.</div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, lineHeight: 1.7, marginTop: 8 }}>
            Iron sights have no detents or mechanical center. To start from a known baseline:
            <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Center the windage drum in its dovetail — line up the factory witness mark.</li>
              <li>Screw the front post to roughly mid-thread.</li>
              <li>Set the rear leaf to “1” (100 m) for zeroing.</li>
            </ol>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 8 }}>
            Then zero on the ZERO TARGET tab.
          </div>
        </Card>
      </section>
    );
  }

  const atMaximum = counter.count >= maxCounterClicks;

  return (
    <section id="panel-center" role="tabpanel" aria-labelledby="tab-center" tabIndex={0}>
      <Label id="turret-heading">Turret</Label>
      <div role="group" aria-labelledby="turret-heading" style={{ display: "flex", gap: 8 }}>
        {["ELEVATION", "WINDAGE"].map((turret) => (
          <Chip
            key={turret}
            active={counter.turret === turret}
            onClick={() => {
              setResetCandidate(null);
              onSelectTurret(turret);
            }}
          >
            {turret.toLowerCase()}
          </Chip>
        ))}
      </div>

      <Label id="centering-procedure-heading">Procedure</Label>
      <Card>
        <ol style={{ margin: 0, paddingLeft: 20, fontFamily: FONT_MONO, fontSize: 13.5, lineHeight: 1.7 }}>
          <li><b>Gently</b> turn the {counter.turret.toLowerCase()} screw clockwise until it stops.</li>
          <li>Turn back counter-clockwise, tapping <b>+1</b> for every click, until it stops again.</li>
          <li>Tap <b>done</b> — I’ll tell you how far to come back.</li>
        </ol>
        <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 8 }}>
          Expect roughly {lockToLock} clicks lock-to-lock on the {profile.short} ({profile.travelMOA} MOA ÷ {profile.clickMOA}).
        </div>
      </Card>

      <div style={{ textAlign: "center", margin: "18px 0 10px" }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 12, letterSpacing: "0.15em", color: C.inkSoft }}>CLICKS COUNTED</div>
        <div
          ref={countRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`${counter.count} ${counter.count === 1 ? "click" : "clicks"} counted`}
          style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 72, lineHeight: 1.1 }}
        >
          <span className="stamp" key={counter.count}>{counter.count}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
        <button
          type="button"
          aria-label="Add one click"
          disabled={atMaximum}
          onClick={() => onBump(1)}
          style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 34, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.ink, color: C.paper, cursor: atMaximum ? "not-allowed" : "pointer", opacity: atMaximum ? 0.55 : 1, boxShadow: `3px 3px 0 ${C.grid}` }}
        >
          +1
        </button>
        <button
          type="button"
          aria-label="Add ten clicks"
          disabled={atMaximum}
          onClick={() => onBump(10)}
          style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, color: C.ink, cursor: atMaximum ? "not-allowed" : "pointer", opacity: atMaximum ? 0.55 : 1 }}
        >
          +10
        </button>
        <button
          type="button"
          aria-label="Subtract one click"
          disabled={counter.count === 0}
          onClick={() => onBump(-1)}
          style={{ minHeight: 88, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, color: C.ink, cursor: counter.count ? "pointer" : "not-allowed", opacity: counter.count ? 1 : 0.55 }}
        >
          −1
        </button>
      </div>

      {resetPending ? (
        <div
          role="group"
          aria-label={`Confirm resetting the ${counter.turret.toLowerCase()} count for ${profile.short}`}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}
        >
          <button
            ref={resetConfirmRef}
            type="button"
            onClick={() => {
              onReset();
              setResetCandidate(null);
              requestAnimationFrame(() => countRef.current?.focus());
            }}
            style={{ minHeight: 48, fontFamily: FONT_MONO, fontSize: 14, border: `2px solid ${C.red}`, borderRadius: 4, background: C.red, color: C.paper, cursor: "pointer" }}
          >
            confirm reset
          </button>
          <button
            type="button"
            onClick={() => {
              setResetCandidate(null);
              requestAnimationFrame(() => resetRequestRef.current?.focus());
            }}
            style={{ minHeight: 48, fontFamily: FONT_MONO, fontSize: 14, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, color: C.ink, cursor: "pointer" }}
          >
            cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            ref={resetRequestRef}
            type="button"
            disabled={counter.count === 0}
            onClick={() => {
              setResetCandidate(resetIdentity);
              requestAnimationFrame(() => resetConfirmRef.current?.focus());
            }}
            style={{ flex: 1, minHeight: 48, fontFamily: FONT_MONO, fontSize: 14, border: `2px solid ${C.ink}`, borderRadius: 4, background: C.card, cursor: counter.count ? "pointer" : "not-allowed", opacity: counter.count ? 1 : 0.55 }}
          >
            reset
          </button>
          <button
            type="button"
            onClick={onDone}
            disabled={counter.count === 0}
            style={{ flex: 2, minHeight: 48, fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 16, letterSpacing: "0.08em", border: `2px solid ${C.ink}`, borderRadius: 4, background: counter.count ? C.splat : C.grid, color: C.ink, cursor: counter.count ? "pointer" : "not-allowed" }}
          >
            DONE — CENTER IT
          </button>
        </div>
      )}

      {counter.done && counter.count > 0 && (
        <Card role="status" aria-live="polite" aria-atomic="true" style={{ marginTop: 12 }}>
          <div className="stamp">
            <div style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 22 }}>
              Turn{" "}
              <span style={{ color: C.red }}>
                <RotGlyph size={24} style={{ verticalAlign: "middle", marginRight: 2 }} />
                {centerGuidance.primaryClicks} clicks clockwise
              </span>
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.inkSoft, marginTop: 4 }}>
              {!centerGuidance.betweenDetents
                ? `That puts the ${counter.turret.toLowerCase()} turret at its mechanical center (${counter.count} total ÷ 2).`
                : `The exact mechanical center falls between detents ${centerGuidance.primaryClicks} and ${centerGuidance.alternateClicks}. Either is equally close; this instruction uses the lower count.`}{" "}
              Repeat for the other turret, then mount and zero.
            </div>
          </div>
        </Card>
      )}

      <div role="note" style={{ marginTop: 14, padding: "10px 12px", border: `2px solid ${C.red}`, borderRadius: 4, transform: "rotate(-0.6deg)", fontFamily: FONT_MONO, fontSize: 12.5, color: C.red, fontWeight: 600 }}>
        ⚠ Never force a turret past its stop — when it binds, that’s the end of travel.
      </div>
    </section>
  );
}
