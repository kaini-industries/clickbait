// @ts-check

import test from "node:test";
import assert from "node:assert/strict";

import { COLLECTION_LIMITS } from "../lib/domain.mjs";
import {
  MAX_COUNTER_CLICKS,
  PERSISTENCE_SCHEMA_VERSION,
  STORAGE_KEY,
  commitCounterSession,
  commitFactoryReset,
  commitLogAppend,
  commitPersistedPatch,
  commitProfileClone,
  commitProfileDelete,
  commitProfileUpsert,
  commitProfilesReset,
  compareRevisionClocks,
  createPersistenceDefaults,
  createVersionedPayload,
  getCounterSession,
  loadPersistedPayload,
  mergePersistedPayloads,
  normalizeLogs,
  normalizeProfiles,
  parsePersistedPayload,
  safeParseJson,
  safeSerializePayload,
  savePersistedPayload,
} from "../lib/persistence.mjs";

const PRESETS = [
  {
    id: "preset-a",
    name: "Preset A",
    short: "A",
    clickMOA: 1,
    travelMOA: 100,
    rot: { UP: "counter-clockwise", DOWN: "clockwise" },
    builtin: true,
  },
  {
    id: "preset-irons",
    name: "Preset irons",
    short: "Irons",
    type: "irons",
    elev: { moaPerUnit: 6.9, step: 0.25, unit: "turn", maxUnits: 2 },
    wind: { moaPerUnit: 9.1, step: 0.1, unit: "mm", maxUnits: 3 },
    builtin: true,
  },
];

const LOG_A = { id: "log-a", ts: 1000, optic: "A", dist: "25 yd", e: "8↑", w: "4→" };
const LOG_B = { id: "log-b", ts: 2000, optic: "A", dist: "50 yd", e: "2↓", w: "—" };

const defaults = createPersistenceDefaults({ profiles: PRESETS });
const optsA = { defaults, presets: PRESETS, writerId: "tab-a", now: 100 };
const optsB = { defaults, presets: PRESETS, writerId: "tab-b", now: 200 };

test("defaults are complete, validated, and scoped for future counter sessions", () => {
  assert.equal(defaults.units, "imp");
  assert.equal(defaults.distance, 25);
  assert.equal(defaults.span, 12);
  assert.equal(defaults.activeId, "preset-a");
  assert.deepEqual(defaults.log, []);
  assert.equal(defaults.logEpoch, 0);
  assert.deepEqual(defaults.counters, {});
  assert.equal(defaults.profiles.length, 2);
});

test("empty storage creates a current versioned payload", () => {
  const parsed = parsePersistedPayload(null, optsA);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "empty");
  assert.equal(parsed.canSave, true);
  assert.equal(parsed.payload?.schemaVersion, PERSISTENCE_SCHEMA_VERSION);
  assert.deepEqual(parsed.payload?.data, defaults);
});

test("existing schema-v2 payloads without merge metadata remain readable", () => {
  const oldV2 = createVersionedPayload({ ...defaults, log: [LOG_A] }, { ...optsA, revision: 4, now: 10 });
  delete /** @type {Partial<typeof oldV2>} */ (oldV2).mergeMeta;
  const parsed = parsePersistedPayload(JSON.stringify(oldV2), optsB);
  assert.equal(parsed.status, "valid");
  assert.deepEqual(parsed.payload?.data.log, [LOG_A]);
  assert.equal(parsed.payload?.mergeMeta.version, 1);
  assert.ok(parsed.payload?.mergeMeta.profiles.revisions["preset-a"]);

  const priorMetadataShape = createVersionedPayload(defaults, { ...optsA, revision: 5, now: 11 });
  delete /** @type {Partial<typeof priorMetadataShape.mergeMeta>} */ (priorMetadataShape.mergeMeta).resetClock;
  delete /** @type {Partial<typeof priorMetadataShape.mergeMeta.profiles>} */ (priorMetadataShape.mergeMeta.profiles).resetClock;
  delete /** @type {Partial<typeof priorMetadataShape.mergeMeta.counters>} */ (priorMetadataShape.mergeMeta.counters).resetClock;
  const priorParsed = parsePersistedPayload(JSON.stringify(priorMetadataShape), optsB);
  assert.equal(priorParsed.status, "valid");
  assert.deepEqual(priorParsed.payload?.data, defaults);
});

test("legacy v1 shape migrates, validates, and appends missing presets", () => {
  const legacy = JSON.stringify({
    profiles: [PRESETS[0]],
    activeId: "preset-a",
    units: "met",
    distance: 100,
    span: 30,
    log: [LOG_A],
    mode: "group",
  });
  const parsed = parsePersistedPayload(legacy, optsA);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "migrated");
  assert.equal(parsed.payload?.revision, 1);
  assert.equal(parsed.payload?.data.units, "met");
  assert.equal(parsed.payload?.data.entryMode, "tap");
  assert.equal(parsed.payload?.data.profiles.length, 2);
  assert.ok(parsed.payload?.data.profiles.some((profile) => profile.id === "preset-irons"));
});

test("corrupt JSON recovers non-destructively to defaults with an issue", () => {
  const parsed = parsePersistedPayload("{not-json", optsA);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.canSave, true);
  assert.deepEqual(parsed.payload?.data, defaults);
  assert.equal(parsed.issues[0].code, "invalid-json");
});

test("future schema is left untouched and cannot be saved over", () => {
  const parsed = parsePersistedPayload(JSON.stringify({ schemaVersion: 999, data: {} }), optsA);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "unsupported-version");
  assert.equal(parsed.canSave, false);
  assert.equal(parsed.payload, null);
  assert.equal(parsed.issues[0].code, "future-version");
});

test("unsafe and infinite positive future schema versions are also left untouched", () => {
  for (const raw of [
    JSON.stringify({ schemaVersion: Number.MAX_SAFE_INTEGER + 1, data: { sentinel: "future" } }),
    '{"schemaVersion":1e400,"data":{"sentinel":"future"}}',
  ]) {
    const parsed = parsePersistedPayload(raw, optsA);
    assert.equal(parsed.status, "unsupported-version");
    assert.equal(parsed.canSave, false);
    assert.equal(parsed.payload, null);
    assert.equal(parsed.issues[0].code, "future-version");
  }
  const ambiguous = parsePersistedPayload(JSON.stringify({ schemaVersion: "999", data: {} }), optsA);
  assert.equal(ambiguous.status, "unsupported-version");
  assert.equal(ambiguous.canSave, false);
  assert.equal(ambiguous.issues[0].code, "invalid-version");
});

test("invalid current fields recover independently instead of crashing", () => {
  const payload = createVersionedPayload(defaults, optsA);
  payload.data.units = /** @type {never} */ ("invalid-unit");
  payload.data.distance = -20;
  payload.data.activeId = "missing-profile";
  const parsed = parsePersistedPayload(JSON.stringify(payload), optsA);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.payload?.data.units, "imp");
  assert.equal(parsed.payload?.data.distance, 25);
  assert.equal(parsed.payload?.data.activeId, "preset-a");
  assert.ok(parsed.issues.some((issue) => issue.path === "data.units"));
  assert.ok(parsed.issues.some((issue) => issue.path === "data.distance"));
  assert.ok(parsed.issues.some((issue) => issue.path === "data.activeId"));
});

test("invalid collection members report recovery and reset counters coherently", () => {
  const payload = createVersionedPayload(defaults, optsA);
  payload.data.profiles.push({
    id: "broken-custom",
    name: "Broken custom",
    short: "Broken",
    clickMOA: null,
    travelMOA: 80,
  });
  payload.data.log = [{
    id: "broken-log",
    ts: /** @type {never} */ (null),
    optic: "A",
    dist: "25 yd",
    e: "—",
    w: "—",
  }];
  payload.data.counters = {
    "preset-a": {
      ELEVATION: {
        count: MAX_COUNTER_CLICKS + 1,
        done: true,
        revision: /** @type {never} */ ("bad"),
        updatedAt: /** @type {never} */ (-1),
        writerId: /** @type {never} */ (42),
      },
    },
  };

  const parsed = parsePersistedPayload(JSON.stringify(payload), optsA);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "recovered");
  assert.ok(parsed.issues.some((issue) => issue.path === "data.profiles[2]"));
  assert.ok(parsed.issues.some((issue) => issue.path === "data.log[0]"));
  assert.ok(parsed.issues.some((issue) => issue.path === "data.counters.preset-a.ELEVATION.count"));
  assert.ok(parsed.issues.some((issue) => issue.path === "data.counters.preset-a.ELEVATION.done"));
  assert.ok(!parsed.payload?.data.profiles.some((profile) => profile.id === "broken-custom"));
  assert.deepEqual(parsed.payload?.data.log, []);
  assert.deepEqual(
    {
      count: parsed.payload?.data.counters["preset-a"]?.ELEVATION?.count,
      done: parsed.payload?.data.counters["preset-a"]?.ELEVATION?.done,
    },
    { count: 0, done: false },
  );
});

test("profiles reject unsafe shapes, de-duplicate ids, and remain bounded", () => {
  const customs = Array.from({ length: COLLECTION_LIMITS.profiles + 20 }, (_, index) => ({
    id: `custom-${index}`,
    name: `Custom ${index}`,
    short: `C${index}`,
    clickMOA: 0.5,
    travelMOA: 80,
  }));
  const normalized = normalizeProfiles([
    { id: "bad id with spaces", clickMOA: 1, travelMOA: 10 },
    customs[0],
    { ...customs[0], name: "duplicate" },
    ...customs.slice(1),
  ], PRESETS);
  assert.equal(normalized.length, COLLECTION_LIMITS.profiles);
  assert.equal(normalized.filter((profile) => profile.id === "custom-0").length, 1);
  assert.ok(normalized.some((profile) => profile.id === "preset-a"));
  assert.ok(normalized.some((profile) => profile.id === "preset-irons"));
  assert.ok(!normalized.some((profile) => profile.id === "bad id with spaces"));
});

test("logs are validated, deduplicated, sorted, and bounded", () => {
  const raw = Array.from({ length: COLLECTION_LIMITS.logs + 10 }, (_, index) => ({
    id: `log-${index}`,
    ts: index + 1,
    optic: "A",
    dist: "25 yd",
    e: "—",
    w: "—",
  }));
  raw.push({ ...raw[0], optic: "duplicate" });
  raw.push(/** @type {never} */ ({ id: "bad", ts: Number.NaN }));
  const logs = normalizeLogs(raw);
  assert.equal(logs.length, COLLECTION_LIMITS.logs);
  assert.equal(logs[0].ts, COLLECTION_LIMITS.logs + 10);
  assert.equal(new Set(logs.map((entry) => entry.id)).size, logs.length);
});

test("safe JSON helpers report cycles, oversized payloads, and invalid JSON", () => {
  assert.equal(safeParseJson("{").ok, false);
  assert.equal(safeParseJson('{"ok":true}').ok, true);
  /** @type {Record<string, unknown>} */
  const cyclic = {};
  cyclic.self = cyclic;
  const cycleResult = safeSerializePayload(cyclic);
  assert.equal(cycleResult.ok, false);
  assert.equal(cycleResult.error.code, "unserializable");
  const tooLarge = safeSerializePayload({ text: "é".repeat(20) }, { maxBytes: 10 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, "too-large");
  assert.ok(tooLarge.bytes > 10);
});

test("commits advance only changed field clocks and clear-log generations", () => {
  const base = createVersionedPayload({ ...defaults, log: [LOG_A] }, optsA);
  const unitsClock = base.fieldRevisions.units;
  const withMode = commitPersistedPatch(base, { mode: "group" }, { ...optsA, now: 101 });
  assert.equal(withMode.revision, 1);
  assert.equal(withMode.data.mode, "group");
  assert.equal(withMode.fieldRevisions.mode.revision, 1);
  assert.deepEqual(withMode.fieldRevisions.units, unitsClock);

  const cleared = commitPersistedPatch(withMode, { log: [] }, { ...optsA, now: 102 });
  assert.deepEqual(cleared.data.log, []);
  assert.equal(cleared.data.logEpoch, 1);
  assert.equal(cleared.fieldRevisions.logEpoch.revision, 2);
});

test("unrelated simultaneous tab edits merge without whole-snapshot loss", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const tabA = commitPersistedPatch(base, { mode: "group" }, { ...optsA, now: 10 });
  const tabB = commitPersistedPatch(base, { log: [LOG_A] }, { ...optsB, now: 11 });
  const mergedAB = mergePersistedPayloads(tabA, tabB, { defaults, presets: PRESETS });
  const mergedBA = mergePersistedPayloads(tabB, tabA, { defaults, presets: PRESETS });
  assert.equal(mergedAB.data.mode, "group");
  assert.deepEqual(mergedAB.data.log, [LOG_A]);
  assert.deepEqual(mergedAB, mergedBA);
});

test("concurrent profile additions and independent edits merge by id", () => {
  const customA = { id: "custom-a", name: "Custom A", short: "A", clickMOA: 0.5, travelMOA: 80 };
  const customB = { id: "custom-b", name: "Custom B", short: "B", clickMOA: 1, travelMOA: 100 };
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const tabA = commitProfileUpsert(base, customA, { ...optsA, now: 10, activate: true });
  const tabB = commitProfileUpsert(base, customB, { ...optsB, now: 10, activate: true });
  const merged = mergePersistedPayloads(tabA, tabB, { defaults, presets: PRESETS });
  assert.ok(merged.data.profiles.some((profile) => profile.id === "custom-a"));
  assert.ok(merged.data.profiles.some((profile) => profile.id === "custom-b"));
  assert.deepEqual(merged, mergePersistedPayloads(tabB, tabA, { defaults, presets: PRESETS }));

  const editA = commitProfileUpsert(merged, { ...customA, name: "A edited" }, { ...optsA, now: 20 });
  const editB = commitProfileUpsert(merged, { ...customB, name: "B edited" }, { ...optsB, now: 21 });
  const editsMerged = mergePersistedPayloads(editA, editB, { defaults, presets: PRESETS });
  assert.equal(editsMerged.data.profiles.find((profile) => profile.id === "custom-a")?.name, "A edited");
  assert.equal(editsMerged.data.profiles.find((profile) => profile.id === "custom-b")?.name, "B edited");
});

test("profile cloning preserves both physical turret counters with fresh clocks", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const elevation = commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 12,
    done: true,
  }, { ...optsA, now: 2 });
  const counted = commitCounterSession(elevation, {
    profileId: "preset-a",
    turret: "WINDAGE",
    count: 7,
    done: false,
  }, { ...optsA, now: 3 });
  const clone = {
    ...PRESETS[0],
    id: "custom-counter-clone",
    name: "Corrected physical optic",
    short: "Corrected",
    clickMOA: 0.5,
    builtin: false,
  };
  const cloned = commitProfileClone(counted, "preset-a", clone, {
    ...optsB,
    now: 4,
    activate: true,
  });

  assert.equal(cloned.data.activeId, "custom-counter-clone");
  assert.deepEqual(
    getCounterSession(cloned.data.counters, "custom-counter-clone", "ELEVATION"),
    { count: 12, done: true, ...cloned.fieldRevisions.counters },
  );
  assert.deepEqual(
    getCounterSession(cloned.data.counters, "custom-counter-clone", "WINDAGE"),
    { count: 7, done: false, ...cloned.fieldRevisions.counters },
  );
  assert.equal(getCounterSession(cloned.data.counters, "preset-a", "ELEVATION").count, 12);
  assert.equal(getCounterSession(cloned.data.counters, "preset-a", "WINDAGE").count, 7);
  assert.notEqual(
    getCounterSession(cloned.data.counters, "preset-a", "ELEVATION").revision,
    getCounterSession(cloned.data.counters, "custom-counter-clone", "ELEVATION").revision,
  );
});

test("profile deletion is remove-wins and profile reset preserves unrelated customs", () => {
  const custom = { id: "custom-delete", name: "Custom", short: "Custom", clickMOA: 0.5, travelMOA: 80 };
  const base = commitProfileUpsert(
    createVersionedPayload(defaults, { ...optsA, now: 1 }),
    custom,
    { ...optsA, now: 2, activate: true },
  );
  const counted = commitCounterSession(base, {
    profileId: "custom-delete",
    turret: "ELEVATION",
    count: 9,
    done: true,
  }, { ...optsA, now: 3 });
  const staleEdit = commitProfileUpsert(
    counted,
    { ...custom, name: "Stale edit" },
    { ...optsB, now: 4 },
  );
  const deleted = commitProfileDelete(counted, "custom-delete", {
    ...optsA,
    now: 5,
    nextActiveId: "preset-a",
  });
  const merged = mergePersistedPayloads(deleted, staleEdit, { defaults, presets: PRESETS });
  assert.ok(!merged.data.profiles.some((profile) => profile.id === "custom-delete"));
  assert.equal(getCounterSession(merged.data.counters, "custom-delete", "ELEVATION").count, 0);

  const retained = { id: "custom-retained", name: "Retained", short: "Keep", clickMOA: 0.5, travelMOA: 80 };
  const withRetained = commitProfileUpsert(merged, retained, { ...optsA, now: 6 });
  const customizedPreset = commitProfileUpsert(
    withRetained,
    { ...PRESETS[0], name: "Locally changed preset" },
    { ...optsA, now: 7 },
  );
  const presetCounted = commitCounterSession(customizedPreset, {
    profileId: "preset-a",
    turret: "WINDAGE",
    count: 14,
    done: true,
  }, { ...optsA, now: 8 });
  const reset = commitProfilesReset(presetCounted, [PRESETS[0]], { ...optsA, now: 9 });
  assert.equal(reset.data.profiles.find((profile) => profile.id === "preset-a")?.name, "Preset A");
  assert.ok(reset.data.profiles.some((profile) => profile.id === "custom-retained"));
  assert.equal(getCounterSession(reset.data.counters, "preset-a", "WINDAGE").count, 0);
  const resetMergedWithStale = mergePersistedPayloads(reset, presetCounted, { defaults, presets: PRESETS });
  assert.equal(getCounterSession(resetMergedWithStale.data.counters, "preset-a", "WINDAGE").count, 0);
});

test("profile specification reset can preserve live counters and counter tombstones", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const elevation = commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 12,
    done: true,
  }, { ...optsA, now: 2 });
  const both = commitCounterSession(elevation, {
    profileId: "preset-a",
    turret: "WINDAGE",
    count: 6,
    done: false,
  }, { ...optsA, now: 3 });
  const elevationOnly = {
    "preset-a": { ELEVATION: both.data.counters["preset-a"].ELEVATION },
  };
  const withWindageTombstone = commitPersistedPatch(
    both,
    { counters: elevationOnly },
    { ...optsA, now: 4 },
  );
  const tombstonesBefore = structuredClone(withWindageTombstone.mergeMeta.counters.tombstones);
  const customized = commitProfileUpsert(
    withWindageTombstone,
    { ...PRESETS[0], name: "Changed preset name" },
    { ...optsA, now: 5 },
  );
  const restored = commitProfilesReset(customized, [PRESETS[0]], {
    ...optsA,
    now: 6,
    resetCounters: false,
  });
  assert.equal(restored.data.profiles.find((profile) => profile.id === "preset-a")?.name, "Preset A");
  assert.equal(getCounterSession(restored.data.counters, "preset-a", "ELEVATION").count, 12);
  assert.equal(getCounterSession(restored.data.counters, "preset-a", "ELEVATION").done, true);
  assert.equal(getCounterSession(restored.data.counters, "preset-a", "WINDAGE").count, 0);
  assert.deepEqual(restored.mergeMeta.counters.tombstones, tombstonesBefore);
});

test("factory reset is a new generation that stale branches cannot resurrect", () => {
  const custom = {
    id: "custom-factory-reset",
    name: "Factory reset custom",
    short: "Reset me",
    clickMOA: 0.5,
    travelMOA: 80,
  };
  let dirty = createVersionedPayload(defaults, { ...optsA, now: 1 });
  dirty = commitProfileUpsert(dirty, custom, { ...optsA, now: 2, activate: true });
  dirty = commitPersistedPatch(dirty, {
    units: "met",
    distance: 100,
    span: 30,
    mode: "group",
    entryMode: "type",
  }, { ...optsA, now: 3 });
  dirty = commitLogAppend(dirty, LOG_A, { ...optsA, now: 4 });
  dirty = commitCounterSession(dirty, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 7,
    done: true,
  }, { ...optsA, now: 5 });
  dirty = commitCounterSession(dirty, {
    profileId: custom.id,
    turret: "WINDAGE",
    count: 9,
    done: false,
  }, { ...optsA, now: 6 });

  const reset = commitFactoryReset(dirty, { ...optsA, now: 100 });
  assert.deepEqual(reset.data.profiles.map((profile) => profile.id), PRESETS.map((profile) => profile.id));
  assert.equal(reset.data.activeId, defaults.activeId);
  assert.equal(reset.data.units, defaults.units);
  assert.equal(reset.data.distance, defaults.distance);
  assert.equal(reset.data.span, defaults.span);
  assert.deepEqual(reset.data.log, []);
  assert.equal(reset.data.mode, defaults.mode);
  assert.equal(reset.data.entryMode, defaults.entryMode);
  assert.deepEqual(reset.data.counters, {});
  assert.ok(reset.mergeMeta.resetClock.revision > 0);
  assert.ok(reset.mergeMeta.profiles.tombstones[custom.id]);

  // Accumulate several operations on the pre-reset branch so its envelope
  // revision exceeds the single reset commit. Generation comparison must still
  // keep the reset authoritative.
  let staleBranch = commitLogAppend(dirty, LOG_B, { ...optsB, now: 50 });
  staleBranch = commitProfileUpsert(
    staleBranch,
    { ...custom, name: "Stale resurrection" },
    { ...optsB, now: 51, activate: true },
  );
  staleBranch = commitPersistedPatch(staleBranch, {
    units: "met",
    distance: 250,
    span: 60,
    mode: "group",
    entryMode: "type",
  }, { ...optsB, now: 52 });
  staleBranch = commitCounterSession(staleBranch, {
    profileId: custom.id,
    turret: "WINDAGE",
    count: 99,
    done: true,
  }, { ...optsB, now: 53 });
  assert.ok(staleBranch.revision > reset.revision);

  const merged = mergePersistedPayloads(reset, staleBranch, { defaults, presets: PRESETS });
  const reverse = mergePersistedPayloads(staleBranch, reset, { defaults, presets: PRESETS });
  assert.deepEqual(merged, reverse);
  assert.deepEqual(merged.data.profiles.map((profile) => profile.id), PRESETS.map((profile) => profile.id));
  assert.equal(merged.data.activeId, defaults.activeId);
  assert.equal(merged.data.units, defaults.units);
  assert.equal(merged.data.distance, defaults.distance);
  assert.equal(merged.data.span, defaults.span);
  assert.deepEqual(merged.data.log, []);
  assert.equal(merged.data.mode, defaults.mode);
  assert.equal(merged.data.entryMode, defaults.entryMode);
  assert.deepEqual(merged.data.counters, {});

  const parsed = parsePersistedPayload(JSON.stringify(merged), optsA);
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.canSave, true);

  const postResetCustom = {
    ...custom,
    id: "custom-after-reset",
    name: "Created after reset",
  };
  const afterReset = commitProfileUpsert(reset, postResetCustom, { ...optsA, now: 101 });
  const afterResetMerged = mergePersistedPayloads(afterReset, staleBranch, { defaults, presets: PRESETS });
  assert.ok(afterResetMerged.data.profiles.some((profile) => profile.id === postResetCustom.id));
  assert.ok(!afterResetMerged.data.profiles.some((profile) => profile.id === custom.id));
});

test("a stale field revision cannot overwrite a newer edit", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const newer = commitPersistedPatch(base, { distance: 100 }, { ...optsA, now: 10 });
  const stale = structuredClone(base);
  stale.data.distance = 10;
  const merged = mergePersistedPayloads(newer, stale, { defaults, presets: PRESETS });
  assert.equal(merged.data.distance, 100);
  assert.equal(merged.fieldRevisions.distance.revision, 1);
});

test("concurrent log appends union by id in one generation", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const tabA = commitPersistedPatch(base, { log: [LOG_A] }, { ...optsA, now: 10 });
  const tabB = commitPersistedPatch(base, { log: [LOG_B] }, { ...optsB, now: 10 });
  const merged = mergePersistedPayloads(tabA, tabB, { defaults, presets: PRESETS });
  assert.deepEqual(merged.data.log.map((entry) => entry.id), ["log-b", "log-a"]);
});

test("atomic append after rebasing a clear does not carry stale log entries forward", () => {
  const withLog = createVersionedPayload({ ...defaults, log: [LOG_A] }, { ...optsA, now: 1 });
  const cleared = commitPersistedPatch(withLog, { log: [] }, { ...optsA, now: 10 });
  const rebased = mergePersistedPayloads(withLog, cleared, { defaults, presets: PRESETS });
  const appended = commitLogAppend(rebased, LOG_B, { ...optsB, now: 11 });
  assert.equal(appended.data.logEpoch, 1);
  assert.deepEqual(appended.data.log.map((entry) => entry.id), ["log-b"]);
  const mergedWithStale = mergePersistedPayloads(appended, withLog, { defaults, presets: PRESETS });
  assert.deepEqual(mergedWithStale.data.log.map((entry) => entry.id), ["log-b"]);
});

test("clear-log epoch prevents a stale tab from resurrecting deleted entries", () => {
  const withLog = createVersionedPayload({ ...defaults, log: [LOG_A] }, { ...optsA, now: 1 });
  const cleared = commitPersistedPatch(withLog, { log: [] }, { ...optsA, now: 10 });
  const staleWithAnotherEntry = commitPersistedPatch(withLog, { log: [LOG_B, LOG_A] }, { ...optsB, now: 9 });
  const merged = mergePersistedPayloads(cleared, staleWithAnotherEntry, { defaults, presets: PRESETS });
  assert.equal(merged.data.logEpoch, 1);
  assert.deepEqual(merged.data.log, []);
});

test("clear-log tombstone remains safe when the legacy epoch is saturated", () => {
  const saturated = createVersionedPayload(
    { ...defaults, log: [LOG_A], logEpoch: Number.MAX_SAFE_INTEGER },
    { ...optsA, revision: Number.MAX_SAFE_INTEGER, now: 1 },
  );
  const cleared = commitPersistedPatch(saturated, { log: [] }, { ...optsA, now: 1 });
  assert.equal(cleared.data.logEpoch, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(cleared.data.log, []);

  const staleAppend = commitLogAppend(saturated, LOG_B, { ...optsB, now: 1 });
  const merged = mergePersistedPayloads(cleared, staleAppend, { defaults, presets: PRESETS });
  assert.deepEqual(merged.data.log, []);

  const appendAfterClear = commitLogAppend(cleared, LOG_B, { ...optsB, now: 1 });
  const mergedAfterClear = mergePersistedPayloads(cleared, appendAfterClear, { defaults, presets: PRESETS });
  assert.deepEqual(mergedAfterClear.data.log.map((entry) => entry.id), ["log-b"]);
  const clearedAgain = commitPersistedPatch(appendAfterClear, { log: [] }, { ...optsB, now: 1 });
  const mergedSecondClear = mergePersistedPayloads(clearedAgain, appendAfterClear, { defaults, presets: PRESETS });
  assert.deepEqual(mergedSecondClear.data.log, []);
});

test("counter sessions persist and merge independently by profile and turret", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const elevation = commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 20,
    done: true,
  }, { ...optsA, now: 10 });
  const windage = commitCounterSession(base, {
    profileId: "preset-a",
    turret: "WINDAGE",
    count: 18,
    done: false,
  }, { ...optsB, now: 11 });
  const merged = mergePersistedPayloads(elevation, windage, { defaults, presets: PRESETS });
  assert.deepEqual(
    { count: getCounterSession(merged.data.counters, "preset-a", "ELEVATION").count,
      done: getCounterSession(merged.data.counters, "preset-a", "ELEVATION").done },
    { count: 20, done: true },
  );
  assert.equal(getCounterSession(merged.data.counters, "preset-a", "WINDAGE").count, 18);
  assert.equal(getCounterSession(merged.data.counters, "preset-irons", "ELEVATION").count, 0);

  assert.doesNotThrow(() => commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: MAX_COUNTER_CLICKS,
    done: false,
  }, optsA));
  assert.throws(() => commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: MAX_COUNTER_CLICKS + 1,
    done: false,
  }, optsA), /no greater than/);
});

test("newer counter reset tombstones prevent stale session resurrection", () => {
  const base = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const counted = commitCounterSession(base, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 17,
    done: true,
  }, { ...optsA, now: 10 });
  const reset = commitPersistedPatch(counted, { counters: {} }, { ...optsA, now: 20 });
  assert.equal(getCounterSession(reset.data.counters, "preset-a", "ELEVATION").count, 0);
  assert.ok(reset.mergeMeta.counters.tombstones["preset-a"]?.ELEVATION);

  const merged = mergePersistedPayloads(reset, counted, { defaults, presets: PRESETS });
  assert.equal(getCounterSession(merged.data.counters, "preset-a", "ELEVATION").count, 0);
  assert.equal(getCounterSession(merged.data.counters, "preset-a", "ELEVATION").done, false);

  const restarted = commitCounterSession(reset, {
    profileId: "preset-a",
    turret: "ELEVATION",
    count: 3,
    done: false,
  }, { ...optsB, now: 21 });
  const restartedMerged = mergePersistedPayloads(restarted, counted, { defaults, presets: PRESETS });
  assert.equal(getCounterSession(restartedMerged.data.counters, "preset-a", "ELEVATION").count, 3);

  const sameBase = createVersionedPayload(defaults, { ...optsA, now: 30 });
  const delayedSession = commitCounterSession(sameBase, {
    profileId: "preset-a",
    turret: "WINDAGE",
    count: 8,
    done: true,
  }, { ...optsB, now: 31 });
  const resetWithoutLocalSession = commitProfilesReset(sameBase, [PRESETS[0]], { ...optsA, now: 32 });
  const concurrentResetMerged = mergePersistedPayloads(
    resetWithoutLocalSession,
    delayedSession,
    { defaults, presets: PRESETS },
  );
  assert.equal(getCounterSession(concurrentResetMerged.data.counters, "preset-a", "WINDAGE").count, 0);
});

test("profile and counter tombstone metadata stays deterministically bounded", () => {
  let payload = createVersionedPayload(defaults, { ...optsA, now: 1 });
  const churn = COLLECTION_LIMITS.profiles * 4 + 5;
  for (let index = 0; index < churn; index += 1) {
    const profile = {
      id: `churn-${index}`,
      name: `Churn ${index}`,
      short: `C${index}`,
      clickMOA: 1,
      travelMOA: 100,
    };
    payload = commitProfileUpsert(payload, profile, { ...optsA, now: index * 3 + 2 });
    payload = commitCounterSession(payload, {
      profileId: profile.id,
      turret: "ELEVATION",
      count: 1,
      done: false,
    }, { ...optsA, now: index * 3 + 3 });
    payload = commitProfileDelete(payload, profile.id, { ...optsA, now: index * 3 + 4 });
  }
  const limit = COLLECTION_LIMITS.profiles * 4;
  assert.equal(Object.keys(payload.mergeMeta.profiles.tombstones).length, limit);
  assert.equal(Object.keys(payload.mergeMeta.counters.tombstones).length, limit);
  assert.ok(payload.mergeMeta.profiles.tombstones[`churn-${churn - 1}`]);
  assert.ok(payload.mergeMeta.counters.tombstones[`churn-${churn - 1}`]);
  assert.equal(payload.mergeMeta.profiles.tombstones["churn-0"], undefined);
  assert.equal(payload.mergeMeta.counters.tombstones["churn-0"], undefined);
});

test("clock comparison is deterministic at revision, time, and writer ties", () => {
  assert.equal(compareRevisionClocks(
    { revision: 2, updatedAt: 1, writerId: "a" },
    { revision: 1, updatedAt: 999, writerId: "z" },
  ), 1);
  assert.equal(compareRevisionClocks(
    { revision: 2, updatedAt: 2, writerId: "a" },
    { revision: 2, updatedAt: 1, writerId: "z" },
  ), 1);
  assert.equal(compareRevisionClocks(
    { revision: 2, updatedAt: 2, writerId: "b" },
    { revision: 2, updatedAt: 2, writerId: "a" },
  ), 1);
});

test("storage adapters save synchronously and surface read/write failures", () => {
  /** @type {Map<string, string>} */
  const values = new Map();
  const storage = {
    getItem: (/** @type {string} */ key) => values.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => { values.set(key, value); },
  };
  const payload = createVersionedPayload(defaults, optsA);
  const saved = savePersistedPayload(storage, payload);
  assert.equal(saved.ok, true);
  assert.ok(values.has(STORAGE_KEY));
  const loaded = loadPersistedPayload(storage, optsA);
  assert.equal(loaded.status, "valid");
  assert.deepEqual(loaded.payload?.data, defaults);

  const brokenStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("full"); },
  };
  const readFailure = loadPersistedPayload(brokenStorage, optsA);
  assert.equal(readFailure.canSave, false);
  assert.equal(readFailure.issues[0].code, "read-failed");
  const writeFailure = savePersistedPayload(brokenStorage, payload);
  assert.equal(writeFailure.ok, false);
  assert.equal(writeFailure.error.code, "write-failed");
});

test("storage loading falls back to and migrates the legacy key", () => {
  const legacyStorage = {
    getItem: (/** @type {string} */ key) => key === "clickbait-v1"
      ? JSON.stringify({ ...defaults, mode: "group" })
      : null,
    setItem: () => {},
  };
  const loaded = loadPersistedPayload(legacyStorage, optsA);
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.payload?.data.mode, "group");
});
