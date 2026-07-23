import { useEffect, useRef } from "react";
import {
  CLOCKWISE,
  COUNTER_CLOCKWISE,
  turnForDirection,
} from "../../lib/domain.mjs";
import ShotTarget from "./ShotTarget";
import { C, Card, Chip, FONT_HEAD, FONT_MONO, Label, RotGlyph, fmt, fmtUnits } from "./ui";

const IRONS_ACTIONS = {
  UP: { main: "SCREW FRONT POST DOWN (clockwise from above)", speech: "screw the front post down, clockwise from above", note: "lowering the post raises impact" },
  DOWN: { main: "SCREW FRONT POST UP (counter-clockwise from above)", speech: "screw the front post up, counter-clockwise from above", note: "raising the post lowers impact" },
  RIGHT: { main: "DRIFT FRONT SIGHT DRUM LEFT", speech: "drift the front sight drum left", note: "moving the drum left moves impact right" },
  LEFT: { main: "DRIFT FRONT SIGHT DRUM RIGHT", speech: "drift the front sight drum right", note: "moving the drum right moves impact left" },
};

export function describeAdjustmentForSpeech(result, profileType) {
  if (result.steps === 0) return "hold; no change";
  const amount = fmtUnits(result.units, result.spec);
  return profileType === "irons"
    ? `${IRONS_ACTIONS[result.dir].speech} by ${amount}`
    : `move ${result.dir} by ${amount}`;
}

function AdjustmentRow({ axis, result, type, rotation, linearUnit }) {
  const arrows = { UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→" };
  const { dir, steps, units, spec, residual } = result;
  const turn = turnForDirection(rotation, dir);
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
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              border: `2px solid ${C.ink}`,
              borderRadius: 4,
              background: C.card,
              padding: "5px 12px 5px 9px",
              color: C.ink,
            }}
          >
            {irons ? (
              <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 17, letterSpacing: "0.06em" }}>
                {IRONS_ACTIONS[dir].main}
              </span>
            ) : turn ? (
              <>
                <RotGlyph ccw={turn === COUNTER_CLOCKWISE} />
                <span style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 19, letterSpacing: "0.06em" }}>
                  TURN {turn === CLOCKWISE ? "CLOCKWISE" : "COUNTER-CLOCKWISE"}
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
              ~{fmt(residual, 1)} {linearUnit} will remain
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ZeroPanel({
  unitSpec,
  units,
  distance,
  span,
  mode,
  entryMode,
  shots,
  ghosts,
  markedCenter,
  markedGroupSize,
  calc,
  zeroed,
  profile,
  verticalOffset,
  horizontalOffset,
  verticalError,
  horizontalError,
  targetRef,
  manualVerticalRef,
  onDistanceChange,
  onUnitsChange,
  onModeChange,
  onEntryModeChange,
  onTargetTap,
  onUndoShot,
  onClearShots,
  onSpanChange,
  onVerticalOffsetChange,
  onHorizontalOffsetChange,
  onStamp,
}) {
  const maxDistance = units === "imp" ? 2000 : 1800;
  const distanceInputRef = useRef(null);
  const distanceDirtyRef = useRef(false);
  const distanceDraftUnitsRef = useRef(units);

  // Keep a permissive DOM draft so a shooter can erase and retype the value
  // without the controlled input snapping an empty field to 1 mid-keystroke.
  // Valid intermediate values still reach the debounced persistence path.
  useEffect(() => {
    const input = distanceInputRef.current;
    if (distanceDraftUnitsRef.current !== units) {
      distanceDraftUnitsRef.current = units;
      distanceDirtyRef.current = false;
    }
    if (input && !distanceDirtyRef.current) input.value = String(distance);
  }, [distance, units]);

  const handleDistanceChange = (event) => {
    distanceDirtyRef.current = true;
    const nextDistance = event.currentTarget.valueAsNumber;
    if (Number.isFinite(nextDistance) && nextDistance >= 1 && nextDistance <= maxDistance) {
      onDistanceChange(nextDistance);
    }
  };

  const commitDistanceDraft = (event) => {
    if (!distanceDirtyRef.current) {
      event.currentTarget.value = String(distance);
      return;
    }
    const parsed = Number.parseFloat(event.currentTarget.value);
    const nextDistance = Number.isFinite(parsed)
      ? Math.max(1, Math.min(maxDistance, parsed))
      : distance;
    event.currentTarget.value = String(nextDistance);
    distanceDirtyRef.current = false;
    if (nextDistance !== distance) onDistanceChange(nextDistance);
  };

  return (
    <section id="panel-zero" role="tabpanel" aria-labelledby="tab-zero" tabIndex={0}>
      <Label id="distance-heading">Distance to target</Label>
      <div role="group" aria-labelledby="distance-heading" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {unitSpec.distances.map((presetDistance) => (
          <Chip
            key={presetDistance}
            active={distance === presetDistance}
            onClick={() => onDistanceChange(presetDistance)}
          >
            {presetDistance} {unitSpec.dist}
          </Chip>
        ))}
        <div style={{ display: "flex", gap: 0 }}>
          <input
            ref={distanceInputRef}
            id="custom-distance"
            type="number"
            min="1"
            max={maxDistance}
            inputMode="numeric"
            defaultValue={distance}
            onChange={handleDistanceChange}
            onBlur={commitDistanceDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label={`Custom distance in ${unitSpec.dist === "yd" ? "yards" : "meters"}`}
            style={{ width: 78, padding: 10, minHeight: 44, border: `2px solid ${C.ink}`, borderRadius: "3px 0 0 3px", fontSize: 16, background: C.card }}
          />
          {["imp", "met"].map((unitSystem, index) => (
            <button
              key={unitSystem}
              type="button"
              aria-pressed={units === unitSystem}
              aria-label={unitSystem === "imp" ? "Use yards and inches" : "Use meters and centimeters"}
              onClick={() => onUnitsChange(unitSystem)}
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                fontWeight: 600,
                padding: "10px 10px",
                minHeight: 44,
                border: `2px solid ${C.ink}`,
                borderRadius: index === 1 ? "0 3px 3px 0" : "0",
                borderLeft: "none",
                background: units === unitSystem ? C.ink : C.card,
                color: units === unitSystem ? C.paper : C.ink,
                cursor: "pointer",
              }}
            >
              {unitSystem === "imp" ? "yd/in" : "m/cm"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginTop: 20 }}>
        <Label id="shot-entry-heading">
          {mode === "one"
            ? entryMode === "tap" ? "Tap where your shot hit" : "Type your shot offset"
            : entryMode === "tap" ? "Tap where your shots hit" : "Type your group offset"}
        </Label>
        <div role="group" aria-label="Shot and entry modes" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip active={mode === "one"} onClick={() => onModeChange("one")} title="Dial after every single shot">one shot</Chip>
          <Chip active={mode === "group"} onClick={() => onModeChange("group")} title="Fire a group, dial off its center">group</Chip>
          <span style={{ width: 6 }} />
          <Chip active={entryMode === "tap"} onClick={() => onEntryModeChange("tap")} title="Mark each shot on the target by pointer or keyboard">tap</Chip>
          <Chip active={entryMode === "type"} onClick={() => onEntryModeChange("type")} title="Enter a measured shot or group-center offset">type</Chip>
        </div>
      </div>

      {entryMode === "tap" ? (
        <>
          <ShotTarget
            ref={targetRef}
            span={span}
            gridStep={unitSpec.gridStep[span] || 1}
            lin={unitSpec.lin}
            shots={shots}
            ghosts={mode === "one" ? ghosts : []}
            center={markedCenter}
            predicted={calc && !zeroed ? calc.predicted : null}
            onTap={onTargetTap}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Chip disabled={shots.length === 0} onClick={onUndoShot}>undo last shot</Chip>
            <Chip disabled={shots.length === 0 && ghosts.length === 0} onClick={onClearShots}>clear shots</Chip>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft }}>
              {mode === "one" ? (
                <>shot #{ghosts.length + 1}{ghosts.length > 0 && ` · ${ghosts.length} dialed`}</>
              ) : (
                <>
                  {shots.length} shot{shots.length === 1 ? "" : "s"}
                  {markedGroupSize != null && ` · group ${fmt(markedGroupSize, 1)} ${unitSpec.lin}`}
                </>
              )}
            </span>
            <div role="group" aria-label="Target view width" style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              {unitSpec.spans.map((targetSpan) => (
                <Chip key={targetSpan} active={span === targetSpan} onClick={() => onSpanChange(targetSpan)} title="Target view width">
                  {targetSpan}{unitSpec.lin}
                </Chip>
              ))}
            </div>
          </div>
        </>
      ) : (
        <Card style={{ marginTop: 12 }} role="group" aria-label={mode === "one" ? "Measured shot offset" : "Measured group-center offset"}>
          {[
            { state: verticalOffset, set: onVerticalOffsetChange, options: ["LOW", "HIGH"], label: "Vertical", key: "vertical", error: verticalError, inputRef: manualVerticalRef },
            { state: horizontalOffset, set: onHorizontalOffsetChange, options: ["LEFT", "RIGHT"], label: "Horizontal", key: "horizontal", error: horizontalError, inputRef: null },
          ].map(({ state, set, options, label, key, error, inputRef }) => (
            <fieldset key={key} style={{ minWidth: 0, border: 0, padding: 0, margin: "0 0 14px" }}>
              <legend style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 13, color: C.inkSoft, marginBottom: 6 }}>
                {label} offset
              </legend>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <div role="group" aria-label={`${label} direction`} style={{ display: "flex", gap: 6 }}>
                  {options.map((option) => (
                    <Chip key={option} active={state.dir === option} onClick={() => set({ ...state, dir: option })}>{option.toLowerCase()}</Chip>
                  ))}
                </div>
                <label htmlFor={`${key}-offset`} className="sr-only">{label} offset distance in {unitSpec.lin === "in" ? "inches" : "centimeters"}</label>
                <input
                  ref={inputRef}
                  id={`${key}-offset`}
                  type="number"
                  step="0.1"
                  min="0"
                  max="100000"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={state.val}
                  onChange={(event) => set({ ...state, val: event.target.value })}
                  aria-invalid={Boolean(error)}
                  aria-describedby={`${key}-unit${error ? ` ${key}-offset-error` : ""}`}
                  aria-errormessage={error ? `${key}-offset-error` : undefined}
                  style={{ width: 92, padding: 10, minHeight: 44, border: `2px solid ${error ? C.red : C.ink}`, borderRadius: 3, fontSize: 16, background: C.paper }}
                />
                <span id={`${key}-unit`} style={{ fontFamily: FONT_MONO, fontSize: 13 }}>{unitSpec.lin}</span>
              </div>
              {error && (
                <div id={`${key}-offset-error`} role="alert" className="field-error">
                  ⚠ {error}
                </div>
              )}
            </fieldset>
          ))}
          <div id="offset-help" style={{ fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.5, color: C.inkSoft }}>
            {mode === "one"
              ? "Measure from your shot to your point of aim."
              : "Measure from the center of your group to your point of aim."}
          </div>
        </Card>
      )}

      <Label id="dial-heading">Dial it</Label>
      <div id="dial-result" aria-labelledby="dial-heading">
        {(verticalError || horizontalError) ? (
          <Card style={{ borderColor: C.red }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: C.red, fontWeight: 600 }}>
              ⚠ Correct the highlighted offset {verticalError && horizontalError ? "values" : "value"} before dialing.
            </div>
          </Card>
        ) : !calc ? (
          <Card>
            <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: C.inkSoft }}>
              {entryMode === "type"
                ? mode === "one"
                  ? "Enter the measured shot offset above. Dial, stamp, repeat — walk it in."
                  : "Enter the measured group-center offset above. Instructions appear here."
                : mode === "one"
                  ? "Fire one shot, then mark it above. Dial, stamp, repeat — walk it in."
                  : shots.length === 0
                    ? "Fire a group of 3–5, then mark each shot above. Instructions appear after 3 shots."
                    : `Mark ${3 - shots.length} more ${3 - shots.length === 1 ? "shot" : "shots"} before dialing from the group center.`}
            </div>
          </Card>
        ) : zeroed ? (
          <Card key="zeroed" style={{ borderColor: C.ink }}>
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
              <AdjustmentRow axis="ELEVATION" result={calc.elev} type={profile.type} rotation={profile.rot} linearUnit={unitSpec.lin} />
              <AdjustmentRow axis="WINDAGE" result={calc.wind} type={profile.type} rotation={profile.rot} linearUnit={unitSpec.lin} />
              {profile.type === "irons" && (
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: 10 }}>
                  Adjust the FRONT sight only — set the rear leaf to its zeroing notch (“1” = 100 m) and leave it there.
                </div>
              )}
              <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.inkSoft, marginTop: profile.type === "irons" ? 6 : 10 }}>
                {profile.type === "irons"
                  ? `${fmtUnits(calc.elev.spec.step, calc.elev.spec)} = ${fmt(calc.elev.spec.step * calc.elev.perUnit, 2)} ${unitSpec.lin} · ${fmtUnits(calc.wind.spec.step, calc.wind.spec)} = ${fmt(calc.wind.spec.step * calc.wind.perUnit, 2)} ${unitSpec.lin}`
                  : `1 click = ${fmt(calc.elev.perUnit, 2)} ${unitSpec.lin}`}{" "}
                at {distance} {unitSpec.dist}
                {entryMode === "tap" && (
                  <> · dashed white ring shows where the next {mode === "one" ? "impact" : "group center"} should land</>
                )}
              </div>
              {profile.type === "irons" ? (
                <>
                  {calc.elev.overTravel && (
                    <div role="alert" style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `2px solid ${C.red}`, borderRadius: 3 }}>
                      ⚠ ELEVATION exceeds usable front-post travel (~{calc.elev.spec.maxUnits} turns) — check mounting and canting before cranking further.
                    </div>
                  )}
                  {calc.wind.overTravel && (
                    <div role="alert" style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `2px solid ${C.red}`, borderRadius: 3 }}>
                      ⚠ WINDAGE exceeds usable dovetail travel (~{calc.wind.spec.maxUnits} mm).
                    </div>
                  )}
                </>
              ) : (
                (calc.elev.overTravel || calc.wind.overTravel) && (
                  <div role="alert" style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.red, marginTop: 6, padding: "6px 10px", border: `2px solid ${C.red}`, borderRadius: 3 }}>
                    ⚠ Adjustment exceeds half-travel ({Math.round(calc.elev.spec.maxUnits)} clicks) — turret may not have enough range.
                  </div>
                )
              )}
            </div>
          </Card>
        )}
        {calc && (
          <button
            id="stamp-adjustment"
            type="button"
            onClick={onStamp}
            style={{
              marginTop: 10,
              width: "100%",
              minHeight: 52,
              fontFamily: FONT_HEAD,
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: "0.1em",
              border: `2px solid ${C.ink}`,
              borderRadius: 4,
              background: C.splat,
              color: C.ink,
              cursor: "pointer",
              boxShadow: `3px 3px 0 ${C.grid}`,
            }}
          >
            {mode === "one" ? "I DIALED IT — NEXT SHOT" : "I DIALED IT — STAMP TO LOG"}
          </button>
        )}
      </div>
      {mode === "one" && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft, marginTop: 8 }}>
          One shot is one data point — wind, trigger, and ammo all lie. Confirm with a group when you’re close.
        </div>
      )}
    </section>
  );
}
