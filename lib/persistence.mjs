// @ts-check

import { COLLECTION_LIMITS, UNIT_SYSTEMS, boundCollection } from "./domain.mjs";

/** @typedef {"imp" | "met"} UnitSystem */
/** @typedef {"one" | "group"} ShotMode */
/** @typedef {"tap" | "type"} EntryMode */
/** @typedef {"ELEVATION" | "WINDAGE"} Turret */
/** @typedef {"profiles" | "activeId" | "units" | "distance" | "span" | "log" | "logEpoch" | "mode" | "entryMode" | "counters"} PersistedField */

/**
 * @typedef {object} RevisionClock
 * @property {number} revision
 * @property {number} updatedAt
 * @property {string} writerId
 */

/**
 * @typedef {object} CounterSession
 * @property {number} count
 * @property {boolean} done
 * @property {number} revision
 * @property {number} updatedAt
 * @property {string} writerId
 */

/** @typedef {{ ELEVATION?: CounterSession, WINDAGE?: CounterSession }} ProfileCounters */
/** @typedef {Record<string, ProfileCounters>} CounterSessions */
/** @typedef {{ ELEVATION?: RevisionClock, WINDAGE?: RevisionClock }} ProfileCounterTombstones */
/** @typedef {Record<string, ProfileCounterTombstones>} CounterTombstones */
/** @typedef {Record<string, RevisionClock>} ProfileRevisionMap */

/**
 * @typedef {object} MergeMetadata
 * @property {1} version
 * @property {RevisionClock} resetClock Whole-user-data factory-reset generation.
 * @property {{ revisions: ProfileRevisionMap, tombstones: ProfileRevisionMap, resetClock: RevisionClock }} profiles
 * @property {{ tombstones: CounterTombstones, resetClock: RevisionClock }} counters
 * @property {{ clearClock: RevisionClock }} log
 */

/**
 * @typedef {object} LogEntry
 * @property {string} id
 * @property {number} ts
 * @property {string} optic
 * @property {string} dist
 * @property {string} e
 * @property {string} w
 * @property {string | null} [grp]
 * @property {boolean} [one]
 */

/**
 * @typedef {object} PersistedData
 * @property {Record<string, unknown>[]} profiles
 * @property {string} activeId
 * @property {UnitSystem} units
 * @property {number} distance
 * @property {number} span
 * @property {LogEntry[]} log
 * @property {number} logEpoch Monotonic generation used to make clear-log merge-safe.
 * @property {ShotMode} mode
 * @property {EntryMode} entryMode
 * @property {CounterSessions} counters
 */

/**
 * @typedef {object} PersistedPayload
 * @property {number} schemaVersion
 * @property {number} revision
 * @property {number} updatedAt
 * @property {string} writerId
 * @property {Record<string, RevisionClock>} fieldRevisions
 * @property {MergeMetadata} mergeMeta
 * @property {PersistedData} data
 */

/**
 * @typedef {object} PersistenceIssue
 * @property {string} path
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} [removeItem]
 */

export const PERSISTENCE_SCHEMA_VERSION = 2;
export const STORAGE_KEY = "clickbait-v2";
export const LEGACY_STORAGE_KEYS = Object.freeze(["clickbait-v1"]);
export const MAX_SERIALIZED_BYTES = 2_000_000;
export const MAX_COUNTER_CLICKS = 100_000;
export const MERGE_METADATA_VERSION = 1;

/** @type {readonly PersistedField[]} */
export const PERSISTED_FIELDS = Object.freeze([
  "profiles",
  "activeId",
  "units",
  "distance",
  "span",
  "log",
  "logEpoch",
  "mode",
  "entryMode",
  "counters",
]);

const PERSISTED_FIELD_SET = new Set(PERSISTED_FIELDS);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROTATIONS = new Set(["clockwise", "counter-clockwise"]);
const ROTATION_DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"];
const MAX_CLOCK = Number.MAX_SAFE_INTEGER;
const MAX_PERSISTENCE_ISSUES = 100;
const MAX_PROFILE_TOMBSTONES = COLLECTION_LIMITS.profiles * 4;
const MAX_COUNTER_TOMBSTONE_PROFILES = COLLECTION_LIMITS.profiles * 4;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function finiteInRange(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function integerInRange(value, fallback, min, max) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @param {number} maxLength
 * @returns {string}
 */
function boundedString(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function writerId(value, fallback = "unknown") {
  return boundedString(value, fallback, 128).replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * @param {unknown} value
 * @returns {Record<string, "clockwise" | "counter-clockwise"> | null}
 */
function normalizeRotationMap(value) {
  if (!isRecord(value)) return null;
  /** @type {Record<string, "clockwise" | "counter-clockwise">} */
  const result = {};
  for (const direction of ROTATION_DIRECTIONS) {
    const rotation = value[direction];
    if (typeof rotation === "string" && ROTATIONS.has(rotation)) {
      result[direction] = /** @type {"clockwise" | "counter-clockwise"} */ (rotation);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * @param {unknown} value
 * @param {"turn" | "mm"} fallbackUnit
 * @returns {{ moaPerUnit: number, step: number, unit: string, maxUnits: number } | null}
 */
function normalizeAxisSpec(value, fallbackUnit) {
  if (!isRecord(value)) return null;
  const moaPerUnit = finiteInRange(value.moaPerUnit, 0, 0.01, 10000);
  const step = finiteInRange(value.step, 0, 0.001, 1000);
  const maxUnits = finiteInRange(value.maxUnits, 0, 0.001, 10000);
  if (!moaPerUnit || !step || !maxUnits) return null;
  const unit = boundedString(value.unit, fallbackUnit, 24);
  return { moaPerUnit, step, maxUnits, unit };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function normalizeProfile(value) {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id, "", 128);
  if (!PROFILE_ID_PATTERN.test(id)) return null;
  const name = boundedString(value.name, "Unnamed optic", 160);
  const short = boundedString(value.short, name.slice(0, 32), 32);
  const builtin = value.builtin === true;
  if (value.type === "irons") {
    const elev = normalizeAxisSpec(value.elev, "turn");
    const wind = normalizeAxisSpec(value.wind, "mm");
    if (!elev || !wind) return null;
    return { id, name, short, type: "irons", elev, wind, builtin };
  }
  const clickMOA = finiteInRange(value.clickMOA, 0, 0.01, 100);
  const travelMOA = finiteInRange(value.travelMOA, 0, 1, 10000);
  if (!clickMOA || !travelMOA) return null;
  return {
    id,
    name,
    short,
    clickMOA,
    travelMOA,
    rot: normalizeRotationMap(value.rot),
    builtin,
  };
}

/**
 * Sanitize, de-duplicate, bound, and append any missing current presets.
 * Current presets are protected from being displaced by excessive customs.
 *
 * @param {unknown} value
 * @param {readonly unknown[]} [presets]
 * @returns {Record<string, unknown>[]}
 */
export function normalizeProfiles(value, presets = []) {
  const safePresets = presets.map(normalizeProfile).filter(isNonNull);
  const safeSaved = (Array.isArray(value) ? value : []).map(normalizeProfile).filter(isNonNull);
  const seen = new Set();
  /** @type {Record<string, unknown>[]} */
  const merged = [];
  for (const profile of [...safeSaved, ...safePresets]) {
    const id = /** @type {string} */ (profile.id);
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(profile);
    }
  }
  if (merged.length <= COLLECTION_LIMITS.profiles) return merged;
  const protectedIds = new Set(safePresets.map((profile) => /** @type {string} */ (profile.id)));
  const protectedProfiles = merged.filter((profile) => protectedIds.has(/** @type {string} */ (profile.id)));
  const customs = merged.filter((profile) => !protectedIds.has(/** @type {string} */ (profile.id)));
  return [...protectedProfiles, ...customs.slice(0, Math.max(0, COLLECTION_LIMITS.profiles - protectedProfiles.length))];
}

/** @template T @param {T | null} value @returns {value is T} */
function isNonNull(value) {
  return value !== null;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {LogEntry | null}
 */
function normalizeLogEntry(value, index) {
  if (!isRecord(value)) return null;
  const ts = integerInRange(value.ts, 0, 0, 8_640_000_000_000_000);
  if (!ts) return null;
  const id = boundedString(value.id, `legacy-${ts}-${index}`, 128);
  return {
    id,
    ts,
    optic: boundedString(value.optic, "Unknown optic", 160),
    dist: boundedString(value.dist, "Unknown distance", 64),
    e: boundedString(value.e, "—", 64),
    w: boundedString(value.w, "—", 64),
    ...(typeof value.grp === "string" && value.grp.trim()
      ? { grp: value.grp.trim().slice(0, 64) }
      : {}),
    ...(value.one === true ? { one: true } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {LogEntry[]}
 */
export function normalizeLogs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {LogEntry[]} */
  const logs = [];
  value.forEach((entry, index) => {
    const safe = normalizeLogEntry(entry, index);
    if (safe && !seen.has(safe.id)) {
      seen.add(safe.id);
      logs.push(safe);
    }
  });
  logs.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
  return boundCollection(logs, COLLECTION_LIMITS.logs, "head");
}

/**
 * @param {unknown} value
 * @param {RevisionClock} [fallbackClock]
 * @returns {CounterSession | null}
 */
function normalizeCounterSession(value, fallbackClock = { revision: 0, updatedAt: 0, writerId: "unknown" }) {
  if (!isRecord(value)) return null;
  const countValid = typeof value.count === "number"
    && Number.isSafeInteger(value.count)
    && value.count >= 0
    && value.count <= MAX_COUNTER_CLICKS;
  const doneValid = typeof value.done === "boolean";
  return {
    count: countValid ? /** @type {number} */ (value.count) : 0,
    // An invalid count cannot coherently remain in the completed state.
    done: countValid && doneValid ? value.done === true : false,
    revision: integerInRange(value.revision, fallbackClock.revision, 0, MAX_CLOCK),
    updatedAt: integerInRange(value.updatedAt, fallbackClock.updatedAt, 0, MAX_CLOCK),
    writerId: writerId(value.writerId, fallbackClock.writerId),
  };
}

/**
 * @param {unknown} value
 * @param {readonly Record<string, unknown>[]} profiles
 * @param {{ fallbackClock?: RevisionClock }} [options]
 * @returns {CounterSessions}
 */
export function normalizeCounterSessions(value, profiles, options = {}) {
  if (!isRecord(value)) return {};
  const fallbackClock = options.fallbackClock ?? { revision: 0, updatedAt: 0, writerId: "unknown" };
  const profileIds = new Set(profiles.map((profile) => /** @type {string} */ (profile.id)));
  /** @type {CounterSessions} */
  const counters = {};
  for (const [profileId, rawPair] of Object.entries(value)) {
    if (!profileIds.has(profileId) || !isRecord(rawPair)) continue;
    /** @type {ProfileCounters} */
    const pair = {};
    const elevation = normalizeCounterSession(rawPair.ELEVATION, fallbackClock);
    const windage = normalizeCounterSession(rawPair.WINDAGE, fallbackClock);
    if (elevation) pair.ELEVATION = elevation;
    if (windage) pair.WINDAGE = windage;
    if (pair.ELEVATION || pair.WINDAGE) counters[profileId] = pair;
  }
  return counters;
}

/**
 * Create a safe data baseline. Supply manufacturer presets through `profiles`.
 *
 * @param {Partial<PersistedData> & { profiles?: Record<string, unknown>[] }} [overrides]
 * @returns {PersistedData}
 */
export function createPersistenceDefaults(overrides = {}) {
  const profiles = normalizeProfiles(overrides.profiles ?? [], []);
  const units = overrides.units === "met" ? "met" : "imp";
  const spans = UNIT_SYSTEMS[units].spans;
  const defaultSpan = units === "imp" ? 12 : 30;
  const requestedSpan = overrides.span;
  const span = typeof requestedSpan === "number" && spans.includes(requestedSpan)
    ? requestedSpan
    : defaultSpan;
  const maxDistance = units === "imp" ? 2000 : 1800;
  const distance = finiteInRange(overrides.distance, units === "imp" ? 25 : 50, 1, maxDistance);
  const activeCandidate = boundedString(overrides.activeId, "", 128);
  const activeId = profiles.some((profile) => profile.id === activeCandidate)
    ? activeCandidate
    : profiles.length > 0
      ? /** @type {string} */ (profiles[0].id)
      : "";
  return {
    profiles,
    activeId,
    units,
    distance,
    span,
    log: normalizeLogs(overrides.log ?? []),
    logEpoch: integerInRange(overrides.logEpoch, 0, 0, MAX_CLOCK),
    mode: overrides.mode === "group" ? "group" : "one",
    entryMode: overrides.entryMode === "type" ? "type" : "tap",
    counters: normalizeCounterSessions(overrides.counters ?? {}, profiles),
  };
}

/**
 * Keep diagnostics bounded even when storage contains a hostile number of
 * malformed records.
 *
 * @param {PersistenceIssue[]} issues
 * @param {string} path
 * @param {string} code
 * @param {string} message
 */
function addPersistenceIssue(issues, path, code, message) {
  if (issues.length >= MAX_PERSISTENCE_ISSUES) return;
  issues.push({ path, code, message });
}

/**
 * Report record-level recovery that the collection normalizers intentionally
 * perform. This prevents a partially corrupt array from being called valid.
 *
 * @param {Record<string, unknown>} source
 * @param {readonly Record<string, unknown>[]} profiles
 * @param {PersistenceIssue[]} issues
 */
function reportCollectionItemIssues(source, profiles, issues) {
  if (Array.isArray(source.profiles)) {
    const seen = new Set();
    let validUnique = 0;
    source.profiles.forEach((value, index) => {
      const profile = normalizeProfile(value);
      if (!profile) {
        addPersistenceIssue(issues, `data.profiles[${index}]`, "invalid-profile", "Ignored an invalid saved optic.");
        return;
      }
      const id = /** @type {string} */ (profile.id);
      if (seen.has(id)) {
        addPersistenceIssue(issues, `data.profiles[${index}]`, "duplicate-profile", `Ignored duplicate saved optic ${id}.`);
        return;
      }
      seen.add(id);
      validUnique += 1;
    });
    if (validUnique > COLLECTION_LIMITS.profiles) {
      addPersistenceIssue(issues, "data.profiles", "profiles-truncated", `Saved optics were limited to ${COLLECTION_LIMITS.profiles}.`);
    }
  }

  if (Array.isArray(source.log)) {
    const seen = new Set();
    let validUnique = 0;
    source.log.forEach((value, index) => {
      const entry = normalizeLogEntry(value, index);
      if (!entry) {
        addPersistenceIssue(issues, `data.log[${index}]`, "invalid-log-entry", "Ignored an invalid saved dope-log entry.");
        return;
      }
      if (seen.has(entry.id)) {
        addPersistenceIssue(issues, `data.log[${index}]`, "duplicate-log-entry", `Ignored duplicate dope-log entry ${entry.id}.`);
        return;
      }
      seen.add(entry.id);
      validUnique += 1;
    });
    if (validUnique > COLLECTION_LIMITS.logs) {
      addPersistenceIssue(issues, "data.log", "log-truncated", `Saved dope-log entries were limited to ${COLLECTION_LIMITS.logs}.`);
    }
  }

  if (!isRecord(source.counters)) return;
  const profileIds = new Set(profiles.map((profile) => /** @type {string} */ (profile.id)));
  for (const [profileId, rawPair] of Object.entries(source.counters)) {
    if (!profileIds.has(profileId)) {
      addPersistenceIssue(issues, `data.counters.${profileId}`, "unknown-counter-profile", "Ignored a counter for an unknown optic.");
      continue;
    }
    if (!isRecord(rawPair)) {
      addPersistenceIssue(issues, `data.counters.${profileId}`, "invalid-counter-pair", "Ignored invalid saved turret counters.");
      continue;
    }
    for (const turret of /** @type {const} */ (["ELEVATION", "WINDAGE"])) {
      if (!Object.prototype.hasOwnProperty.call(rawPair, turret)) continue;
      const session = rawPair[turret];
      const path = `data.counters.${profileId}.${turret}`;
      if (!isRecord(session)) {
        addPersistenceIssue(issues, path, "invalid-counter-session", "Ignored an invalid saved turret counter.");
        continue;
      }
      const countValid = typeof session.count === "number"
        && Number.isSafeInteger(session.count)
        && session.count >= 0
        && session.count <= MAX_COUNTER_CLICKS;
      if (!countValid) {
        addPersistenceIssue(issues, `${path}.count`, "invalid-counter-count", "Reset an invalid saved turret count.");
      }
      if (!countValid && session.done === true) {
        addPersistenceIssue(issues, `${path}.done`, "counter-state-reset", "Reset the completed state because its saved count was invalid.");
      } else if (typeof session.done !== "boolean") {
        addPersistenceIssue(issues, `${path}.done`, "invalid-counter-state", "Reset an invalid saved turret completion state.");
      }
      for (const clockField of /** @type {const} */ (["revision", "updatedAt"])) {
        if (Object.prototype.hasOwnProperty.call(session, clockField)
            && (!Number.isSafeInteger(session[clockField]) || /** @type {number} */ (session[clockField]) < 0)) {
          addPersistenceIssue(issues, `${path}.${clockField}`, "invalid-counter-clock", "Recovered invalid saved counter metadata.");
        }
      }
      if (Object.prototype.hasOwnProperty.call(session, "writerId") && typeof session.writerId !== "string") {
        addPersistenceIssue(issues, `${path}.writerId`, "invalid-counter-writer", "Recovered invalid saved counter metadata.");
      }
    }
  }
}

/**
 * Validate persisted data field-by-field, falling back without discarding
 * unrelated valid fields.
 *
 * @param {unknown} value
 * @param {{ defaults: PersistedData, presets?: readonly unknown[] }} options
 * @returns {{ data: PersistedData, issues: PersistenceIssue[] }}
 */
export function normalizePersistedData(value, { defaults, presets = [] }) {
  const source = isRecord(value) ? value : {};
  const base = createPersistenceDefaults(defaults);
  /** @type {PersistenceIssue[]} */
  const issues = [];
  /** @param {PersistedField} field @param {boolean} valid */
  const reportFallback = (field, valid) => {
    if (!valid && Object.prototype.hasOwnProperty.call(source, field)) {
      addPersistenceIssue(issues, `data.${field}`, "invalid-field", `Ignored invalid saved ${field}.`);
    }
  };

  const profileInputValid = Array.isArray(source.profiles);
  reportFallback("profiles", profileInputValid);
  const profiles = normalizeProfiles(profileInputValid ? source.profiles : base.profiles, presets);

  const unitsValid = source.units === "imp" || source.units === "met";
  reportFallback("units", unitsValid);
  const units = /** @type {UnitSystem} */ (unitsValid ? source.units : base.units);

  const distanceMax = units === "imp" ? 2000 : 1800;
  const distanceValid = typeof source.distance === "number"
    && Number.isFinite(source.distance)
    && source.distance >= 1
    && source.distance <= distanceMax;
  reportFallback("distance", distanceValid);
  const fallbackDistance = finiteInRange(base.distance, units === "imp" ? 25 : 50, 1, distanceMax);
  const distance = distanceValid ? /** @type {number} */ (source.distance) : fallbackDistance;

  const allowedSpans = UNIT_SYSTEMS[units].spans;
  const spanValid = typeof source.span === "number" && allowedSpans.includes(source.span);
  reportFallback("span", spanValid);
  const fallbackSpan = allowedSpans.includes(base.span) ? base.span : units === "imp" ? 12 : 30;
  const span = spanValid ? /** @type {number} */ (source.span) : fallbackSpan;

  const activeCandidate = boundedString(source.activeId, base.activeId, 128);
  const activeValid = profiles.some((profile) => profile.id === activeCandidate);
  reportFallback("activeId", activeValid);
  const activeId = activeValid
    ? activeCandidate
    : profiles.some((profile) => profile.id === base.activeId)
      ? base.activeId
      : profiles.length > 0
        ? /** @type {string} */ (profiles[0].id)
        : "";

  const logValid = Array.isArray(source.log);
  reportFallback("log", logValid);
  const log = normalizeLogs(logValid ? source.log : base.log);
  const logEpochValid = typeof source.logEpoch === "number"
    && Number.isSafeInteger(source.logEpoch)
    && source.logEpoch >= 0;
  reportFallback("logEpoch", logEpochValid);
  const logEpoch = logEpochValid ? /** @type {number} */ (source.logEpoch) : base.logEpoch;

  const modeValid = source.mode === "one" || source.mode === "group";
  reportFallback("mode", modeValid);
  const mode = /** @type {ShotMode} */ (modeValid ? source.mode : base.mode);

  const entryModeValid = source.entryMode === "tap" || source.entryMode === "type";
  reportFallback("entryMode", entryModeValid);
  const entryMode = /** @type {EntryMode} */ (entryModeValid ? source.entryMode : base.entryMode);

  const countersValid = isRecord(source.counters);
  reportFallback("counters", countersValid);
  const counters = normalizeCounterSessions(countersValid ? source.counters : base.counters, profiles);

  reportCollectionItemIssues(source, profiles, issues);

  return {
    data: { profiles, activeId, units, distance, span, log, logEpoch, mode, entryMode, counters },
    issues,
  };
}

/**
 * @param {number} revision
 * @param {number} updatedAt
 * @param {string} id
 * @returns {RevisionClock}
 */
function createClock(revision, updatedAt, id) {
  return { revision, updatedAt, writerId: id };
}

/**
 * @param {unknown} value
 * @param {RevisionClock} fallback
 * @returns {RevisionClock}
 */
function normalizeClock(value, fallback) {
  if (!isRecord(value)) return { ...fallback };
  return {
    revision: integerInRange(value.revision, fallback.revision, 0, MAX_CLOCK),
    updatedAt: integerInRange(value.updatedAt, fallback.updatedAt, 0, MAX_CLOCK),
    writerId: writerId(value.writerId, fallback.writerId),
  };
}

/** @returns {RevisionClock} */
function emptyClock() {
  return { revision: 0, updatedAt: 0, writerId: "unknown" };
}

/** @param {RevisionClock} clock @returns {boolean} */
function hasAdvancedClock(clock) {
  return clock.revision > 0 || clock.updatedAt > 0 || clock.writerId !== "unknown";
}

/** @param {RevisionClock} left @param {RevisionClock} right @returns {RevisionClock} */
function newestClock(left, right) {
  return compareRevisionClocks(left, right) >= 0 ? { ...left } : { ...right };
}

/** @param {string} left @param {string} right @returns {number} */
function compareText(left, right) {
  return left === right ? 0 : left > right ? 1 : -1;
}

/**
 * @param {ProfileRevisionMap} clocks
 * @param {number} limit
 * @returns {ProfileRevisionMap}
 */
function boundRevisionMap(clocks, limit) {
  return Object.fromEntries(
    Object.entries(clocks)
      .sort(([leftId, left], [rightId, right]) => {
        const clockComparison = compareRevisionClocks(right, left);
        return clockComparison || compareText(leftId, rightId);
      })
      .slice(0, limit)
      .map(([id, clock]) => [id, { ...clock }]),
  );
}

/** @param {ProfileCounterTombstones} pair @returns {RevisionClock} */
function newestCounterTombstone(pair) {
  const elevation = pair.ELEVATION ?? emptyClock();
  const windage = pair.WINDAGE ?? emptyClock();
  return newestClock(elevation, windage);
}

/** @param {CounterTombstones} tombstones @returns {CounterTombstones} */
function boundCounterTombstones(tombstones) {
  return Object.fromEntries(
    Object.entries(tombstones)
      .sort(([leftId, left], [rightId, right]) => {
        const clockComparison = compareRevisionClocks(newestCounterTombstone(right), newestCounterTombstone(left));
        return clockComparison || compareText(leftId, rightId);
      })
      .slice(0, MAX_COUNTER_TOMBSTONE_PROFILES)
      .map(([id, pair]) => [id, {
        ...(pair.ELEVATION ? { ELEVATION: { ...pair.ELEVATION } } : {}),
        ...(pair.WINDAGE ? { WINDAGE: { ...pair.WINDAGE } } : {}),
      }]),
  );
}

/**
 * @param {unknown} value
 * @param {Set<string>} presetIds
 * @returns {ProfileRevisionMap}
 */
function normalizeProfileTombstones(value, presetIds) {
  if (!isRecord(value)) return {};
  /** @type {ProfileRevisionMap} */
  const tombstones = {};
  for (const [id, rawClock] of Object.entries(value)) {
    if (!PROFILE_ID_PATTERN.test(id) || presetIds.has(id) || !isRecord(rawClock)) continue;
    tombstones[id] = normalizeClock(rawClock, emptyClock());
  }
  return boundRevisionMap(tombstones, MAX_PROFILE_TOMBSTONES);
}

/** @param {unknown} value @returns {CounterTombstones} */
function normalizeCounterTombstones(value) {
  if (!isRecord(value)) return {};
  /** @type {CounterTombstones} */
  const tombstones = {};
  for (const [profileId, rawPair] of Object.entries(value)) {
    if (!PROFILE_ID_PATTERN.test(profileId) || !isRecord(rawPair)) continue;
    /** @type {ProfileCounterTombstones} */
    const pair = {};
    if (isRecord(rawPair.ELEVATION)) pair.ELEVATION = normalizeClock(rawPair.ELEVATION, emptyClock());
    if (isRecord(rawPair.WINDAGE)) pair.WINDAGE = normalizeClock(rawPair.WINDAGE, emptyClock());
    if (pair.ELEVATION || pair.WINDAGE) tombstones[profileId] = pair;
  }
  return boundCounterTombstones(tombstones);
}

/**
 * Normalize optional merge metadata. Existing v2 payloads have none, so live
 * entity clocks are synthesized from their field clocks.
 *
 * @param {unknown} value
 * @param {PersistedData} data
 * @param {Record<string, RevisionClock>} fieldRevisions
 * @param {readonly unknown[]} presets
 * @returns {MergeMetadata}
 */
function normalizeMergeMetadata(value, data, fieldRevisions, presets) {
  const rawMeta = isRecord(value) && value.version === MERGE_METADATA_VERSION ? value : {};
  const rawProfiles = isRecord(rawMeta.profiles) ? rawMeta.profiles : {};
  const rawRevisions = isRecord(rawProfiles.revisions) ? rawProfiles.revisions : {};
  /** @type {ProfileRevisionMap} */
  const revisions = {};
  for (const profile of data.profiles) {
    const id = /** @type {string} */ (profile.id);
    revisions[id] = normalizeClock(rawRevisions[id], fieldRevisions.profiles);
  }
  const presetIds = new Set(
    presets.map(normalizeProfile).filter(isNonNull).map((profile) => /** @type {string} */ (profile.id)),
  );
  const rawCounters = isRecord(rawMeta.counters) ? rawMeta.counters : {};
  const rawLog = isRecord(rawMeta.log) ? rawMeta.log : {};
  const clearFallback = data.logEpoch > 0 ? fieldRevisions.logEpoch : emptyClock();
  return {
    version: MERGE_METADATA_VERSION,
    resetClock: normalizeClock(rawMeta.resetClock, emptyClock()),
    profiles: {
      revisions,
      tombstones: normalizeProfileTombstones(rawProfiles.tombstones, presetIds),
      resetClock: normalizeClock(rawProfiles.resetClock, emptyClock()),
    },
    counters: {
      tombstones: normalizeCounterTombstones(rawCounters.tombstones),
      resetClock: normalizeClock(rawCounters.resetClock, emptyClock()),
    },
    log: {
      clearClock: normalizeClock(rawLog.clearClock, clearFallback),
    },
  };
}

/** @param {MergeMetadata} value @returns {MergeMetadata} */
function cloneMergeMetadata(value) {
  /** @type {ProfileRevisionMap} */
  const revisions = {};
  for (const [id, clock] of Object.entries(value.profiles.revisions)) revisions[id] = { ...clock };
  /** @type {ProfileRevisionMap} */
  const profileTombstones = {};
  for (const [id, clock] of Object.entries(value.profiles.tombstones)) profileTombstones[id] = { ...clock };
  /** @type {CounterTombstones} */
  const counterTombstones = {};
  for (const [id, pair] of Object.entries(value.counters.tombstones)) {
    counterTombstones[id] = {
      ...(pair.ELEVATION ? { ELEVATION: { ...pair.ELEVATION } } : {}),
      ...(pair.WINDAGE ? { WINDAGE: { ...pair.WINDAGE } } : {}),
    };
  }
  return {
    version: MERGE_METADATA_VERSION,
    resetClock: { ...value.resetClock },
    profiles: {
      revisions,
      tombstones: profileTombstones,
      resetClock: { ...value.profiles.resetClock },
    },
    counters: {
      tombstones: counterTombstones,
      resetClock: { ...value.counters.resetClock },
    },
    log: { clearClock: { ...value.log.clearClock } },
  };
}

/** @param {CounterSession} session @returns {RevisionClock} */
function counterSessionClock(session) {
  return { revision: session.revision, updatedAt: session.updatedAt, writerId: session.writerId };
}

/** @param {MergeMetadata} metadata @param {CounterSessions} counters @returns {RevisionClock[]} */
function metadataClocks(metadata, counters) {
  const clocks = [
    metadata.resetClock,
    metadata.profiles.resetClock,
    metadata.counters.resetClock,
    metadata.log.clearClock,
  ];
  clocks.push(...Object.values(metadata.profiles.revisions));
  clocks.push(...Object.values(metadata.profiles.tombstones));
  for (const pair of Object.values(metadata.counters.tombstones)) {
    if (pair.ELEVATION) clocks.push(pair.ELEVATION);
    if (pair.WINDAGE) clocks.push(pair.WINDAGE);
  }
  for (const pair of Object.values(counters)) {
    if (pair.ELEVATION) clocks.push(counterSessionClock(pair.ELEVATION));
    if (pair.WINDAGE) clocks.push(counterSessionClock(pair.WINDAGE));
  }
  return clocks;
}

/**
 * Apply remove-wins tombstones to the materialized v2 data view.
 *
 * @param {PersistedData} data
 * @param {MergeMetadata} metadata
 * @param {Record<string, RevisionClock>} fieldRevisions
 * @param {readonly unknown[]} presets
 * @returns {{ data: PersistedData, metadata: MergeMetadata }}
 */
function reconcileMaterializedData(data, metadata, fieldRevisions, presets) {
  const nextMetadata = cloneMergeMetadata(metadata);
  const presetIds = new Set(
    presets.map(normalizeProfile).filter(isNonNull).map((profile) => /** @type {string} */ (profile.id)),
  );
  const profiles = data.profiles.filter((profile) => {
    const id = /** @type {string} */ (profile.id);
    const revision = nextMetadata.profiles.revisions[id] ?? fieldRevisions.profiles;
    nextMetadata.profiles.revisions[id] = { ...revision };
    const tombstone = nextMetadata.profiles.tombstones[id];
    const resetSuppresses = !presetIds.has(id)
      && hasAdvancedClock(nextMetadata.profiles.resetClock)
      && compareRevisionClocks(revision, nextMetadata.profiles.resetClock) <= 0;
    if (!resetSuppresses
        && (presetIds.has(id) || !tombstone || compareRevisionClocks(revision, tombstone) > 0)) {
      if (tombstone) delete nextMetadata.profiles.tombstones[id];
      return true;
    }
    delete nextMetadata.profiles.revisions[id];
    return false;
  });

  /** @type {CounterSessions} */
  const counters = {};
  for (const [profileId, pair] of Object.entries(data.counters)) {
    /** @type {ProfileCounters} */
    const retained = {};
    for (const turret of /** @type {const} */ (["ELEVATION", "WINDAGE"])) {
      const session = pair[turret];
      if (!session) continue;
      const tombstone = nextMetadata.counters.tombstones[profileId]?.[turret];
      const sessionClock = counterSessionClock(session);
      const resetSuppresses = hasAdvancedClock(nextMetadata.counters.resetClock)
        && compareRevisionClocks(sessionClock, nextMetadata.counters.resetClock) <= 0;
      if (!resetSuppresses && (!tombstone || compareRevisionClocks(sessionClock, tombstone) > 0)) {
        retained[turret] = { ...session };
        if (tombstone) delete nextMetadata.counters.tombstones[profileId][turret];
      }
    }
    if (retained.ELEVATION || retained.WINDAGE) counters[profileId] = retained;
    const tombstonePair = nextMetadata.counters.tombstones[profileId];
    if (tombstonePair && !tombstonePair.ELEVATION && !tombstonePair.WINDAGE) {
      delete nextMetadata.counters.tombstones[profileId];
    }
  }

  const profileIds = new Set(profiles.map((profile) => /** @type {string} */ (profile.id)));
  const activeId = profileIds.has(data.activeId)
    ? data.activeId
    : profiles.length > 0
      ? /** @type {string} */ (profiles[0].id)
      : "";
  nextMetadata.profiles.tombstones = boundRevisionMap(
    nextMetadata.profiles.tombstones,
    MAX_PROFILE_TOMBSTONES,
  );
  nextMetadata.counters.tombstones = boundCounterTombstones(nextMetadata.counters.tombstones);
  return {
    data: {
      ...data,
      profiles,
      activeId,
      counters: normalizeCounterSessions(counters, profiles, { fallbackClock: fieldRevisions.counters }),
    },
    metadata: nextMetadata,
  };
}

/**
 * @param {PersistedData} data
 * @param {{ defaults?: PersistedData, presets?: readonly unknown[], revision?: number, writerId?: string, now?: number }} [options]
 * @returns {PersistedPayload}
 */
export function createVersionedPayload(data, options = {}) {
  const defaults = options.defaults ?? createPersistenceDefaults(data);
  const normalized = normalizePersistedData(data, { defaults, presets: options.presets }).data;
  const revision = integerInRange(options.revision, 0, 0, MAX_CLOCK);
  const updatedAt = integerInRange(options.now, 0, 0, MAX_CLOCK);
  const id = writerId(options.writerId);
  const clock = createClock(revision, updatedAt, id);
  /** @type {Record<string, RevisionClock>} */
  const fieldRevisions = {};
  for (const field of PERSISTED_FIELDS) fieldRevisions[field] = { ...clock };
  /** @type {CounterSessions} */
  const counters = {};
  for (const [profileId, pair] of Object.entries(normalized.counters)) {
    counters[profileId] = {
      ...(pair.ELEVATION ? { ELEVATION: { ...pair.ELEVATION, ...clock } } : {}),
      ...(pair.WINDAGE ? { WINDAGE: { ...pair.WINDAGE, ...clock } } : {}),
    };
  }
  /** @type {ProfileRevisionMap} */
  const profileRevisions = {};
  for (const profile of normalized.profiles) {
    profileRevisions[/** @type {string} */ (profile.id)] = { ...clock };
  }
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision,
    updatedAt,
    writerId: id,
    fieldRevisions,
    mergeMeta: {
      version: MERGE_METADATA_VERSION,
      resetClock: emptyClock(),
      profiles: { revisions: profileRevisions, tombstones: {}, resetClock: emptyClock() },
      counters: { tombstones: {}, resetClock: emptyClock() },
      log: { clearClock: normalized.logEpoch > 0 ? { ...clock } : emptyClock() },
    },
    data: { ...normalized, counters },
  };
}

/**
 * Safely parse JSON without throwing or logging potentially sensitive data.
 *
 * @param {string} raw
 * @returns {{ ok: true, value: unknown, error: null } | { ok: false, value: null, error: { code: string, message: string } }}
 */
export function safeParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch {
    return {
      ok: false,
      value: null,
      error: { code: "invalid-json", message: "Saved data is not valid JSON." },
    };
  }
}

/**
 * @param {unknown} value
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: true, serialized: string, bytes: number, error: null } | { ok: false, serialized: null, bytes: number, error: { code: string, message: string } }}
 */
export function safeSerializePayload(value, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_SERIALIZED_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      serialized: null,
      bytes: 0,
      error: { code: "invalid-limit", message: "Serialization byte limit is invalid." },
    };
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return {
        ok: false,
        serialized: null,
        bytes: 0,
        error: { code: "unserializable", message: "Data cannot be serialized." },
      };
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > maxBytes) {
      return {
        ok: false,
        serialized: null,
        bytes,
        error: { code: "too-large", message: "Saved data exceeds the storage safety limit." },
      };
    }
    return { ok: true, serialized, bytes, error: null };
  } catch {
    return {
      ok: false,
      serialized: null,
      bytes: 0,
      error: { code: "unserializable", message: "Data cannot be serialized." },
    };
  }
}

/**
 * Convert a payload-shaped object into the canonical current schema.
 *
 * @param {unknown} value
 * @param {{ defaults: PersistedData, presets?: readonly unknown[] }} options
 * @returns {PersistedPayload}
 */
function coerceCurrentPayload(value, { defaults, presets = [] }) {
  if (!isRecord(value)) return createVersionedPayload(defaults, { defaults, presets });
  const envelopeRevision = integerInRange(value.revision, 0, 0, MAX_CLOCK);
  const envelopeUpdatedAt = integerInRange(value.updatedAt, 0, 0, MAX_CLOCK);
  const envelopeWriter = writerId(value.writerId);
  const fallbackClock = createClock(envelopeRevision, envelopeUpdatedAt, envelopeWriter);
  const normalized = normalizePersistedData(value.data, { defaults, presets }).data;
  /** @type {Record<string, RevisionClock>} */
  const clocks = {};
  const rawClocks = isRecord(value.fieldRevisions) ? value.fieldRevisions : {};
  for (const field of PERSISTED_FIELDS) clocks[field] = normalizeClock(rawClocks[field], fallbackClock);
  const rawData = isRecord(value.data) ? value.data : {};
  normalized.counters = normalizeCounterSessions(
    isRecord(rawData.counters) ? rawData.counters : normalized.counters,
    normalized.profiles,
    { fallbackClock: clocks.counters },
  );
  const mergeMeta = normalizeMergeMetadata(value.mergeMeta, normalized, clocks, presets);
  const reconciled = reconcileMaterializedData(normalized, mergeMeta, clocks, presets);
  const extraClocks = metadataClocks(reconciled.metadata, reconciled.data.counters);
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision: Math.max(
      envelopeRevision,
      ...Object.values(clocks).map((clock) => clock.revision),
      ...extraClocks.map((clock) => clock.revision),
    ),
    updatedAt: Math.max(
      envelopeUpdatedAt,
      ...Object.values(clocks).map((clock) => clock.updatedAt),
      ...extraClocks.map((clock) => clock.updatedAt),
    ),
    writerId: envelopeWriter,
    fieldRevisions: clocks,
    mergeMeta: reconciled.metadata,
    data: reconciled.data,
  };
}

/**
 * Parse current or legacy localStorage content. Corruption recovers field-wise
 * to defaults; a future schema is not writable so newer data is never erased.
 *
 * @param {string | null | undefined} raw
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId?: string, now?: number }} options
 * @returns {{ ok: boolean, status: "empty" | "valid" | "recovered" | "migrated" | "unsupported-version", payload: PersistedPayload | null, issues: PersistenceIssue[], canSave: boolean }}
 */
export function parsePersistedPayload(raw, options) {
  const defaults = createPersistenceDefaults(options.defaults);
  const presets = options.presets ?? [];
  const now = integerInRange(options.now, 0, 0, MAX_CLOCK);
  const migrationWriter = writerId(options.writerId, "migration");
  if (raw == null || raw.trim() === "") {
    return {
      ok: true,
      status: "empty",
      payload: createVersionedPayload(defaults, { defaults, presets, writerId: migrationWriter, now }),
      issues: [],
      canSave: true,
    };
  }
  const parsed = safeParseJson(raw);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {
      ok: false,
      status: "recovered",
      payload: createVersionedPayload(defaults, { defaults, presets, writerId: migrationWriter, now }),
      issues: [{ path: "$", code: "invalid-json", message: "Saved data was unreadable; safe defaults were loaded." }],
      canSave: true,
    };
  }
  const value = parsed.value;
  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(value, "schemaVersion");
  const hasLegacyVersion = !hasSchemaVersion && Object.prototype.hasOwnProperty.call(value, "version");
  const rawDeclaredVersion = hasSchemaVersion ? value.schemaVersion : hasLegacyVersion ? value.version : 0;
  if (typeof rawDeclaredVersion === "number" && rawDeclaredVersion > PERSISTENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      status: "unsupported-version",
      payload: null,
      issues: [{
        path: "schemaVersion",
        code: "future-version",
        message: "Saved data was created by a newer version and was left untouched.",
      }],
      canSave: false,
    };
  }
  const declaredVersion = integerInRange(rawDeclaredVersion, -1, 0, PERSISTENCE_SCHEMA_VERSION);
  if ((hasSchemaVersion || hasLegacyVersion) && declaredVersion < 0) {
    return {
      ok: false,
      status: "unsupported-version",
      payload: null,
      issues: [{
        path: hasSchemaVersion ? "schemaVersion" : "version",
        code: "invalid-version",
        message: "Saved data declares an unrecognized version and was left untouched.",
      }],
      canSave: false,
    };
  }
  const hasMergeMetadata = Object.prototype.hasOwnProperty.call(value, "mergeMeta");
  if (declaredVersion === PERSISTENCE_SCHEMA_VERSION
      && hasMergeMetadata
      && (!isRecord(value.mergeMeta) || value.mergeMeta.version !== MERGE_METADATA_VERSION)) {
    const futureMetadata = isRecord(value.mergeMeta)
      && typeof value.mergeMeta.version === "number"
      && value.mergeMeta.version > MERGE_METADATA_VERSION;
    return {
      ok: false,
      status: "unsupported-version",
      payload: null,
      issues: [{
        path: "mergeMeta.version",
        code: futureMetadata ? "future-metadata-version" : "invalid-metadata-version",
        message: futureMetadata
          ? "Saved data uses newer merge metadata and was left untouched."
          : "Saved data declares unrecognized merge metadata and was left untouched.",
      }],
      canSave: false,
    };
  }
  if (declaredVersion === PERSISTENCE_SCHEMA_VERSION && isRecord(value.data)) {
    const normalizedData = normalizePersistedData(value.data, { defaults, presets });
    const payload = coerceCurrentPayload(value, { defaults, presets });
    return {
      ok: normalizedData.issues.length === 0,
      status: normalizedData.issues.length === 0 ? "valid" : "recovered",
      payload,
      issues: normalizedData.issues,
      canSave: true,
    };
  }

  const legacySource = declaredVersion > 0 && isRecord(value.data) ? value.data : value;
  const normalizedData = normalizePersistedData(legacySource, { defaults, presets });
  const payload = createVersionedPayload(normalizedData.data, {
    defaults,
    presets,
    revision: 1,
    writerId: migrationWriter,
    now,
  });
  return {
    ok: true,
    status: "migrated",
    payload,
    issues: [{
      path: "schemaVersion",
      code: "migrated",
      message: `Migrated saved data to schema ${PERSISTENCE_SCHEMA_VERSION}.`,
    }, ...normalizedData.issues],
    canSave: true,
  };
}

/**
 * Compare revision clocks deterministically.
 *
 * @param {RevisionClock} left
 * @param {RevisionClock} right
 * @returns {-1 | 0 | 1}
 */
export function compareRevisionClocks(left, right) {
  if (left.revision !== right.revision) return left.revision > right.revision ? 1 : -1;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
  const writerComparison = left.writerId.localeCompare(right.writerId);
  return writerComparison === 0 ? 0 : writerComparison > 0 ? 1 : -1;
}

/** @param {unknown} value @returns {string} */
function stableComparable(value) {
  const serialized = safeSerializePayload(value);
  return serialized.ok ? serialized.serialized : "";
}

/**
 * @param {PersistedPayload} current
 * @param {readonly Record<string, unknown>[]} nextProfiles
 * @param {RevisionClock} commitClock
 * @param {MergeMetadata} metadata
 */
function applyProfileCommitMetadata(current, nextProfiles, commitClock, metadata) {
  const currentById = new Map(
    current.data.profiles.map((profile) => [/** @type {string} */ (profile.id), profile]),
  );
  const nextById = new Map(nextProfiles.map((profile) => [/** @type {string} */ (profile.id), profile]));
  for (const [id, currentProfile] of currentById) {
    if (nextById.has(id)) continue;
    metadata.profiles.tombstones[id] = { ...commitClock };
    delete metadata.profiles.revisions[id];
    // A deleted profile cannot retain materialized counter sessions.
    const currentPair = current.data.counters[id];
    if (currentPair) {
      const pair = metadata.counters.tombstones[id] ?? {};
      if (currentPair.ELEVATION) pair.ELEVATION = { ...commitClock };
      if (currentPair.WINDAGE) pair.WINDAGE = { ...commitClock };
      metadata.counters.tombstones[id] = pair;
    }
    void currentProfile;
  }
  for (const [id, nextProfile] of nextById) {
    const currentProfile = currentById.get(id);
    const changed = !currentProfile || stableComparable(currentProfile) !== stableComparable(nextProfile);
    const revision = changed
      ? commitClock
      : current.mergeMeta.profiles.revisions[id] ?? current.fieldRevisions.profiles;
    metadata.profiles.revisions[id] = { ...revision };
    const tombstone = metadata.profiles.tombstones[id];
    if (tombstone && compareRevisionClocks(revision, tombstone) > 0) {
      delete metadata.profiles.tombstones[id];
    }
  }
  metadata.profiles.tombstones = boundRevisionMap(metadata.profiles.tombstones, MAX_PROFILE_TOMBSTONES);
}

/** @param {CounterSession | undefined} left @param {CounterSession | undefined} right @returns {boolean} */
function sameCounterValue(left, right) {
  return Boolean(left && right && left.count === right.count && left.done === right.done);
}

/**
 * Stamp changed sessions and create remove-wins tombstones for sessions omitted
 * by an explicit reset or by profile deletion.
 *
 * @param {PersistedPayload} current
 * @param {CounterSessions} requested
 * @param {RevisionClock} commitClock
 * @param {MergeMetadata} metadata
 * @returns {CounterSessions}
 */
function applyCounterCommitMetadata(current, requested, commitClock, metadata) {
  /** @type {CounterSessions} */
  const counters = {};
  const ids = new Set([...Object.keys(current.data.counters), ...Object.keys(requested)]);
  for (const profileId of ids) {
    /** @type {ProfileCounters} */
    const pair = {};
    const tombstonePair = metadata.counters.tombstones[profileId] ?? {};
    for (const turret of /** @type {const} */ (["ELEVATION", "WINDAGE"])) {
      const before = current.data.counters[profileId]?.[turret];
      const after = requested[profileId]?.[turret];
      if (!after) {
        if (before) tombstonePair[turret] = { ...commitClock };
        continue;
      }
      const session = sameCounterValue(before, after)
        ? /** @type {CounterSession} */ ({ ...before })
        : { ...after, ...commitClock };
      const tombstone = tombstonePair[turret];
      if (!tombstone || compareRevisionClocks(counterSessionClock(session), tombstone) > 0) {
        pair[turret] = session;
        if (tombstone) delete tombstonePair[turret];
      }
    }
    if (pair.ELEVATION || pair.WINDAGE) counters[profileId] = pair;
    if (tombstonePair.ELEVATION || tombstonePair.WINDAGE) {
      metadata.counters.tombstones[profileId] = tombstonePair;
    } else {
      delete metadata.counters.tombstones[profileId];
    }
  }
  metadata.counters.tombstones = boundCounterTombstones(metadata.counters.tombstones);
  return counters;
}

/**
 * Advance only the fields in a patch. Invalid fields recover to the current
 * value. An explicit empty log writes a clear tombstone and advances its
 * legacy numeric generation when that counter still has room. Non-empty log
 * and profile arrays are replacement snapshots; interactive callers must use
 * `commitLogAppend` and the profile mutation helpers so stale UI snapshots are
 * not mistaken for deletions.
 *
 * @param {PersistedPayload} payload
 * @param {Partial<PersistedData>} patch
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number }} options
 * @returns {PersistedPayload}
 */
export function commitPersistedPatch(payload, patch, options) {
  const current = coerceCurrentPayload(payload, options);
  /** @type {Record<string, unknown>} */
  const allowedPatch = {};
  for (const [field, value] of Object.entries(patch)) {
    if (PERSISTED_FIELD_SET.has(/** @type {PersistedField} */ (field))) allowedPatch[field] = value;
  }
  const explicitLogClear = Object.prototype.hasOwnProperty.call(allowedPatch, "log")
    && Array.isArray(allowedPatch.log)
    && allowedPatch.log.length === 0;
  if (explicitLogClear && !Object.prototype.hasOwnProperty.call(allowedPatch, "logEpoch")) {
    allowedPatch.logEpoch = Math.min(MAX_CLOCK, current.data.logEpoch + 1);
  }
  const normalized = normalizePersistedData(
    { ...current.data, ...allowedPatch },
    { defaults: current.data, presets: options.presets },
  ).data;
  const nextRevision = Math.min(MAX_CLOCK, current.revision + 1);
  const requestedNow = integerInRange(options.now, current.updatedAt, 0, MAX_CLOCK);
  const now = nextRevision === current.revision && requestedNow <= current.updatedAt
    ? Math.min(MAX_CLOCK, current.updatedAt + 1)
    : requestedNow;
  const id = writerId(options.writerId, current.writerId);
  const commitClock = createClock(nextRevision, now, id);
  const mergeMeta = cloneMergeMetadata(current.mergeMeta);
  applyProfileCommitMetadata(current, normalized.profiles, commitClock, mergeMeta);
  normalized.counters = applyCounterCommitMetadata(
    current,
    normalized.counters,
    commitClock,
    mergeMeta,
  );
  if (explicitLogClear) mergeMeta.log.clearClock = { ...commitClock };
  /** @type {Record<string, RevisionClock>} */
  const fieldRevisions = { ...current.fieldRevisions };
  for (const field of PERSISTED_FIELDS) {
    const explicitlyPatched = Object.prototype.hasOwnProperty.call(allowedPatch, field);
    const changed = stableComparable(current.data[field]) !== stableComparable(normalized[field]);
    if (explicitlyPatched || changed) fieldRevisions[field] = { ...commitClock };
  }
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision: nextRevision,
    updatedAt: now,
    writerId: id,
    fieldRevisions,
    mergeMeta,
    data: normalized,
  };
}

/**
 * Append one log record against the already-rebased envelope. Unlike a full
 * array patch, this never carries pre-clear records from stale UI state.
 *
 * @param {PersistedPayload} payload
 * @param {LogEntry | Record<string, unknown>} entry
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number }} options
 * @returns {PersistedPayload}
 */
export function commitLogAppend(payload, entry, options) {
  const current = coerceCurrentPayload(payload, options);
  const normalizedEntry = normalizeLogs([entry]);
  if (normalizedEntry.length !== 1) throw new TypeError("log entry is invalid.");
  return commitPersistedPatch(
    current,
    { log: mergeLogsById(current.data.log, normalizedEntry) },
    options,
  );
}

/**
 * Record an explicit reset floor for both axes, including axes that were absent
 * from the rebased materialized view.
 *
 * @param {PersistedPayload} payload
 * @param {Iterable<string>} profileIds
 * @returns {PersistedPayload}
 */
function addCounterResetTombstones(payload, profileIds) {
  const mergeMeta = cloneMergeMetadata(payload.mergeMeta);
  const clock = payload.fieldRevisions.counters;
  for (const profileId of profileIds) {
    mergeMeta.counters.tombstones[profileId] = {
      ELEVATION: { ...clock },
      WINDAGE: { ...clock },
    };
  }
  mergeMeta.counters.tombstones = boundCounterTombstones(mergeMeta.counters.tombstones);
  return { ...payload, mergeMeta };
}

/**
 * Upsert exactly one profile against the rebased envelope, preserving profiles
 * created or edited by other tabs.
 *
 * @param {PersistedPayload} payload
 * @param {Record<string, unknown>} profile
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number, activate?: boolean, resetCounters?: boolean }} options
 * @returns {PersistedPayload}
 */
export function commitProfileUpsert(payload, profile, options) {
  const current = coerceCurrentPayload(payload, options);
  const normalizedProfile = normalizeProfile(profile);
  if (!normalizedProfile) throw new TypeError("profile is invalid.");
  const profileId = /** @type {string} */ (normalizedProfile.id);
  const index = current.data.profiles.findIndex((candidate) => candidate.id === profileId);
  if (index < 0 && current.data.profiles.length >= COLLECTION_LIMITS.profiles) {
    throw new RangeError(`profiles are limited to ${COLLECTION_LIMITS.profiles}.`);
  }
  const profiles = [...current.data.profiles];
  if (index >= 0) profiles[index] = normalizedProfile;
  else profiles.push(normalizedProfile);
  const counters = options.resetCounters
    ? Object.fromEntries(Object.entries(current.data.counters).filter(([id]) => id !== profileId))
    : current.data.counters;
  const committed = commitPersistedPatch(current, {
    profiles,
    ...(options.activate ? { activeId: profileId } : {}),
    ...(options.resetCounters ? { counters } : {}),
  }, options);
  return options.resetCounters ? addCounterResetTombstones(committed, [profileId]) : committed;
}

/**
 * Create a new profile as the same physical optic as an existing profile.
 * Both turret sessions are copied in the same commit so correcting preset
 * metadata cannot strand an in-progress mechanical-centering count.
 *
 * @param {PersistedPayload} payload
 * @param {string} sourceProfileId
 * @param {Record<string, unknown>} clonedProfile
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number, activate?: boolean }} options
 * @returns {PersistedPayload}
 */
export function commitProfileClone(payload, sourceProfileId, clonedProfile, options) {
  const current = coerceCurrentPayload(payload, options);
  if (!current.data.profiles.some((profile) => profile.id === sourceProfileId)) {
    throw new RangeError("source profile does not exist.");
  }
  const normalizedClone = normalizeProfile(clonedProfile);
  if (!normalizedClone) throw new TypeError("cloned profile is invalid.");
  const cloneId = /** @type {string} */ (normalizedClone.id);
  if (cloneId === sourceProfileId) throw new RangeError("clone profile must have a new id.");
  if (current.data.profiles.some((profile) => profile.id === cloneId)) {
    throw new RangeError("clone profile id already exists.");
  }
  if (current.data.profiles.length >= COLLECTION_LIMITS.profiles) {
    throw new RangeError(`profiles are limited to ${COLLECTION_LIMITS.profiles}.`);
  }

  const sourceCounters = current.data.counters[sourceProfileId];
  const clonedCounters = sourceCounters ? {
    ...(sourceCounters.ELEVATION ? { ELEVATION: { ...sourceCounters.ELEVATION } } : {}),
    ...(sourceCounters.WINDAGE ? { WINDAGE: { ...sourceCounters.WINDAGE } } : {}),
  } : null;
  const counters = clonedCounters
    ? { ...current.data.counters, [cloneId]: clonedCounters }
    : current.data.counters;
  return commitPersistedPatch(current, {
    profiles: [...current.data.profiles, normalizedClone],
    ...(options.activate ? { activeId: cloneId } : {}),
    ...(clonedCounters ? { counters } : {}),
  }, options);
}

/**
 * Delete one profile from the rebased envelope. The generic commit records a
 * profile tombstone and counter tombstones for any removed sessions.
 *
 * @param {PersistedPayload} payload
 * @param {string} profileId
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number, nextActiveId?: string }} options
 * @returns {PersistedPayload}
 */
export function commitProfileDelete(payload, profileId, options) {
  const current = coerceCurrentPayload(payload, options);
  const existing = current.data.profiles.find((profile) => profile.id === profileId);
  if (!existing) return current;
  if (existing.builtin === true) throw new RangeError("built-in profiles cannot be deleted.");
  const profiles = current.data.profiles.filter((profile) => profile.id !== profileId);
  const counters = Object.fromEntries(
    Object.entries(current.data.counters).filter(([id]) => id !== profileId),
  );
  const requestedActive = typeof options.nextActiveId === "string" ? options.nextActiveId : current.data.activeId;
  const activeId = profiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : profiles.length > 0
      ? /** @type {string} */ (profiles[0].id)
      : "";
  return addCounterResetTombstones(
    commitPersistedPatch(current, { profiles, counters, activeId }, options),
    [profileId],
  );
}

/**
 * Reset only the supplied profile IDs, preserving custom profiles and other
 * concurrent entities. Counter sessions for reset IDs are tombstoned by
 * default; pass `resetCounters: false` when restoring specifications only.
 *
 * @param {PersistedPayload} payload
 * @param {readonly Record<string, unknown>[]} resetProfiles
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number, resetCounters?: boolean }} options
 * @returns {PersistedPayload}
 */
export function commitProfilesReset(payload, resetProfiles, options) {
  const current = coerceCurrentPayload(payload, options);
  const normalizedResets = resetProfiles.map(normalizeProfile);
  if (normalizedResets.some((profile) => profile === null)) throw new TypeError("reset profile is invalid.");
  const resets = /** @type {Record<string, unknown>[]} */ (normalizedResets);
  const resetById = new Map(resets.map((profile) => [/** @type {string} */ (profile.id), profile]));
  const profiles = current.data.profiles.map((profile) => (
    resetById.get(/** @type {string} */ (profile.id)) ?? profile
  ));
  const existingIds = new Set(profiles.map((profile) => /** @type {string} */ (profile.id)));
  for (const profile of resets) {
    const id = /** @type {string} */ (profile.id);
    if (!existingIds.has(id)) {
      profiles.push(profile);
      existingIds.add(id);
    }
  }
  if (profiles.length > COLLECTION_LIMITS.profiles) {
    throw new RangeError(`profiles are limited to ${COLLECTION_LIMITS.profiles}.`);
  }
  const resetIds = new Set(resetById.keys());
  const shouldResetCounters = options.resetCounters !== false;
  if (!shouldResetCounters) return commitPersistedPatch(current, { profiles }, options);
  const counters = Object.fromEntries(Object.entries(current.data.counters).filter(([id]) => !resetIds.has(id)));
  return addCounterResetTombstones(commitPersistedPatch(current, { profiles, counters }, options), resetIds);
}

/**
 * Reset all user data against a rebased envelope. The factory-reset generation
 * makes the resulting snapshot authoritative over any payload that did not
 * observe this reset, even if that stale branch accumulated more local edits.
 *
 * @param {PersistedPayload} payload
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number }} options
 * @returns {PersistedPayload}
 */
export function commitFactoryReset(payload, options) {
  const current = coerceCurrentPayload(payload, options);
  const presetProfiles = normalizeProfiles(options.presets ?? options.defaults.profiles, []);
  const resetDefaults = createPersistenceDefaults({
    profiles: presetProfiles,
    activeId: options.defaults.activeId,
    units: options.defaults.units,
    distance: options.defaults.distance,
    span: options.defaults.span,
    log: [],
    mode: options.defaults.mode,
    entryMode: options.defaults.entryMode,
    counters: {},
  });
  const committed = commitPersistedPatch(current, {
    profiles: resetDefaults.profiles,
    activeId: resetDefaults.activeId,
    units: resetDefaults.units,
    distance: resetDefaults.distance,
    span: resetDefaults.span,
    log: [],
    mode: resetDefaults.mode,
    entryMode: resetDefaults.entryMode,
    counters: {},
  }, options);
  const mergeMeta = cloneMergeMetadata(committed.mergeMeta);
  const resetClock = { ...committed.fieldRevisions.profiles };
  mergeMeta.resetClock = resetClock;
  mergeMeta.profiles.resetClock = { ...resetClock };
  mergeMeta.counters.resetClock = { ...committed.fieldRevisions.counters };
  for (const profile of committed.data.profiles) {
    mergeMeta.profiles.revisions[/** @type {string} */ (profile.id)] = { ...resetClock };
  }
  mergeMeta.profiles.tombstones = boundRevisionMap(
    mergeMeta.profiles.tombstones,
    MAX_PROFILE_TOMBSTONES,
  );
  mergeMeta.counters.tombstones = boundCounterTombstones(mergeMeta.counters.tombstones);
  return { ...committed, mergeMeta };
}

/**
 * Persist a counter independently for each profile and turret.
 *
 * @param {PersistedPayload} payload
 * @param {{ profileId: string, turret: Turret, count: number, done: boolean }} update
 * @param {{ defaults: PersistedData, presets?: readonly unknown[], writerId: string, now: number }} options
 * @returns {PersistedPayload}
 */
export function commitCounterSession(payload, update, options) {
  const current = coerceCurrentPayload(payload, options);
  if (!current.data.profiles.some((profile) => profile.id === update.profileId)) {
    throw new RangeError("Counter profile does not exist.");
  }
  if (update.turret !== "ELEVATION" && update.turret !== "WINDAGE") {
    throw new RangeError("turret must be ELEVATION or WINDAGE.");
  }
  if (!Number.isSafeInteger(update.count) || update.count < 0 || update.count > MAX_COUNTER_CLICKS) {
    throw new RangeError(`counter count must be a non-negative integer no greater than ${MAX_COUNTER_CLICKS}.`);
  }
  const nextRevision = Math.min(MAX_CLOCK, current.revision + 1);
  const now = integerInRange(options.now, current.updatedAt, 0, MAX_CLOCK);
  const id = writerId(options.writerId, current.writerId);
  const pair = current.data.counters[update.profileId] ?? {};
  const counters = {
    ...current.data.counters,
    [update.profileId]: {
      ...pair,
      [update.turret]: {
        count: update.count,
        done: update.done === true,
        revision: nextRevision,
        updatedAt: now,
        writerId: id,
      },
    },
  };
  return commitPersistedPatch(current, { counters }, options);
}

/**
 * @param {CounterSessions} counters
 * @param {string} profileId
 * @param {Turret} turret
 * @returns {CounterSession}
 */
export function getCounterSession(counters, profileId, turret) {
  const session = counters[profileId]?.[turret];
  return session
    ? { ...session }
    : { count: 0, done: false, revision: 0, updatedAt: 0, writerId: "unknown" };
}

/**
 * @param {CounterSession | undefined} left
 * @param {CounterSession | undefined} right
 * @returns {CounterSession | undefined}
 */
function mergeCounterSession(left, right) {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  const comparison = compareRevisionClocks(left, right);
  if (comparison > 0) return { ...left };
  if (comparison < 0) return { ...right };
  return stableComparable(left) >= stableComparable(right) ? { ...left } : { ...right };
}

/**
 * @param {CounterSessions} left
 * @param {CounterSessions} right
 * @param {CounterTombstones} leftTombstones
 * @param {CounterTombstones} rightTombstones
 * @returns {{ counters: CounterSessions, tombstones: CounterTombstones }}
 */
function mergeCounters(left, right, leftTombstones, rightTombstones) {
  /** @type {CounterSessions} */
  const merged = {};
  /** @type {CounterTombstones} */
  const tombstones = {};
  const ids = new Set([
    ...Object.keys(left),
    ...Object.keys(right),
    ...Object.keys(leftTombstones),
    ...Object.keys(rightTombstones),
  ]);
  for (const profileId of ids) {
    /** @type {ProfileCounters} */
    const pair = {};
    /** @type {ProfileCounterTombstones} */
    const tombstonePair = {};
    for (const turret of /** @type {const} */ (["ELEVATION", "WINDAGE"])) {
      const session = mergeCounterSession(left[profileId]?.[turret], right[profileId]?.[turret]);
      const leftTombstone = leftTombstones[profileId]?.[turret];
      const rightTombstone = rightTombstones[profileId]?.[turret];
      const tombstone = leftTombstone && rightTombstone
        ? newestClock(leftTombstone, rightTombstone)
        : leftTombstone
          ? { ...leftTombstone }
          : rightTombstone
            ? { ...rightTombstone }
            : undefined;
      if (session && (!tombstone || compareRevisionClocks(counterSessionClock(session), tombstone) > 0)) {
        pair[turret] = session;
      } else if (tombstone) {
        tombstonePair[turret] = tombstone;
      }
    }
    if (pair.ELEVATION || pair.WINDAGE) merged[profileId] = pair;
    if (tombstonePair.ELEVATION || tombstonePair.WINDAGE) tombstones[profileId] = tombstonePair;
  }
  return { counters: merged, tombstones: boundCounterTombstones(tombstones) };
}

/**
 * Merge profiles as independent remove-wins registers. Array order follows the
 * deterministically newer collection, with concurrent unique IDs appended.
 *
 * @param {PersistedPayload} left
 * @param {PersistedPayload} right
 * @param {readonly unknown[]} presets
 * @returns {{ profiles: Record<string, unknown>[], revisions: ProfileRevisionMap, tombstones: ProfileRevisionMap }}
 */
function mergeProfiles(left, right, presets) {
  const leftProfiles = new Map(
    left.data.profiles.map((profile) => [/** @type {string} */ (profile.id), profile]),
  );
  const rightProfiles = new Map(
    right.data.profiles.map((profile) => [/** @type {string} */ (profile.id), profile]),
  );
  const ids = new Set([
    ...leftProfiles.keys(),
    ...rightProfiles.keys(),
    ...Object.keys(left.mergeMeta.profiles.tombstones),
    ...Object.keys(right.mergeMeta.profiles.tombstones),
  ]);
  /** @type {Map<string, { profile: Record<string, unknown>, clock: RevisionClock }>} */
  const live = new Map();
  /** @type {ProfileRevisionMap} */
  const tombstones = {};
  for (const id of ids) {
    const leftProfile = leftProfiles.get(id);
    const rightProfile = rightProfiles.get(id);
    const leftClock = leftProfile
      ? left.mergeMeta.profiles.revisions[id] ?? left.fieldRevisions.profiles
      : null;
    const rightClock = rightProfile
      ? right.mergeMeta.profiles.revisions[id] ?? right.fieldRevisions.profiles
      : null;
    let winner = null;
    if (leftProfile && leftClock && rightProfile && rightClock) {
      const comparison = compareRevisionClocks(leftClock, rightClock);
      const takeLeft = comparison > 0
        || (comparison === 0 && stableComparable(leftProfile) >= stableComparable(rightProfile));
      winner = takeLeft
        ? { profile: leftProfile, clock: leftClock }
        : { profile: rightProfile, clock: rightClock };
    } else if (leftProfile && leftClock) {
      winner = { profile: leftProfile, clock: leftClock };
    } else if (rightProfile && rightClock) {
      winner = { profile: rightProfile, clock: rightClock };
    }
    const leftTombstone = left.mergeMeta.profiles.tombstones[id];
    const rightTombstone = right.mergeMeta.profiles.tombstones[id];
    const tombstone = leftTombstone && rightTombstone
      ? newestClock(leftTombstone, rightTombstone)
      : leftTombstone
        ? { ...leftTombstone }
        : rightTombstone
          ? { ...rightTombstone }
          : null;
    if (winner && (!tombstone || compareRevisionClocks(winner.clock, tombstone) > 0)) {
      live.set(id, winner);
    } else if (tombstone) {
      tombstones[id] = tombstone;
    }
  }

  const fieldComparison = compareRevisionClocks(
    left.fieldRevisions.profiles,
    right.fieldRevisions.profiles,
  );
  const leftFirst = fieldComparison > 0
    || (fieldComparison === 0 && stableComparable(left.data.profiles) >= stableComparable(right.data.profiles));
  const primary = leftFirst ? left.data.profiles : right.data.profiles;
  const secondary = leftFirst ? right.data.profiles : left.data.profiles;
  const orderedIds = [];
  const seen = new Set();
  for (const profile of [...primary, ...secondary]) {
    const id = /** @type {string} */ (profile.id);
    if (live.has(id) && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  for (const id of [...live.keys()].sort(compareText)) {
    if (!seen.has(id)) orderedIds.push(id);
  }
  const profiles = normalizeProfiles(
    orderedIds.map((id) => /** @type {{ profile: Record<string, unknown> }} */ (live.get(id)).profile),
    presets,
  );
  /** @type {ProfileRevisionMap} */
  const revisions = {};
  const retainedIds = new Set();
  for (const profile of profiles) {
    const id = /** @type {string} */ (profile.id);
    retainedIds.add(id);
    revisions[id] = { ...(
      live.get(id)?.clock
      ?? left.mergeMeta.profiles.revisions[id]
      ?? right.mergeMeta.profiles.revisions[id]
      ?? newestClock(left.fieldRevisions.profiles, right.fieldRevisions.profiles)
    ) };
    delete tombstones[id];
  }
  for (const [id, candidate] of live) {
    if (!retainedIds.has(id)) tombstones[id] = { ...candidate.clock };
  }
  return {
    profiles,
    revisions,
    tombstones: boundRevisionMap(tombstones, MAX_PROFILE_TOMBSTONES),
  };
}

/**
 * Merge newest-first records by stable id. Used for concurrent log appends.
 *
 * @param {readonly LogEntry[]} left
 * @param {readonly LogEntry[]} right
 * @returns {LogEntry[]}
 */
export function mergeLogsById(left, right) {
  /** @type {Map<string, LogEntry>} */
  const byId = new Map();
  for (const entry of [...left, ...right]) {
    const current = byId.get(entry.id);
    if (!current || entry.ts > current.ts || (entry.ts === current.ts && stableComparable(entry) > stableComparable(current))) {
      byId.set(entry.id, entry);
    }
  }
  return normalizeLogs([...byId.values()]);
}

/**
 * Merge two tabs field-by-field. Unrelated newer edits are preserved. Logs in
 * the same generation are unioned; a later clear generation wins. Counter
 * sessions are merged independently by profile and turret.
 *
 * @param {PersistedPayload} leftValue
 * @param {PersistedPayload} rightValue
 * @param {{ defaults: PersistedData, presets?: readonly unknown[] }} options
 * @returns {PersistedPayload}
 */
export function mergePersistedPayloads(leftValue, rightValue, options) {
  const left = coerceCurrentPayload(leftValue, options);
  const right = coerceCurrentPayload(rightValue, options);
  const factoryResetComparison = compareRevisionClocks(
    left.mergeMeta.resetClock,
    right.mergeMeta.resetClock,
  );
  if (factoryResetComparison !== 0) {
    const selected = factoryResetComparison > 0 ? left : right;
    const leftEnvelope = createClock(left.revision, left.updatedAt, left.writerId);
    const rightEnvelope = createClock(right.revision, right.updatedAt, right.writerId);
    const envelopeWinner = compareRevisionClocks(leftEnvelope, rightEnvelope) >= 0
      ? leftEnvelope
      : rightEnvelope;
    return {
      ...selected,
      revision: Math.max(left.revision, right.revision),
      updatedAt: Math.max(left.updatedAt, right.updatedAt),
      writerId: envelopeWinner.writerId,
      fieldRevisions: Object.fromEntries(
        Object.entries(selected.fieldRevisions).map(([field, clock]) => [field, { ...clock }]),
      ),
      mergeMeta: cloneMergeMetadata(selected.mergeMeta),
      data: normalizePersistedData(selected.data, options).data,
    };
  }
  /** @type {Record<string, unknown>} */
  const mergedData = {};
  /** @type {Record<string, RevisionClock>} */
  const mergedClocks = {};
  for (const field of PERSISTED_FIELDS) {
    const comparison = compareRevisionClocks(left.fieldRevisions[field], right.fieldRevisions[field]);
    const leftValueForField = left.data[field];
    const rightValueForField = right.data[field];
    const takeLeft = comparison > 0
      || (comparison === 0 && stableComparable(leftValueForField) >= stableComparable(rightValueForField));
    mergedData[field] = takeLeft ? leftValueForField : rightValueForField;
    mergedClocks[field] = { ...(takeLeft ? left.fieldRevisions[field] : right.fieldRevisions[field]) };
  }

  const profileMerge = mergeProfiles(left, right, options.presets ?? []);
  mergedData.profiles = profileMerge.profiles;
  mergedClocks.profiles = newestClock(left.fieldRevisions.profiles, right.fieldRevisions.profiles);

  let logClearClock;
  if (left.data.logEpoch === right.data.logEpoch) {
    const clearComparison = compareRevisionClocks(
      left.mergeMeta.log.clearClock,
      right.mergeMeta.log.clearClock,
    );
    if (clearComparison > 0) {
      mergedData.log = left.data.log;
      mergedClocks.log = { ...left.fieldRevisions.log };
      mergedClocks.logEpoch = { ...left.fieldRevisions.logEpoch };
      logClearClock = { ...left.mergeMeta.log.clearClock };
    } else if (clearComparison < 0) {
      mergedData.log = right.data.log;
      mergedClocks.log = { ...right.fieldRevisions.log };
      mergedClocks.logEpoch = { ...right.fieldRevisions.logEpoch };
      logClearClock = { ...right.mergeMeta.log.clearClock };
    } else {
      mergedData.log = mergeLogsById(left.data.log, right.data.log);
      mergedClocks.log = newestClock(left.fieldRevisions.log, right.fieldRevisions.log);
      mergedClocks.logEpoch = newestClock(left.fieldRevisions.logEpoch, right.fieldRevisions.logEpoch);
      logClearClock = { ...left.mergeMeta.log.clearClock };
    }
    mergedData.logEpoch = left.data.logEpoch;
  } else if (left.data.logEpoch > right.data.logEpoch) {
    mergedData.log = left.data.log;
    mergedData.logEpoch = left.data.logEpoch;
    mergedClocks.log = { ...left.fieldRevisions.log };
    mergedClocks.logEpoch = { ...left.fieldRevisions.logEpoch };
    logClearClock = { ...left.mergeMeta.log.clearClock };
  } else {
    mergedData.log = right.data.log;
    mergedData.logEpoch = right.data.logEpoch;
    mergedClocks.log = { ...right.fieldRevisions.log };
    mergedClocks.logEpoch = { ...right.fieldRevisions.logEpoch };
    logClearClock = { ...right.mergeMeta.log.clearClock };
  }
  const counterMerge = mergeCounters(
    left.data.counters,
    right.data.counters,
    left.mergeMeta.counters.tombstones,
    right.mergeMeta.counters.tombstones,
  );
  mergedData.counters = counterMerge.counters;
  mergedClocks.counters = newestClock(left.fieldRevisions.counters, right.fieldRevisions.counters);

  const normalized = normalizePersistedData(mergedData, options).data;
  const mergeMeta = {
    version: /** @type {1} */ (MERGE_METADATA_VERSION),
    resetClock: newestClock(left.mergeMeta.resetClock, right.mergeMeta.resetClock),
    profiles: {
      revisions: profileMerge.revisions,
      tombstones: profileMerge.tombstones,
      resetClock: newestClock(
        left.mergeMeta.profiles.resetClock,
        right.mergeMeta.profiles.resetClock,
      ),
    },
    counters: {
      tombstones: counterMerge.tombstones,
      resetClock: newestClock(
        left.mergeMeta.counters.resetClock,
        right.mergeMeta.counters.resetClock,
      ),
    },
    log: { clearClock: logClearClock },
  };
  const reconciled = reconcileMaterializedData(
    normalized,
    mergeMeta,
    mergedClocks,
    options.presets ?? [],
  );
  const leftEnvelope = createClock(left.revision, left.updatedAt, left.writerId);
  const rightEnvelope = createClock(right.revision, right.updatedAt, right.writerId);
  const envelopeWinner = compareRevisionClocks(leftEnvelope, rightEnvelope) >= 0 ? leftEnvelope : rightEnvelope;
  const extraClocks = metadataClocks(reconciled.metadata, reconciled.data.counters);
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    revision: Math.max(
      left.revision,
      right.revision,
      ...Object.values(mergedClocks).map((clock) => clock.revision),
      ...extraClocks.map((clock) => clock.revision),
    ),
    updatedAt: Math.max(
      left.updatedAt,
      right.updatedAt,
      ...Object.values(mergedClocks).map((clock) => clock.updatedAt),
      ...extraClocks.map((clock) => clock.updatedAt),
    ),
    writerId: envelopeWinner.writerId,
    fieldRevisions: mergedClocks,
    mergeMeta: reconciled.metadata,
    data: reconciled.data,
  };
}

/**
 * Read and validate from a Storage-like object without throwing.
 *
 * @param {StorageLike} storage
 * @param {{ key?: string, defaults: PersistedData, presets?: readonly unknown[], writerId?: string, now?: number }} options
 * @returns {ReturnType<typeof parsePersistedPayload>}
 */
export function loadPersistedPayload(storage, options) {
  try {
    const key = options.key ?? STORAGE_KEY;
    let raw = storage.getItem(key);
    if (raw == null && key === STORAGE_KEY) {
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        raw = storage.getItem(legacyKey);
        if (raw != null) break;
      }
    }
    return parsePersistedPayload(raw, options);
  } catch {
    return {
      ok: false,
      status: /** @type {const} */ ("recovered"),
      payload: createVersionedPayload(options.defaults, options),
      issues: [{ path: "$storage", code: "read-failed", message: "Saved data could not be read." }],
      canSave: false,
    };
  }
}

/**
 * Synchronously save an explicit commit. The result must be surfaced by the UI
 * so quota/private-mode failures are not silently ignored.
 *
 * @param {StorageLike} storage
 * @param {PersistedPayload} payload
 * @param {{ key?: string, maxBytes?: number }} [options]
 * @returns {{ ok: true, bytes: number, error: null } | { ok: false, bytes: number, error: { code: string, message: string } }}
 */
export function savePersistedPayload(storage, payload, options = {}) {
  const serialized = safeSerializePayload(payload, { maxBytes: options.maxBytes });
  if (!serialized.ok) return { ok: false, bytes: serialized.bytes, error: serialized.error };
  try {
    storage.setItem(options.key ?? STORAGE_KEY, serialized.serialized);
    return { ok: true, bytes: serialized.bytes, error: null };
  } catch {
    return {
      ok: false,
      bytes: serialized.bytes,
      error: { code: "write-failed", message: "Saved data could not be written. Storage may be full or unavailable." },
    };
  }
}
