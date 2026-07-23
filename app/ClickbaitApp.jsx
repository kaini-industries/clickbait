"use client";

import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import AppTabs from "./clickbait/AppTabs";
import CenterPanel from "./clickbait/CenterPanel";
import LogPanel from "./clickbait/LogPanel";
import OpticPanel from "./clickbait/OpticPanel";
import ZeroPanel, { describeAdjustmentForSpeech } from "./clickbait/ZeroPanel";
import { C, FONT_HEAD, FONT_MONO, fmt, fmtUnits } from "./clickbait/ui";
import {
  COLLECTION_LIMITS,
  UNIT_SYSTEMS,
  appendBounded,
  calculateAdjustment,
  extremeSpread,
  getMechanicalCenterGuidance,
  groupCenter,
  validateManualOffsets,
} from "../lib/domain.mjs";
import {
  LEGACY_STORAGE_KEYS,
  MAX_COUNTER_CLICKS,
  STORAGE_KEY,
  commitCounterSession,
  commitFactoryReset,
  commitLogAppend,
  commitPersistedPatch,
  commitProfileClone,
  commitProfileDelete,
  commitProfileUpsert,
  commitProfilesReset,
  createPersistenceDefaults,
  createVersionedPayload,
  getCounterSession,
  loadPersistedPayload,
  mergePersistedPayloads,
  parsePersistedPayload,
  savePersistedPayload,
} from "../lib/persistence.mjs";

/* ============================================================
   CLICKBAIT — sight-in & turret assistant
   Design: range data-book on graph paper. Signature element:
   the interactive Shoot-N-C-style splatter target.
   Palette: paper #F4F4EC · grid #C9D2C4 · ink #161914
            splatter #C8F51F · stamp red #C3271B · black face #131311
   ============================================================ */

const MAX_SHOTS = COLLECTION_LIMITS.shots;
const MAX_GHOSTS = COLLECTION_LIMITS.ghosts;
const MAX_PROFILES = COLLECTION_LIMITS.profiles;
const TAB_IDS = ["zero", "center", "log"];
const COORDINATION_DB = "clickbait-coordination";
const COORDINATION_STORE = "locks";

class LockedOperationError extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : "The saved-data operation failed.", { cause });
    this.name = "LockedOperationError";
  }
}

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
    // Primary Arms' Gen III manual specifies clockwise for POI UP/RIGHT.
    rot: { UP: "clockwise", DOWN: "counter-clockwise", RIGHT: "clockwise", LEFT: "counter-clockwise" },
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

const UNITS = {
  imp: {
    lin: UNIT_SYSTEMS.imp.linearUnit,
    dist: UNIT_SYSTEMS.imp.distanceUnit,
    distances: UNIT_SYSTEMS.imp.distances,
    spans: UNIT_SYSTEMS.imp.spans,
    gridStep: UNIT_SYSTEMS.imp.gridSteps,
  },
  met: {
    lin: UNIT_SYSTEMS.met.linearUnit,
    dist: UNIT_SYSTEMS.met.distanceUnit,
    distances: UNIT_SYSTEMS.met.distances,
    spans: UNIT_SYSTEMS.met.spans,
    gridStep: UNIT_SYSTEMS.met.gridSteps,
  },
};

const PERSISTENCE_DEFAULTS = createPersistenceDefaults({ profiles: PRESET_PROFILES });

const calculationProfileSignature = (profile) => JSON.stringify(profile ? {
  id: profile.id,
  type: profile.type ?? "turret",
  clickMOA: profile.clickMOA,
  travelMOA: profile.travelMOA,
  elev: profile.elev,
  wind: profile.wind,
  rot: profile.rot,
} : null);

const removeLegacyCopies = () => {
  try {
    LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    return true;
  } catch {
    // The current v2 write already succeeded; a blocked legacy cleanup must
    // not take down the calculator or invalidate the new copy.
    return false;
  }
};

const resetSavedStorage = () => {
  const options = {
    defaults: PERSISTENCE_DEFAULTS,
    presets: PRESET_PROFILES,
    writerId: `factory-reset-${crypto.randomUUID()}`,
    now: Date.now(),
  };
  const restored = loadPersistedPayload(localStorage, options);
  const current = restored.payload ?? createVersionedPayload(PERSISTENCE_DEFAULTS, options);
  const reset = commitFactoryReset(current, options);
  try {
    // Notify other open tabs before immediately replacing the key with the
    // authoritative reset generation.
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error("Saved data could not be removed."),
    };
  }
  const saved = savePersistedPayload(localStorage, reset);
  if (saved.ok) removeLegacyCopies();
  return saved;
};

// IndexedDB read/write transactions with an overlapping object-store scope are
// serialized across tabs. This supplies the same origin-wide critical section
// on browsers that do not expose the Web Locks API.
const runWithIndexedDbLock = (operation) => new Promise((resolve, reject) => {
  if (!("indexedDB" in window)) {
    reject(new Error("This browser has no cross-tab locking API."));
    return;
  }
  let settled = false;

  const fail = (error) => {
    if (settled) return;
    settled = true;
    reject(error instanceof Error ? error : new Error("Cross-tab coordination failed."));
  };

  const openDatabase = (version) => {
    let abandoned = false;
    let openRequest;
    try {
      openRequest = version === undefined
        ? indexedDB.open(COORDINATION_DB)
        : indexedDB.open(COORDINATION_DB, version);
    } catch (error) {
      fail(error);
      return;
    }

    openRequest.onupgradeneeded = () => {
      try {
        const database = openRequest.result;
        if (!database.objectStoreNames.contains(COORDINATION_STORE)) {
          database.createObjectStore(COORDINATION_STORE);
        }
      } catch (error) {
        openRequest.transaction?.abort();
        fail(error);
      }
    };
    openRequest.onerror = () => fail(openRequest.error ?? new Error("Could not open the coordination database."));
    openRequest.onblocked = () => {
      abandoned = true;
      fail(new Error("The coordination database is blocked by another tab."));
    };
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      if (abandoned || settled) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();

      // Repair databases created by an older or interrupted build without the
      // coordination store. Opening at the next version makes the repair work
      // regardless of the malformed database's current version.
      if (!database.objectStoreNames.contains(COORDINATION_STORE)) {
        const repairVersion = database.version + 1;
        database.close();
        openDatabase(repairVersion);
        return;
      }

      let result;
      let operationError = null;
      let transaction;
      try {
        transaction = database.transaction(COORDINATION_STORE, "readwrite");
        const claim = transaction.objectStore(COORDINATION_STORE).put(Date.now(), "persistence");
        claim.onsuccess = () => {
          try {
            result = operation();
          } catch (error) {
            operationError = error;
            transaction.abort();
          }
        };
      } catch (error) {
        database.close();
        fail(error);
        return;
      }
      transaction.oncomplete = () => {
        database.close();
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onabort = () => {
        database.close();
        fail(operationError
          ? new LockedOperationError(operationError)
          : transaction.error ?? new Error("The coordination transaction was aborted."));
      };
      transaction.onerror = () => {
        // The abort handler reports the final transaction error once.
      };
    };
  };

  openDatabase();
});

/* ============================================================ */

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, resetError: "" };
    this.headingRef = React.createRef();
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidMount() {
    if (this.state.hasError) this.headingRef.current?.focus();
  }
  componentDidUpdate(previousProps, previousState) {
    if (this.state.hasError && !previousState.hasError) this.headingRef.current?.focus();
  }
  render() {
    if (this.state.hasError) {
      return (
        <main
          aria-labelledby="fatal-error-title"
          aria-live="assertive"
          aria-atomic="true"
          style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.paper, color: C.ink, fontFamily: FONT_MONO, padding: 20, textAlign: "center" }}
        >
          <h1 id="fatal-error-title" ref={this.headingRef} tabIndex={-1} style={{ fontFamily: FONT_HEAD, fontSize: 28, margin: "0 0 8px" }}>
            Clickbait hit an unexpected error
          </h1>
          <p style={{ maxWidth: 520, margin: "0 0 16px", lineHeight: 1.6 }}>
            Reload first; your saved optics and dope log will be kept. Only reset saved data if the error returns.
          </p>
          {this.state.resetError && (
            <p role="alert" style={{ maxWidth: 520, margin: "0 0 16px", color: C.red, fontWeight: 600 }}>
              {this.state.resetError}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ minHeight: 44, fontFamily: FONT_MONO, fontSize: 16, padding: "12px 20px", border: `2px solid ${C.ink}`, borderRadius: 4, background: C.ink, color: C.paper, cursor: "pointer" }}
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm("Delete all saved optics and dope-log entries? This cannot be undone.")) return;
                const reset = resetSavedStorage();
                if (!reset.ok) {
                  this.setState({
                    resetError: `Saved data could not be reset: ${reset.error.message}`,
                  });
                  return;
                }
                window.location.reload();
              }}
              style={{ minHeight: 44, fontFamily: FONT_MONO, fontSize: 16, padding: "12px 20px", border: `2px solid ${C.red}`, borderRadius: 4, background: C.card, color: C.red, cursor: "pointer" }}
            >
              Reset saved data
            </button>
          </div>
        </main>
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
  const [editorSession, setEditorSession] = useState(0);
  const [counterSessions, setCounterSessions] = useState({});
  const [counterTurret, setCounterTurret] = useState("ELEVATION");
  const [statusMessage, setStatusMessage] = useState("");
  const [persistenceWarning, setPersistenceWarning] = useState("");
  const [clearLogPending, setClearLogPending] = useState(false);
  const [deleteCandidateId, setDeleteCandidateId] = useState(null);
  const [zeroSession, setZeroSession] = useState(0);
  const [centerSession, setCenterSession] = useState(0);
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);
  const writerIdRef = useRef("");
  const persistenceEnvelopeRef = useRef(null);
  const persistenceDisabledRef = useRef(false);
  const primaryStorageExpectedRef = useRef(false);
  const pendingPatchRef = useRef({});
  const pendingPatchUnitsRef = useRef(null);
  const targetRef = useRef(null);
  const manualVerticalRef = useRef(null);
  const opticSelectorRef = useRef(null);
  const logHeadingRef = useRef(null);
  const deleteRequestRef = useRef(null);
  const deleteConfirmRef = useRef(null);
  const clearLogRequestRef = useRef(null);
  const clearLogConfirmRef = useRef(null);
  const tabRefs = useRef({});
  const reconciliationFocusRef = useRef(null);

  // Storage events often arrive while this page is a background mobile tab,
  // where requestAnimationFrame can be suspended. Resolve focus after React
  // has committed the reconciled DOM instead of relying on a frame callback.
  useEffect(() => {
    const request = reconciliationFocusRef.current;
    if (!request) return;
    let target = null;
    if (request.type === "entry") {
      target = request.entryMode === "tap" ? targetRef.current : manualVerticalRef.current;
    } else if (request.type === "optic") {
      target = Array.from(opticSelectorRef.current?.querySelectorAll("[data-optic-id]") ?? [])
        .find((candidate) => candidate.dataset.opticId === request.activeId) ?? null;
    } else if (request.type === "center") {
      target = document.getElementById("panel-center");
    } else if (request.type === "delete") {
      target = deleteRequestRef.current;
    } else if (request.type === "log") {
      target = logHeadingRef.current;
    }
    if (!target) return;
    reconciliationFocusRef.current = null;
    target.focus();
  }, [
    activeId,
    clearLogPending,
    deleteCandidateId,
    distance,
    editing,
    entryMode,
    log,
    mode,
    profiles,
    shots,
    span,
    tab,
    units,
    zeroSession,
    centerSession,
  ]);

  const clearTransientEntry = useCallback(() => {
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  }, []);

  const applyPersistedData = useCallback((data) => {
    setProfiles(data.profiles);
    setActiveId(data.activeId);
    setUnits(data.units);
    setDistance(data.distance);
    setSpan(data.span);
    setLog(data.log);
    setMode(data.mode);
    setEntryMode(data.entryMode);
    setCounterSessions(data.counters);
  }, []);

  const applyFactoryResetUi = useCallback((data) => {
    applyPersistedData(data);
    clearTransientEntry();
    setEditing(false);
    setEditorSession((session) => session + 1);
    setDeleteCandidateId(null);
    setClearLogPending(false);
    setCounterTurret("ELEVATION");
    setZeroSession((session) => session + 1);
    setCenterSession((session) => session + 1);
  }, [applyPersistedData, clearTransientEntry]);

  const persistenceOptions = useCallback((now = Date.now()) => ({
    defaults: PERSISTENCE_DEFAULTS,
    presets: PRESET_PROFILES,
    writerId: writerIdRef.current || "clickbait-tab",
    now,
  }), []);

  const saveEnvelope = useCallback((envelope, { silent = false } = {}) => {
    if (persistenceDisabledRef.current) {
      setPersistenceWarning("Saved data is unavailable or belongs to a newer app version. Changes on this screen are not being saved.");
      if (!silent) setStatusMessage("Changes are temporary because saved data is unavailable or from a newer app version.");
      return false;
    }
    const saved = savePersistedPayload(localStorage, envelope);
    if (!saved.ok) {
      const warning = `Could not save range data: ${saved.error.message} Changes on this screen are not being saved.`;
      setPersistenceWarning(warning);
      if (!silent) setStatusMessage(`${warning} Your current screen remains usable.`);
    } else {
      primaryStorageExpectedRef.current = true;
      setPersistenceWarning("");
    }
    return saved.ok;
  }, []);

  const readLatestBeforeWrite = useCallback(({ silent = false } = {}) => {
    const current = persistenceEnvelopeRef.current;
    if (!current) return { payload: null, canWrite: false, notice: "" };
    const latest = loadPersistedPayload(localStorage, persistenceOptions());
    if (!latest.canSave || !latest.payload) {
      persistenceDisabledRef.current = true;
      const issue = latest.issues[0]?.message ?? "Saved data could not be read safely.";
      setPersistenceWarning(`${issue} Changes on this screen are not being saved.`);
      if (!silent) setStatusMessage(`${issue} This change remains available only on the current screen.`);
      return { payload: current, canWrite: false, notice: "" };
    }

    // The tab that calls localStorage.clear()/removeItem() receives no storage
    // event. Once this session has successfully persisted data, a missing
    // primary key therefore means an explicit reset, not a blank initial load.
    let primaryKeyMissing = false;
    try {
      primaryKeyMissing = primaryStorageExpectedRef.current
        && localStorage.getItem(STORAGE_KEY) === null;
    } catch {
      // loadPersistedPayload already reports inaccessible storage above.
    }
    if (primaryKeyMissing) {
      const reset = commitFactoryReset(current, persistenceOptions());
      persistenceEnvelopeRef.current = reset;
      persistenceDisabledRef.current = false;
      reconciliationFocusRef.current = { type: "optic", activeId: reset.data.activeId };
      applyFactoryResetUi(reset.data);
      const saved = saveEnvelope(reset, { silent });
      return {
        payload: reset,
        canWrite: saved,
        notice: "Saved range data was reset before this change was applied.",
        factoryReset: true,
      };
    }

    persistenceDisabledRef.current = false;
    const merged = mergePersistedPayloads(current, latest.payload, {
      defaults: PERSISTENCE_DEFAULTS,
      presets: PRESET_PROFILES,
    });
    persistenceEnvelopeRef.current = merged;
    const notice = latest.status === "recovered"
      ? (latest.issues[0]?.message ?? "Invalid saved fields were restored safely.")
      : latest.status === "migrated"
        ? "Legacy saved data was merged and upgraded."
        : "";
    return { payload: merged, canWrite: true, notice };
  }, [applyFactoryResetUi, persistenceOptions, saveEnvelope]);

  const commitPatchNow = useCallback((patch, { successMessage = "", silent = false } = {}) => {
    const current = persistenceEnvelopeRef.current;
    if (!current) return { payload: null, saved: false };
    clearTimeout(saveTimer.current);
    let pendingPatch = { ...pendingPatchRef.current };
    let pendingUnits = pendingPatchUnitsRef.current;
    pendingPatchRef.current = {};
    pendingPatchUnitsRef.current = null;
    const latest = readLatestBeforeWrite({ silent });
    const base = latest.payload ?? current;
    // A factory reset is authoritative over drafts queued before the key was
    // removed. Preserve only the explicit edit that triggered this write.
    if (latest.factoryReset) {
      pendingPatch = {};
      pendingUnits = null;
    }
    const contextChanged = pendingUnits && base.data.units !== pendingUnits;
    if (contextChanged) {
      delete pendingPatch.distance;
      delete pendingPatch.span;
    }
    const combinedPatch = { ...pendingPatch, ...patch };
    if (Object.keys(combinedPatch).length === 0) {
      persistenceEnvelopeRef.current = base;
      applyPersistedData(base.data);
      if (contextChanged && !silent) {
        setStatusMessage("A pending distance or target-width edit was discarded because another tab changed the unit system.");
      } else if (latest.notice && !silent) {
        setStatusMessage(latest.notice);
      }
      return { payload: base, saved: false };
    }
    const next = commitPersistedPatch(base, combinedPatch, persistenceOptions());
    persistenceEnvelopeRef.current = next;
    applyPersistedData(next.data);
    if (!latest.canWrite) return { payload: next, saved: false };
    const saved = saveEnvelope(next, { silent });
    const contextNotice = contextChanged
      ? "A pending distance or target-width edit was discarded because another tab changed the unit system."
      : "";
    const completedMessage = [successMessage, latest.notice, contextNotice].filter(Boolean).join(" ");
    if (saved && completedMessage) setStatusMessage(completedMessage);
    return { payload: next, saved };
  }, [applyPersistedData, persistenceOptions, readLatestBeforeWrite, saveEnvelope]);

  const flushPending = useCallback(({ silent = false } = {}) => {
    const current = persistenceEnvelopeRef.current;
    if (!current || !loadedRef.current) return current;
    if (Object.keys(pendingPatchRef.current).length === 0) return current;
    return commitPatchNow({}, { silent }).payload;
  }, [commitPatchNow]);

  const commitAtomicNow = useCallback((operation, { successMessage = "", silent = false } = {}) => {
    const current = flushPending({ silent: true }) ?? persistenceEnvelopeRef.current;
    if (!current) return { payload: null, saved: false };
    const latest = readLatestBeforeWrite({ silent });
    const base = latest.payload ?? current;
    let next;
    try {
      next = operation(base, persistenceOptions());
    } catch (error) {
      if (!silent) {
        const detail = error instanceof Error ? error.message : "The requested change was invalid.";
        setStatusMessage(`Could not update saved range data: ${detail}`);
      }
      return { payload: base, saved: false };
    }
    if (next === base) {
      persistenceEnvelopeRef.current = base;
      applyPersistedData(base.data);
      return { payload: base, saved: false };
    }
    persistenceEnvelopeRef.current = next;
    applyPersistedData(next.data);
    if (!latest.canWrite) return { payload: next, saved: false };
    const saved = saveEnvelope(next, { silent });
    const completedMessage = [successMessage, latest.notice].filter(Boolean).join(" ");
    if (saved && completedMessage) setStatusMessage(completedMessage);
    return { payload: next, saved };
  }, [applyPersistedData, flushPending, persistenceOptions, readLatestBeforeWrite, saveEnvelope]);

  const runWithPersistenceLock = useCallback((operation, onComplete) => {
    const execute = () => {
      const result = operation();
      onComplete?.(result);
      return result;
    };
    if (navigator.locks?.request) {
      void navigator.locks
        .request("clickbait-persistence", { mode: "exclusive" }, execute)
        .catch((error) => {
          const detail = error instanceof Error ? error.message : "Cross-tab coordination was unavailable.";
          setStatusMessage(`Could not coordinate the saved-data update: ${detail}`);
        });
      return null;
    }
    void runWithIndexedDbLock(execute).catch((error) => {
      if (error instanceof LockedOperationError) {
        setStatusMessage(`Could not complete the saved-data update: ${error.message}`);
        return;
      }
      const detail = error instanceof Error ? error.message : "Cross-tab coordination was unavailable.";
      setStatusMessage(`Cross-tab coordination is unavailable; applying this update locally. ${detail}`);
      execute();
    });
    return null;
  }, []);

  const runAtomicTransaction = useCallback((operation, options = {}, onComplete) => (
    runWithPersistenceLock(
      () => commitAtomicNow(operation, options),
      onComplete,
    )
  ), [commitAtomicNow, runWithPersistenceLock]);

  const runPatchTransaction = useCallback((patch, options = {}, onComplete) => (
    runWithPersistenceLock(
      () => commitPatchNow(patch, options),
      onComplete,
    )
  ), [commitPatchNow, runWithPersistenceLock]);

  const queuePersistedEdit = useCallback((patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, "distance")) setDistance(patch.distance);
    if (Object.prototype.hasOwnProperty.call(patch, "span")) setSpan(patch.span);
    let primaryKeyMissing = false;
    try {
      primaryKeyMissing = primaryStorageExpectedRef.current
        && localStorage.getItem(STORAGE_KEY) === null;
    } catch {
      // The normal write path will surface inaccessible storage.
    }
    if (primaryKeyMissing) {
      // This edit happened after the reset, so make it the explicit trigger
      // rather than putting it in the pre-reset draft bucket. Preserve the
      // unit context visible to the user and reset the companion measurement
      // to that unit system's default.
      runPatchTransaction({
        units,
        distance: Object.prototype.hasOwnProperty.call(patch, "distance")
          ? patch.distance
          : UNITS[units].distances[2],
        span: Object.prototype.hasOwnProperty.call(patch, "span")
          ? patch.span
          : UNITS[units].spans[1],
      });
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "distance")
      || Object.prototype.hasOwnProperty.call(patch, "span")
    ) {
      pendingPatchUnitsRef.current = units;
    }
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      runWithPersistenceLock(() => flushPending());
    }, 400);
  }, [flushPending, runPatchTransaction, runWithPersistenceLock, units]);

  /* ----- persistence ----- */
  /* eslint-disable react-hooks/set-state-in-effect -- localStorage is client-only; the loading gate keeps this hydration pass from flashing default data. */
  useEffect(() => {
    writerIdRef.current = crypto.randomUUID();
    const options = persistenceOptions();
    const restored = loadPersistedPayload(localStorage, options);
    const envelope = restored.payload ?? createVersionedPayload(PERSISTENCE_DEFAULTS, options);
    persistenceEnvelopeRef.current = envelope;
    persistenceDisabledRef.current = !restored.canSave;
    try {
      primaryStorageExpectedRef.current = localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      primaryStorageExpectedRef.current = false;
    }
    if (!restored.canSave) {
      const issue = restored.issues[0]?.message ?? "Saved data is unavailable.";
      setPersistenceWarning(`${issue} Changes on this screen are not being saved.`);
    }
    applyPersistedData(envelope.data);

    if (restored.status === "migrated" && restored.canSave) {
      const saved = savePersistedPayload(localStorage, envelope);
      if (saved.ok) {
        primaryStorageExpectedRef.current = true;
        removeLegacyCopies();
        const recoveredFields = restored.issues.some((issue) => issue.code !== "migrated");
        setStatusMessage(recoveredFields
          ? "Saved range data was upgraded; invalid legacy fields were restored safely."
          : "Saved range data was upgraded to the current format.");
      } else {
        setPersistenceWarning(`Could not save upgraded range data: ${saved.error.message}`);
        setStatusMessage(`Saved data was upgraded in memory but could not be written: ${saved.error.message}`);
      }
    } else if (restored.status === "unsupported-version") {
      setStatusMessage(restored.issues[0]?.message ?? "Saved data is from a newer app version; changes will be temporary.");
    } else if (restored.status === "recovered") {
      const detail = restored.issues[0]?.message ?? "Some saved data was invalid and safe values were restored.";
      setStatusMessage(restored.canSave ? detail : `${detail} Changes will remain temporary.`);
    }

    loadedRef.current = true;
    setLoaded(true);
  }, [applyPersistedData, persistenceOptions]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const handlePageHide = () => flushPending({ silent: true });
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flushPending();
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearTimeout(saveTimer.current);
    };
  }, [flushPending]);

  useEffect(() => {
    if (!loaded) return undefined;
    const handleStorage = (event) => {
      const clearedAllStorage = event.key === null && event.newValue == null;
      if (!clearedAllStorage && ![STORAGE_KEY, ...LEGACY_STORAGE_KEYS].includes(event.key)) return;
      // Removing the primary key is an explicit reset. Turn it into a versioned
      // reset commit so stale tabs cannot later resurrect deleted profiles/logs.
      // Legacy-key cleanup, by contrast, must remain a no-op.
      if (event.newValue == null) {
        if (event.key !== STORAGE_KEY && !clearedAllStorage) return;
        const current = persistenceEnvelopeRef.current;
        if (!current) return;
        clearTimeout(saveTimer.current);
        pendingPatchRef.current = {};
        pendingPatchUnitsRef.current = null;
        const reset = commitFactoryReset(current, persistenceOptions());
        persistenceEnvelopeRef.current = reset;
        persistenceDisabledRef.current = false;
        applyFactoryResetUi(reset.data);
        reconciliationFocusRef.current = { type: "optic", activeId: reset.data.activeId };
        const saved = saveEnvelope(reset);
        setStatusMessage(saved
          ? "Saved range data was reset in another tab. Defaults were restored here too."
          : "Saved range data was reset in another tab, but the reset could not be written from this tab.");
        return;
      }
      const incoming = parsePersistedPayload(event.newValue, persistenceOptions());
      if (!incoming.payload) {
        persistenceDisabledRef.current = true;
        const warning = incoming.issues[0]?.message ?? "Another tab saved data from a newer app version; local saving is paused.";
        setPersistenceWarning(`${warning} Changes on this screen are not being saved.`);
        setStatusMessage(warning);
        return;
      }
      const persistedBeforeFlush = persistenceEnvelopeRef.current?.data;
      // React state already includes debounced distance/span drafts. Compare
      // reconciliation against that effective calculation context so flushing
      // our own draft cannot masquerade as a change from another tab.
      const previousDataBeforeFlush = persistedBeforeFlush ? {
        ...persistedBeforeFlush,
        profiles,
        activeId,
        units,
        distance,
        span,
        log,
        mode,
        entryMode,
        counters: counterSessions,
      } : null;
      const entryControlHadFocus = document.activeElement === targetRef.current
        || document.activeElement === manualVerticalRef.current
        || ["vertical-offset", "horizontal-offset"].includes(document.activeElement?.id);
      const transientEntryActionHadFocus = entryControlHadFocus
        || document.activeElement?.id === "stamp-adjustment";
      const logActionHadFocus = document.activeElement === clearLogRequestRef.current
        || document.getElementById("panel-log")
          ?.querySelector('[aria-label="Confirm clearing the dope log"]')
          ?.contains(document.activeElement);
      const opticSelectorHadFocus = opticSelectorRef.current?.contains(document.activeElement);
      const centerPanelHadFocus = document.getElementById("panel-center")?.contains(document.activeElement);
      const centerResetConfirmationHadFocus = document.getElementById("panel-center")
        ?.querySelector('[aria-label^="Confirm resetting the "]')
        ?.contains(document.activeElement);
      const deleteConfirmationHadFocus = document.activeElement === deleteConfirmRef.current
        || document.getElementById("optic-spec-editor")
          ?.querySelector('[aria-label^="Confirm deletion of"]')
          ?.contains(document.activeElement);
      const editorHadFocus = document
        .getElementById("optic-spec-editor")
        ?.contains(document.activeElement);
      const local = flushPending({ silent: true }) ?? persistenceEnvelopeRef.current;
      if (!local) return;
      const merged = mergePersistedPayloads(local, incoming.payload, {
        defaults: PERSISTENCE_DEFAULTS,
        presets: PRESET_PROFILES,
      });
      persistenceEnvelopeRef.current = merged;
      const latest = readLatestBeforeWrite();
      const reconciled = latest.payload ?? merged;
      const previousData = previousDataBeforeFlush ?? local.data;
      const nextData = reconciled.data;
      const previousProfile = previousData.profiles.find((profile) => profile.id === previousData.activeId);
      const nextProfile = nextData.profiles.find((profile) => profile.id === nextData.activeId);
      const activeProfileChanged = JSON.stringify(previousProfile) !== JSON.stringify(nextProfile);
      const calculationProfileChanged = calculationProfileSignature(previousProfile)
        !== calculationProfileSignature(nextProfile);
      const calculationContextChanged = calculationProfileChanged
        || previousData.activeId !== nextData.activeId
        || previousData.units !== nextData.units
        || previousData.distance !== nextData.distance
        || previousData.span !== nextData.span
        || previousData.mode !== nextData.mode
        || previousData.entryMode !== nextData.entryMode;
      applyPersistedData(reconciled.data);
      if (calculationContextChanged) clearTransientEntry();
      if (calculationContextChanged && transientEntryActionHadFocus) {
        reconciliationFocusRef.current = { type: "entry", entryMode: nextData.entryMode };
      }
      if (nextData.log.length === 0) {
        setClearLogPending(false);
        if (previousData.log.length > 0 && logActionHadFocus) {
          reconciliationFocusRef.current = { type: "log" };
        }
      }
      if (activeProfileChanged) setDeleteCandidateId(null);
      if (
        previousData.activeId !== nextData.activeId
        || previousProfile?.type !== nextProfile?.type
      ) {
        setCounterTurret("ELEVATION");
        setEditing(false);
        setDeleteCandidateId(null);
        setEditorSession((current) => current + 1);
        if (editorHadFocus || opticSelectorHadFocus) {
          reconciliationFocusRef.current = { type: "optic", activeId: nextData.activeId };
        } else if (
          centerPanelHadFocus
          && (previousProfile?.type !== nextProfile?.type || centerResetConfirmationHadFocus)
        ) {
          reconciliationFocusRef.current = { type: "center" };
        }
      } else if (activeProfileChanged && deleteConfirmationHadFocus) {
        reconciliationFocusRef.current = { type: "delete" };
      }
      const saved = latest.canWrite && saveEnvelope(reconciled);
      if (saved) {
        if (event.key !== STORAGE_KEY) removeLegacyCopies();
        const recovered = incoming.status === "recovered" || Boolean(latest.notice);
        const mergeMessage = recovered
          ? "Changes from another tab were merged; invalid saved fields were restored safely."
          : "Changes from another tab were merged.";
        setStatusMessage(calculationContextChanged
          ? `${mergeMessage} The in-progress shot entry was cleared because its calculation settings changed.`
          : mergeMessage);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [
    activeId,
    applyFactoryResetUi,
    applyPersistedData,
    clearTransientEntry,
    counterSessions,
    distance,
    entryMode,
    flushPending,
    loaded,
    log,
    mode,
    persistenceOptions,
    profiles,
    readLatestBeforeWrite,
    saveEnvelope,
    span,
    units,
  ]);

  const handleTargetTap = useCallback(
    (pt) => {
      if (mode === "group" && shots.length >= MAX_SHOTS) {
        setStatusMessage(`Group is limited to ${MAX_SHOTS} marked shots. Undo or clear a shot to continue.`);
        return;
      }
      setShots((current) => (mode === "one" ? [pt] : appendBounded(current, pt, MAX_SHOTS)));
      const nextShotCount = shots.length + 1;
      setStatusMessage(mode === "one"
        ? "Shot marked. Dialing instructions updated."
        : nextShotCount < 3
          ? `Shot ${nextShotCount} marked. Mark ${3 - nextShotCount} more before dialing from the group center.`
          : `Shot ${nextShotCount} marked. Group dialing instructions updated.`);
    },
    [mode, shots.length]
  );

  const focusEntryControl = useCallback(() => {
    requestAnimationFrame(() => {
      (entryMode === "tap" ? targetRef.current : manualVerticalRef.current)?.focus();
    });
  }, [entryMode]);

  const switchMode = (m) => {
    if (m === mode) return;
    runPatchTransaction({ mode: m }, {
      successMessage: m === "one" ? "One-shot walk-in mode selected." : "Group mode selected.",
    });
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  const switchEntryMode = (nextMode) => {
    if (nextMode === entryMode) return;
    runPatchTransaction({ entryMode: nextMode }, {
      successMessage: nextMode === "tap" ? "Target coordinate entry selected." : "Measured offset entry selected.",
    });
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  const switchOptic = (id) => {
    if (id === activeId) return;
    setCounterTurret("ELEVATION");
    const restoredCounter = getCounterSession(counterSessions, id, "ELEVATION");
    runPatchTransaction({ activeId: id }, {
      successMessage: `Optic changed. Saved elevation count restored at ${restoredCounter.count} clicks.`,
    });
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
    setDeleteCandidateId(null);
  };

  const U = UNITS[units];
  const profile = profiles.find((p) => p.id === activeId) || profiles[0];

  /* ----- unit switch keeps things sane ----- */
  const switchUnits = (u) => {
    if (u === units) return;
    const nextDistance = UNITS[u].distances[2] || UNITS[u].distances[0];
    const nextSpan = UNITS[u].spans[1];
    runPatchTransaction({ units: u, distance: nextDistance, span: nextSpan }, {
      successMessage: u === "imp" ? "Imperial units selected." : "Metric units selected.",
    });
    setShots([]);
    setGhosts([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
  };

  const manualValidation = useMemo(() => validateManualOffsets({
    vertical: { direction: numV.dir, value: numV.val },
    horizontal: { direction: numH.dir, value: numH.val },
  }), [numV, numH]);
  const numVError = manualValidation.errors.find((error) => error.field === "vertical")?.message ?? null;
  const numHError = manualValidation.errors.find((error) => error.field === "horizontal")?.message ?? null;

  /* ----- the math ----- */
  const markedCenter = useMemo(
    () => (shots.length ? groupCenter(shots) : null),
    [shots],
  );
  const markedGroupSize = useMemo(
    () => (shots.length > 1 ? extremeSpread(shots) : null),
    [shots],
  );
  const calc = useMemo(() => {
    let point = null;
    const tapEntryReady = mode === "one" ? shots.length > 0 : shots.length >= 3;
    if (entryMode === "tap" && tapEntryReady) {
      point = markedCenter;
    } else if (entryMode === "type" && manualValidation.ok) {
      point = manualValidation.point;
    }
    if (!point) return null;
    const adjustment = calculateAdjustment({
      x: point.x,
      y: point.y,
      distance,
      units,
      profile,
    });
    return {
      ...adjustment,
      groupSize: entryMode === "tap" && mode === "group" ? markedGroupSize : null,
    };
  }, [shots.length, entryMode, mode, markedCenter, markedGroupSize, manualValidation, profile, distance, units]);

  const zeroed = calc && calc.elev.steps === 0 && calc.wind.steps === 0;

  const stampLog = () => {
    if (!calc) return;
    const entry = {
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
    };
    runAtomicTransaction((current, options) => commitLogAppend(current, entry, options), {
      successMessage: mode === "one" ? "Adjustment stamped. Enter the next shot." : "Adjustment stamped to the dope log.",
    });
    if (mode === "one" && shots.length) setGhosts((g) => appendBounded(g, shots[0], MAX_GHOSTS));
    setShots([]);
    setNumV({ dir: "LOW", val: "" });
    setNumH({ dir: "LEFT", val: "" });
    focusEntryControl();
  };

  /* ----- profile editing ----- */
  const updateProfile = (profileId, patch) => {
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return;

    if (patch.name !== undefined) {
      const safeName = String(patch.name).trim()
        || String(target.name ?? "").trim()
        || String(target.short ?? "").trim()
        || "Custom optic";
      patch = { ...patch, name: safeName, short: safeName.slice(0, 12) };
    }
    if (patch.clickMOA !== undefined) {
      patch = { ...patch, clickMOA: Math.min(100, Math.max(0.05, patch.clickMOA)) };
    }
    if (patch.travelMOA !== undefined) {
      patch = { ...patch, travelMOA: Math.min(10_000, Math.max(10, patch.travelMOA)) };
    }
    if (patch.elev !== undefined) {
      patch = {
        ...patch,
        elev: { ...patch.elev, moaPerUnit: Math.min(10_000, Math.max(0.5, patch.elev.moaPerUnit)) },
      };
    }
    if (patch.wind !== undefined) {
      patch = {
        ...patch,
        wind: { ...patch.wind, moaPerUnit: Math.min(10_000, Math.max(0.5, patch.wind.moaPerUnit)) },
      };
    }

    const changed = Object.entries(patch).some(([field, value]) => (
      JSON.stringify(target[field]) !== JSON.stringify(value)
    ));
    if (!changed) return;

    if (target.builtin) {
      if (profiles.length >= MAX_PROFILES) {
        setStatusMessage(`You can save up to ${MAX_PROFILES} optics. Delete a custom optic before editing a built-in preset.`);
        return;
      }
      const cloneId = "custom-" + crypto.randomUUID();
      const cloned = { ...target, ...patch, id: cloneId, builtin: false };
      if (activeId === profileId) setCounterTurret("ELEVATION");
      runAtomicTransaction(
        (current, options) => commitProfileClone(
          current,
          profileId,
          cloned,
          {
            ...options,
            activate: current.data.activeId === profileId,
          },
        ),
        {
          successMessage: "A custom copy was created so the built-in preset remains unchanged.",
        },
        (committed) => {
          if (committed.payload?.data.activeId === cloneId) clearTransientEntry();
        },
      );
      return;
    }

    runAtomicTransaction(
      (current, options) => {
        const latestTarget = current.data.profiles.find((candidate) => candidate.id === profileId);
        if (!latestTarget) throw new RangeError("The optic no longer exists.");
        const rebasedPatch = { ...patch };
        if (patch.elev && latestTarget.elev) {
          rebasedPatch.elev = { ...latestTarget.elev, ...patch.elev };
        }
        if (patch.wind && latestTarget.wind) {
          rebasedPatch.wind = { ...latestTarget.wind, ...patch.wind };
        }
        if (Object.prototype.hasOwnProperty.call(patch, "rot")) {
          const rotation = { ...(latestTarget.rot ?? {}) };
          for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"]) {
            if (target.rot?.[direction] === patch.rot?.[direction]) continue;
            if (patch.rot?.[direction]) rotation[direction] = patch.rot[direction];
            else delete rotation[direction];
          }
          rebasedPatch.rot = Object.keys(rotation).length ? rotation : null;
        }
        return commitProfileUpsert(
          current,
          { ...latestTarget, ...rebasedPatch },
          options,
        );
      },
    );
  };

  const addCustom = () => {
    if (profiles.length >= MAX_PROFILES) {
      setStatusMessage(`You can save up to ${MAX_PROFILES} optics. Delete a custom optic before adding another.`);
      return;
    }
    const id = "custom-" + crypto.randomUUID();
    setCounterTurret("ELEVATION");
    setDeleteCandidateId(null);
    runAtomicTransaction((current, options) => {
      let ordinal = 1;
      const names = new Set(current.data.profiles.map((candidate) => candidate.name));
      while (names.has(`Custom optic ${ordinal}`)) ordinal += 1;
      return commitProfileUpsert(current, {
        id,
        name: `Custom optic ${ordinal}`,
        short: `Custom ${ordinal}`,
        clickMOA: 0.5,
        travelMOA: 80,
        rot: null,
      }, { ...options, activate: true });
    }, {
      successMessage: "Custom optic added. Edit its specifications below.",
    }, (committed) => {
      if (committed.payload?.data.activeId !== id) return;
      clearTransientEntry();
      setEditorSession((current) => current + 1);
      setEditing(true);
    });
  };

  const deleteProfile = () => {
    const candidate = profiles.find((item) => item.id === deleteCandidateId);
    if (!candidate || candidate.builtin) {
      setDeleteCandidateId(null);
      return;
    }
    const deletedName = candidate.name;
    setCounterTurret("ELEVATION");
    runAtomicTransaction(
      (current, options) => commitProfileDelete(current, candidate.id, {
        ...options,
        nextActiveId: PRESET_PROFILES[0].id,
      }),
      { successMessage: `${deletedName} deleted. ${PRESET_PROFILES[0].short} selected.` },
      (committed) => {
        if (committed.payload?.data.profiles.some((item) => item.id === candidate.id)) return;
        clearTransientEntry();
        setEditing(false);
        setEditorSession((current) => current + 1);
        setDeleteCandidateId(null);
        requestAnimationFrame(() => {
          opticSelectorRef.current?.querySelector(`[data-optic-id="${PRESET_PROFILES[0].id}"]`)?.focus();
        });
      },
    );
  };

  const requestProfileDelete = () => {
    setDeleteCandidateId(activeId);
    setStatusMessage(`Confirm deletion of ${profile.name}.`);
    requestAnimationFrame(() => deleteConfirmRef.current?.focus());
  };

  const resetPresets = () => {
    let restoredSpecs = false;
    let activeCalculationChanged = false;
    runAtomicTransaction((current, options) => {
      const changedPreset = PRESET_PROFILES.some((preset) => {
        const savedPreset = current.data.profiles.find((candidate) => candidate.id === preset.id);
        return JSON.stringify(savedPreset) !== JSON.stringify(preset);
      });
      if (!changedPreset) return current;
      restoredSpecs = true;
      const previousActive = current.data.profiles.find((candidate) => candidate.id === current.data.activeId);
      const resetActive = PRESET_PROFILES.find((preset) => preset.id === current.data.activeId);
      activeCalculationChanged = Boolean(resetActive)
        && calculationProfileSignature(previousActive) !== calculationProfileSignature(resetActive);
      // A raw lock-to-lock detent count remains mechanically valid when only
      // declared click/travel specifications are corrected.
      return commitProfilesReset(current, PRESET_PROFILES, {
        ...options,
        resetCounters: false,
      });
    }, {}, (committed) => {
      if (!restoredSpecs) {
        setStatusMessage("Built-in optic specifications already match their defaults.");
        return;
      }
      if (activeCalculationChanged) clearTransientEntry();
      if (committed.saved) {
        setStatusMessage("Built-in optic specifications restored. Saved turret counts were preserved.");
      }
    });
  };

  /* ----- counter helpers ----- */
  const storedCounter = getCounterSession(counterSessions, activeId, counterTurret);
  const counter = {
    turret: counterTurret,
    count: storedCounter.count,
    done: storedCounter.done,
  };
  const centerGuidance = getMechanicalCenterGuidance(counter.count);
  const lockToLock = profile.type === "irons" ? 0 : Math.round(profile.travelMOA / profile.clickMOA);
  const commitCounterValue = (count, done, successMessage = "") => {
    const profileId = activeId;
    const turret = counterTurret;
    const boundedCount = Math.min(MAX_COUNTER_CLICKS, Math.max(0, Math.trunc(count)));
    runAtomicTransaction(
      (current, options) => commitCounterSession(current, {
        profileId,
        turret,
        count: boundedCount,
        done,
      }, options),
      { successMessage },
    );
  };
  const bump = (amount) => {
    const profileId = activeId;
    const turret = counterTurret;
    runAtomicTransaction((current, options) => {
      const latestCounter = getCounterSession(current.data.counters, profileId, turret);
      const nextCount = Math.min(
        MAX_COUNTER_CLICKS,
        Math.max(0, latestCounter.count + amount),
      );
      return commitCounterSession(current, {
        profileId,
        turret,
        count: nextCount,
        done: false,
      }, options);
    });
  };

  const completeCounter = () => {
    const profileId = activeId;
    const turret = counterTurret;
    runAtomicTransaction(
      (current, options) => {
        const latestCounter = getCounterSession(current.data.counters, profileId, turret);
        return commitCounterSession(current, {
          profileId,
          turret,
          count: latestCounter.count,
          done: true,
        }, options);
      },
      { successMessage: "Mechanical center instruction calculated." },
    );
  };

  const handleTabKeyDown = (event, currentId) => {
    const currentIndex = TAB_IDS.indexOf(currentId);
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % TAB_IDS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + TAB_IDS.length) % TAB_IDS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TAB_IDS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = TAB_IDS[nextIndex];
    setTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  const clearShotMarks = () => {
    setShots([]);
    setGhosts([]);
    setStatusMessage("Shot marks cleared.");
    requestAnimationFrame(() => targetRef.current?.focus());
  };

  const undoShotMark = () => {
    const nextShots = shots.slice(0, -1);
    setShots(nextShots);
    setStatusMessage("Last shot mark removed.");
    if (nextShots.length === 0) requestAnimationFrame(() => targetRef.current?.focus());
  };

  const clearLog = () => {
    runPatchTransaction({ log: [] }, { successMessage: "Dope log cleared." });
    setClearLogPending(false);
    requestAnimationFrame(() => logHeadingRef.current?.focus());
  };

  const resultAnnouncement = useMemo(() => {
    if (numVError || numHError) return "";
    if (!calc) return "";
    if (zeroed) return "Result: within one adjustment of the point of aim.";
    const lead = profile.type === "irons" ? "Sight adjustment result" : "Dialing result";
    return `${lead}. Elevation: ${describeAdjustmentForSpeech(calc.elev, profile.type)}. Windage: ${describeAdjustmentForSpeech(calc.wind, profile.type)}.`;
  }, [calc, zeroed, numVError, numHError, profile.type]);

  /* ============================ render ============================ */
  if (!loaded) {
    return (
      <main className="app-loading" aria-busy="true" aria-live="polite">
        <div style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 28 }}>CLICKBAIT</div>
        <div style={{ fontFamily: FONT_MONO, marginTop: 8 }}>Loading saved range data…</div>
      </main>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink }}>
      <a className="skip-link" href="#main-content">Skip to range controls</a>
      <style>{`
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, svg[role="button"]:focus-visible { outline: 3px solid ${C.ink}; outline-offset: 3px; }
        input { font-family: ${FONT_MONO}; }
        @keyframes stampIn { from { transform: scale(1.04); opacity: .4; } to { transform: scale(1); opacity: 1; } }
        .stamp { animation: stampIn .18s ease-out; }
        @media (prefers-reduced-motion: reduce) { .stamp { animation: none; } }
      `}</style>

      <main
        id="main-content"
        tabIndex={-1}
        style={{
          maxWidth: 480,
          margin: "0 auto",
          paddingTop: "calc(16px + env(safe-area-inset-top, 0px))",
          paddingRight: "calc(14px + env(safe-area-inset-right, 0px))",
          paddingBottom: "calc(40px + env(safe-area-inset-bottom, 0px))",
          paddingLeft: "calc(14px + env(safe-area-inset-left, 0px))",
        }}
      >
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
            <h1 className="app-title" style={{ fontFamily: FONT_HEAD, fontWeight: 700, fontSize: 42, lineHeight: 1, margin: 0, letterSpacing: "0.02em" }}>
              CLICKBAIT
            </h1>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.inkSoft, marginTop: 4 }}>
            Sight-in & turret assistant — every click accounted for.
          </div>
        </header>

        <div id="app-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {persistenceWarning ? "" : statusMessage}
        </div>
        <div id="dial-result-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {resultAnnouncement}
        </div>

        {persistenceWarning && (
          <div
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            aria-label="Saving unavailable"
            style={{
              margin: "10px 0 14px",
              padding: "10px 12px",
              border: `2px solid ${C.red}`,
              borderRadius: 4,
              background: C.card,
              color: C.red,
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ display: "block", fontFamily: FONT_HEAD, fontSize: 15, letterSpacing: "0.08em" }}>
              SAVING IS UNAVAILABLE
            </strong>
            {persistenceWarning}
          </div>
        )}

        <OpticPanel
          profiles={profiles}
          activeId={activeId}
          profile={profile}
          maxProfiles={MAX_PROFILES}
          editorSession={editorSession}
          editing={editing}
          deletePending={deleteCandidateId === activeId}
          opticSelectorRef={opticSelectorRef}
          deleteRequestRef={deleteRequestRef}
          deleteConfirmRef={deleteConfirmRef}
          onSwitchOptic={(id) => {
            switchOptic(id);
            setEditing(false);
            setEditorSession((current) => current + 1);
          }}
          onAddCustom={addCustom}
          onToggleEditing={() => {
            if (!editing) setEditorSession((current) => current + 1);
            setEditing(!editing);
            setDeleteCandidateId(null);
          }}
          onUpdateProfile={(patch) => updateProfile(profile.id, patch)}
          onRequestDelete={requestProfileDelete}
          onDelete={deleteProfile}
          onCancelDelete={() => {
            setDeleteCandidateId(null);
            setStatusMessage("Optic deletion canceled.");
            requestAnimationFrame(() => deleteRequestRef.current?.focus());
          }}
          onResetPresets={() => {
            resetPresets();
          }}
        />

        <AppTabs
          tab={tab}
          profile={profile}
          logCount={log.length}
          tabRefs={tabRefs}
          onSelect={(id, label) => {
            setTab(id);
            setStatusMessage(`${label.replace(/\s*\(\d+\)$/, "")} tab selected.`);
          }}
          onKeyDown={handleTabKeyDown}
        />

        {tab === "zero" && (
          <ZeroPanel
            key={zeroSession}
            unitSpec={U}
            units={units}
            distance={distance}
            span={span}
            mode={mode}
            entryMode={entryMode}
            shots={shots}
            ghosts={ghosts}
            markedCenter={markedCenter}
            markedGroupSize={markedGroupSize}
            calc={calc}
            zeroed={zeroed}
            profile={profile}
            verticalOffset={numV}
            horizontalOffset={numH}
            verticalError={numVError}
            horizontalError={numHError}
            targetRef={targetRef}
            manualVerticalRef={manualVerticalRef}
            onDistanceChange={(nextDistance) => queuePersistedEdit({ distance: nextDistance })}
            onUnitsChange={switchUnits}
            onModeChange={switchMode}
            onEntryModeChange={switchEntryMode}
            onTargetTap={handleTargetTap}
            onUndoShot={undoShotMark}
            onClearShots={clearShotMarks}
            onSpanChange={(nextSpan) => queuePersistedEdit({ span: nextSpan })}
            onVerticalOffsetChange={setNumV}
            onHorizontalOffsetChange={setNumH}
            onStamp={stampLog}
          />
        )}

        {tab === "center" && (
          <CenterPanel
            key={centerSession}
            profile={profile}
            counter={counter}
            centerGuidance={centerGuidance}
            lockToLock={lockToLock}
            maxCounterClicks={MAX_COUNTER_CLICKS}
            onSelectTurret={(turret) => {
              setCounterTurret(turret);
              const restored = getCounterSession(counterSessions, activeId, turret);
              setStatusMessage(`${turret.toLowerCase()} count restored at ${restored.count} clicks.`);
            }}
            onBump={bump}
            onReset={() => commitCounterValue(0, false, "Turret click count reset.")}
            onDone={completeCounter}
          />
        )}

        {tab === "log" && (
          <LogPanel
            log={log}
            clearPending={clearLogPending}
            headingRef={logHeadingRef}
            clearRequestRef={clearLogRequestRef}
            clearConfirmRef={clearLogConfirmRef}
            onRequestClear={() => {
              setClearLogPending(true);
              setStatusMessage(`Confirm clearing ${log.length} dope-log ${log.length === 1 ? "entry" : "entries"}.`);
              requestAnimationFrame(() => clearLogConfirmRef.current?.focus());
            }}
            onClear={clearLog}
            onCancelClear={() => {
              setClearLogPending(false);
              setStatusMessage("Clearing the dope log canceled.");
              requestAnimationFrame(() => clearLogRequestRef.current?.focus());
            }}
          />
        )}

        {/* footer */}
        <footer style={{ marginTop: 26, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.6, color: C.inkSoft, borderTop: `1px dashed ${C.grid}`, paddingTop: 10 }}>
          Click values preloaded from manufacturer manuals (HS507C-X2: 1 MOA · SLx 3×32 Gen III: ¼ MOA) — verify against your own manual; specs vary by model revision. AK irons: ~6.9 MOA per front-post turn / ~9.1 MOA per mm of drift (AKM-pattern sight radius — verify on your rifle). Follow all range safety rules. 1 MOA = 1.047 in at 100 yd / 2.908 cm at 100 m.
        </footer>
      </main>
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
