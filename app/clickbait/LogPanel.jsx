import { C, Card, FONT_MONO, Label } from "./ui";

export default function LogPanel({
  log,
  clearPending,
  headingRef,
  clearRequestRef,
  clearConfirmRef,
  onRequestClear,
  onClear,
  onCancelClear,
}) {
  return (
    <section id="panel-log" role="tabpanel" aria-labelledby="tab-log" tabIndex={0}>
      <Label id="log-heading" ref={headingRef} tabIndex={-1}>Adjustment history</Label>
      {log.length === 0 ? (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, color: C.inkSoft }}>
            Nothing stamped yet. After you dial an adjustment on the Zero tab, stamp it here so you know where every sight stands.
          </div>
        </Card>
      ) : (
        <>
          {log.map((entry, index) => (
            <Card
              key={entry.id || `${entry.ts}-${index}`}
              role="article"
              aria-label={`Adjustment for ${entry.optic} at ${entry.dist}`}
              style={{ marginBottom: 8, padding: "10px 12px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 14 }}>{entry.optic} · {entry.dist}</span>
                <time dateTime={new Date(entry.ts).toISOString()} style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.inkSoft }}>
                  {new Date(entry.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </time>
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 13.5, marginTop: 4 }}>
                ELEV <b style={{ color: C.red }}>{entry.e}</b> · WIND <b style={{ color: C.red }}>{entry.w}</b>
                {entry.grp && <span style={{ color: C.inkSoft }}> · group {entry.grp}</span>}
                {entry.one && <span style={{ color: C.inkSoft }}> · one-shot</span>}
              </div>
            </Card>
          ))}
          {!clearPending ? (
            <button
              ref={clearRequestRef}
              type="button"
              className="utility-button"
              onClick={onRequestClear}
              style={{ marginTop: 4, fontFamily: FONT_MONO, fontSize: 13, color: C.red, background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }}
            >
              clear log
            </button>
          ) : (
            <div role="group" aria-label="Confirm clearing the dope log" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <button
                ref={clearConfirmRef}
                type="button"
                className="utility-button"
                onClick={onClear}
                style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.paper, background: C.red, border: `2px solid ${C.red}`, borderRadius: 3, cursor: "pointer" }}
              >
                confirm clear log
              </button>
              <button
                type="button"
                className="utility-button"
                onClick={onCancelClear}
                style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.ink, background: C.card, border: `2px solid ${C.ink}`, borderRadius: 3, cursor: "pointer" }}
              >
                cancel
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
