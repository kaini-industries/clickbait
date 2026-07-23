"use client";

import { useEffect, useRef } from "react";
import {
  buildRotationMap,
  rotationSelection,
} from "../../lib/domain.mjs";
import { C, Card, Chip, FONT_MONO, Label, RotGlyph } from "./ui";

const NUMBER_LIMITS = {
  clickMOA: { min: 0.05, max: 100, step: 0.05 },
  travelMOA: { min: 10, max: 10_000, step: 5 },
  ironMOA: { min: 0.5, max: 10_000, step: 0.1 },
};

const inputStyle = {
  width: "100%",
  marginTop: 4,
  padding: 10,
  minHeight: 44,
  border: `2px solid ${C.ink}`,
  borderRadius: 3,
  fontSize: 16,
  background: C.paper,
};

const displayName = (profile) => (
  String(profile.name ?? "").trim()
  || String(profile.short ?? "").trim()
  || "Unnamed optic"
);

const displayShortName = (profile) => (
  String(profile.short ?? "").trim() || displayName(profile).slice(0, 12) || "Unnamed optic"
);

function ProfileEditor({
  profile,
  deletePending,
  deleteRequestRef,
  deleteConfirmRef,
  onUpdateProfile,
  onRequestDelete,
  onDelete,
  onCancelDelete,
  onResetPresets,
}) {
  const nameRef = useRef(null);
  const clickRef = useRef(null);
  const travelRef = useRef(null);
  const elevationRef = useRef(null);
  const windageRef = useRef(null);
  const dirtyRef = useRef({
    name: false,
    clickMOA: false,
    travelMOA: false,
    elevationMOA: false,
    windageMOA: false,
  });

  useEffect(() => {
    const values = [
      ["name", nameRef, displayName(profile)],
      ["clickMOA", clickRef, String(profile.clickMOA ?? "")],
      ["travelMOA", travelRef, String(profile.travelMOA ?? "")],
      ["elevationMOA", elevationRef, String(profile.elev?.moaPerUnit ?? "")],
      ["windageMOA", windageRef, String(profile.wind?.moaPerUnit ?? "")],
    ];
    for (const [field, inputRef, value] of values) {
      if (inputRef.current && !dirtyRef.current[field]) inputRef.current.value = value;
    }
  }, [profile]);

  const commitName = (event) => {
    if (!dirtyRef.current.name) return;
    const safeName = event.currentTarget.value.trim() || displayName(profile);
    event.currentTarget.value = safeName;
    dirtyRef.current.name = false;
    if (safeName !== profile.name || profile.short !== safeName.slice(0, 12)) {
      // A blur caused by pressing another editor control must not insert a new
      // optic chip before that control receives pointer-up/click. Use the
      // profile-specific callback on the next frame so the completed click
      // cannot be displaced by selector reflow.
      requestAnimationFrame(() => {
        onUpdateProfile({ name: safeName, short: safeName.slice(0, 12) });
      });
    }
  };

  const commitNumber = ({ event, field, current, limits, update }) => {
    if (!dirtyRef.current[field]) return;
    const draft = event.currentTarget.value;
    const parsed = String(draft).trim() === "" ? Number.NaN : Number(draft);
    const fallback = Number.isFinite(current) ? current : limits.min;
    const next = Math.min(limits.max, Math.max(limits.min, Number.isFinite(parsed) ? parsed : fallback));
    event.currentTarget.value = String(next);
    dirtyRef.current[field] = false;
    if (next !== current) requestAnimationFrame(() => update(next));
  };

  const markDirty = (field) => {
    dirtyRef.current[field] = true;
  };

  const blurOnEnter = (event) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };

  const collectDirtyDraft = () => {
    const patch = {};
    if (dirtyRef.current.name) {
      const safeName = nameRef.current?.value.trim() || displayName(profile);
      if (nameRef.current) nameRef.current.value = safeName;
      dirtyRef.current.name = false;
      if (safeName !== profile.name || profile.short !== safeName.slice(0, 12)) {
        patch.name = safeName;
        patch.short = safeName.slice(0, 12);
      }
    }

    const collectNumber = (field, inputRef, current, limits, assign) => {
      if (!dirtyRef.current[field]) return;
      const draft = inputRef.current?.value ?? "";
      const parsed = String(draft).trim() === "" ? Number.NaN : Number(draft);
      const fallback = Number.isFinite(current) ? current : limits.min;
      const next = Math.min(limits.max, Math.max(limits.min, Number.isFinite(parsed) ? parsed : fallback));
      if (inputRef.current) inputRef.current.value = String(next);
      dirtyRef.current[field] = false;
      if (next !== current) assign(next);
    };

    if (profile.type === "irons") {
      collectNumber("elevationMOA", elevationRef, profile.elev.moaPerUnit, NUMBER_LIMITS.ironMOA, (moaPerUnit) => {
        patch.elev = { ...profile.elev, moaPerUnit };
      });
      collectNumber("windageMOA", windageRef, profile.wind.moaPerUnit, NUMBER_LIMITS.ironMOA, (moaPerUnit) => {
        patch.wind = { ...profile.wind, moaPerUnit };
      });
    } else {
      collectNumber("clickMOA", clickRef, profile.clickMOA, NUMBER_LIMITS.clickMOA, (clickMOA) => {
        patch.clickMOA = clickMOA;
      });
      collectNumber("travelMOA", travelRef, profile.travelMOA, NUMBER_LIMITS.travelMOA, (travelMOA) => {
        patch.travelMOA = travelMOA;
      });
    }
    return patch;
  };

  return (
    <Card id="optic-spec-editor" style={{ marginTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={{ gridColumn: "1 / -1", fontFamily: FONT_MONO, fontSize: 12 }}>
          Name
          <input
            ref={nameRef}
            defaultValue={displayName(profile)}
            maxLength={80}
            onChange={() => markDirty("name")}
            onBlur={commitName}
            onKeyDown={blurOnEnter}
            style={inputStyle}
          />
        </label>
        {profile.type === "irons" ? (
          <>
            <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              MOA per turn (front post)
              <input
                ref={elevationRef}
                type="number"
                step={NUMBER_LIMITS.ironMOA.step}
                min={NUMBER_LIMITS.ironMOA.min}
                max={NUMBER_LIMITS.ironMOA.max}
                inputMode="decimal"
                defaultValue={profile.elev?.moaPerUnit ?? ""}
                onChange={() => markDirty("elevationMOA")}
                onBlur={(event) => commitNumber({
                  event,
                  field: "elevationMOA",
                  current: profile.elev.moaPerUnit,
                  limits: NUMBER_LIMITS.ironMOA,
                  update: (moaPerUnit) => onUpdateProfile({
                    elev: { ...profile.elev, moaPerUnit },
                  }),
                })}
                onKeyDown={blurOnEnter}
                style={inputStyle}
              />
            </label>
            <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              MOA per mm of drift
              <input
                ref={windageRef}
                type="number"
                step={NUMBER_LIMITS.ironMOA.step}
                min={NUMBER_LIMITS.ironMOA.min}
                max={NUMBER_LIMITS.ironMOA.max}
                inputMode="decimal"
                defaultValue={profile.wind?.moaPerUnit ?? ""}
                onChange={() => markDirty("windageMOA")}
                onBlur={(event) => commitNumber({
                  event,
                  field: "windageMOA",
                  current: profile.wind.moaPerUnit,
                  limits: NUMBER_LIMITS.ironMOA,
                  update: (moaPerUnit) => onUpdateProfile({
                    wind: { ...profile.wind, moaPerUnit },
                  }),
                })}
                onKeyDown={blurOnEnter}
                style={inputStyle}
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
                ref={clickRef}
                type="number"
                step={NUMBER_LIMITS.clickMOA.step}
                min={NUMBER_LIMITS.clickMOA.min}
                max={NUMBER_LIMITS.clickMOA.max}
                inputMode="decimal"
                defaultValue={profile.clickMOA ?? ""}
                onChange={() => markDirty("clickMOA")}
                onBlur={(event) => commitNumber({
                  event,
                  field: "clickMOA",
                  current: profile.clickMOA,
                  limits: NUMBER_LIMITS.clickMOA,
                  update: (clickMOA) => onUpdateProfile({ clickMOA }),
                })}
                onKeyDown={blurOnEnter}
                style={inputStyle}
              />
            </label>
            <label style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              Total travel (MOA)
              <input
                ref={travelRef}
                type="number"
                step={NUMBER_LIMITS.travelMOA.step}
                min={NUMBER_LIMITS.travelMOA.min}
                max={NUMBER_LIMITS.travelMOA.max}
                inputMode="numeric"
                defaultValue={profile.travelMOA ?? ""}
                onChange={() => markDirty("travelMOA")}
                onBlur={(event) => commitNumber({
                  event,
                  field: "travelMOA",
                  current: profile.travelMOA,
                  limits: NUMBER_LIMITS.travelMOA,
                  update: (travelMOA) => onUpdateProfile({ travelMOA }),
                })}
                onKeyDown={blurOnEnter}
                style={inputStyle}
              />
            </label>
            {[
              { label: "Elevation screw", anchor: "UP", key: "elev" },
              { label: "Windage screw", anchor: "RIGHT", key: "wind" },
            ].map(({ label, anchor, key }) => {
              const selection = rotationSelection(profile.rot, anchor);
              return (
                <div key={key} style={{ gridColumn: "1 / -1" }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, marginBottom: 4 }}>{label}</div>
                  <div role="group" aria-label={`${label} direction`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {[["cw", `${anchor} = CW`], ["ccw", `${anchor} = CCW`], ["marked", "marked on turret"]].map(([value, text]) => (
                      <Chip
                        key={value}
                        active={selection === value}
                        onPointerDown={(event) => {
                          // Keep a dirty input focused until this activation
                          // completes; otherwise cloning a built-in optic on
                          // blur can reflow the selector under the pointer.
                          event.preventDefault();
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          const button = event.currentTarget;
                          const draftPatch = collectDirtyDraft();
                          if (selection !== value) {
                            draftPatch.rot = buildRotationMap(
                              key === "elev" ? value : rotationSelection(profile.rot, "UP"),
                              key === "wind" ? value : rotationSelection(profile.rot, "RIGHT")
                            );
                          }
                          if (Object.keys(draftPatch).length > 0) onUpdateProfile(draftPatch);
                          requestAnimationFrame(() => {
                            if (button.isConnected) button.focus();
                          });
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                          {value !== "marked" && <RotGlyph ccw={value === "ccw"} size={15} />}
                          {text}
                        </span>
                      </Chip>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{ gridColumn: "1 / -1", fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
              CW/CCW = which way the screw turns to move impact UP / RIGHT. Check your optic’s manual.
            </div>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
        {!profile.builtin && !deletePending && (
          <button
            ref={deleteRequestRef}
            type="button"
            className="utility-button"
            onClick={onRequestDelete}
            style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.red, background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }}
          >
            delete optic
          </button>
        )}
        {!profile.builtin && deletePending && (
          <div role="group" aria-label={`Confirm deletion of ${displayName(profile)}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              ref={deleteConfirmRef}
              type="button"
              className="utility-button"
              onClick={onDelete}
              style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.paper, background: C.red, border: `2px solid ${C.red}`, borderRadius: 3, cursor: "pointer" }}
            >
              confirm delete
            </button>
            <button
              type="button"
              className="utility-button"
              onClick={onCancelDelete}
              style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.ink, background: C.card, border: `2px solid ${C.ink}`, borderRadius: 3, cursor: "pointer" }}
            >
              cancel
            </button>
          </div>
        )}
        <button
          type="button"
          className="utility-button"
          onClick={onResetPresets}
          style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.inkSoft, background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }}
        >
          restore preset specs
        </button>
      </div>
    </Card>
  );
}

export default function OpticPanel({
  profiles,
  activeId,
  profile,
  maxProfiles,
  editorSession,
  editing,
  deletePending,
  opticSelectorRef,
  deleteRequestRef,
  deleteConfirmRef,
  onSwitchOptic,
  onAddCustom,
  onToggleEditing,
  onUpdateProfile,
  onRequestDelete,
  onDelete,
  onCancelDelete,
  onResetPresets,
}) {
  return (
    <section aria-labelledby="optic-heading">
      <Label id="optic-heading">Optic</Label>
      <div ref={opticSelectorRef} role="group" aria-labelledby="optic-heading" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {profiles.map((candidate) => {
          const shortName = displayShortName(candidate);
          return (
            <Chip
              key={candidate.id}
              data-optic-id={candidate.id}
              active={candidate.id === activeId}
              onClick={() => onSwitchOptic(candidate.id)}
              aria-label={String(candidate.short ?? "").trim() ? undefined : shortName}
            >
              {shortName}
            </Chip>
          );
        })}
        <Chip onClick={onAddCustom} disabled={profiles.length >= maxProfiles} aria-label="Add custom optic">+ add</Chip>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft }}>
          {displayName(profile)} ·{" "}
          <b style={{ color: C.ink }}>
            {profile.type === "irons"
              ? `${profile.elev.moaPerUnit} MOA/turn · ${profile.wind.moaPerUnit} MOA/mm`
              : `${profile.clickMOA} MOA/click`}
          </b>
        </span>
        <button
          type="button"
          className="utility-button"
          aria-expanded={editing}
          aria-controls="optic-spec-editor"
          onClick={onToggleEditing}
          style={{ fontFamily: FONT_MONO, fontSize: 13, border: "none", background: "none", color: C.red, textDecoration: "underline", cursor: "pointer" }}
        >
          {editing ? "close" : "edit specs"}
        </button>
      </div>

      {editing && (
        <ProfileEditor
          key={editorSession}
          profile={profile}
          deletePending={deletePending}
          deleteRequestRef={deleteRequestRef}
          deleteConfirmRef={deleteConfirmRef}
          onUpdateProfile={onUpdateProfile}
          onRequestDelete={onRequestDelete}
          onDelete={onDelete}
          onCancelDelete={onCancelDelete}
          onResetPresets={onResetPresets}
        />
      )}
    </section>
  );
}
