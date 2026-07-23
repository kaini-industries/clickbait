// @ts-check

/**
 * Pure sight-adjustment domain helpers.
 *
 * Coordinate convention: x increases right, y increases high. Adjustment
 * directions describe the desired point-of-impact movement back to the aim
 * point, so a negative y offset needs UP and a positive x offset needs LEFT.
 */

/** @typedef {"imp" | "met"} UnitSystem */
/** @typedef {"UP" | "DOWN" | "LEFT" | "RIGHT"} AdjustmentDirection */
/** @typedef {"clockwise" | "counter-clockwise"} Rotation */
/** @typedef {"cw" | "ccw" | "marked"} RotationSelection */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {Partial<Record<AdjustmentDirection, Rotation>>} RotationMap */

/**
 * @typedef {object} UnitDefinition
 * @property {"in" | "cm"} linearUnit
 * @property {"yd" | "m"} distanceUnit
 * @property {number} linearPerMoaAt100
 * @property {readonly number[]} distances
 * @property {readonly number[]} spans
 * @property {Readonly<Record<number, number>>} gridSteps
 */

/**
 * @typedef {object} AxisSpec
 * @property {number} moaPerUnit MOA moved by one click, turn, or millimeter.
 * @property {number} step Smallest selectable adjustment in `unit` values.
 * @property {string} unit Human-readable adjustment unit.
 * @property {number} maxUnits Maximum usable adjustment from mechanical center.
 */

/**
 * @typedef {object} TurretProfile
 * @property {string} id
 * @property {string} [name]
 * @property {string} [short]
 * @property {number} clickMOA
 * @property {number} travelMOA Total lock-to-lock travel.
 * @property {RotationMap | null} [rot]
 * @property {"turret"} [type]
 */

/**
 * @typedef {object} IronsProfile
 * @property {string} id
 * @property {string} [name]
 * @property {string} [short]
 * @property {"irons"} type
 * @property {AxisSpec} elev
 * @property {AxisSpec} wind
 * @property {RotationMap | null} [rot]
 */

/** @typedef {TurretProfile | IronsProfile} SightProfile */

/**
 * @typedef {object} AxisAdjustment
 * @property {AdjustmentDirection} dir
 * @property {number} steps Integer number of adjustment quanta.
 * @property {number} units Number of clicks, turns, or millimeters to move.
 * @property {AxisSpec} spec
 * @property {number} perUnit Linear movement for one whole adjustment unit.
 * @property {number} quantum Linear movement for one selectable step.
 * @property {number} move Absolute linear correction applied.
 * @property {number} correction Signed correction in coordinate space.
 * @property {number} remaining Signed offset after the rounded correction.
 * @property {number} residual Absolute offset remaining after correction.
 * @property {boolean} overTravel
 */

const INCHES_PER_CENTIMETER = 1 / 2.54;
const YARDS_PER_METER = 1 / 0.9144;

/** @type {Readonly<Record<UnitSystem, UnitDefinition>>} */
export const UNIT_SYSTEMS = Object.freeze({
  imp: Object.freeze({
    linearUnit: "in",
    distanceUnit: "yd",
    linearPerMoaAt100: 1.047,
    distances: Object.freeze([10, 15, 25, 36, 50, 100]),
    spans: Object.freeze([6, 12, 24]),
    gridSteps: Object.freeze({ 6: 1, 12: 1, 24: 2 }),
  }),
  met: Object.freeze({
    linearUnit: "cm",
    distanceUnit: "m",
    linearPerMoaAt100: 2.908,
    distances: Object.freeze([10, 25, 50, 100]),
    spans: Object.freeze([15, 30, 60]),
    gridSteps: Object.freeze({ 15: 1, 30: 2, 60: 5 }),
  }),
});

export const COLLECTION_LIMITS = Object.freeze({
  shots: 50,
  ghosts: 50,
  logs: 250,
  profiles: 50,
});

export const CLOCKWISE = "clockwise";
export const COUNTER_CLOCKWISE = "counter-clockwise";

/** @type {Readonly<Record<AdjustmentDirection, AdjustmentDirection>>} */
const OPPOSITE_DIRECTIONS = Object.freeze({
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
});

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

/**
 * @param {unknown} units
 * @returns {UnitSystem}
 */
export function assertUnitSystem(units) {
  if (units !== "imp" && units !== "met") {
    throw new RangeError('units must be "imp" or "met".');
  }
  return units;
}

/**
 * Linear distance represented by one MOA at the supplied target distance.
 *
 * @param {number} distance
 * @param {UnitSystem} units
 * @returns {number}
 */
export function linearPerMoa(distance, units) {
  const safeDistance = finiteNumber(distance, "distance");
  if (safeDistance <= 0) throw new RangeError("distance must be greater than zero.");
  const definition = UNIT_SYSTEMS[assertUnitSystem(units)];
  return (definition.linearPerMoaAt100 * safeDistance) / 100;
}

/**
 * Convert a linear offset between inches and centimeters.
 *
 * @param {number} value
 * @param {UnitSystem} from
 * @param {UnitSystem} to
 * @returns {number}
 */
export function convertLinear(value, from, to) {
  const safeValue = finiteNumber(value, "value");
  assertUnitSystem(from);
  assertUnitSystem(to);
  if (from === to) return safeValue;
  return from === "imp"
    ? safeValue / INCHES_PER_CENTIMETER
    : safeValue * INCHES_PER_CENTIMETER;
}

/**
 * Convert a target distance between yards and meters.
 *
 * @param {number} value
 * @param {UnitSystem} from
 * @param {UnitSystem} to
 * @returns {number}
 */
export function convertDistance(value, from, to) {
  const safeValue = finiteNumber(value, "value");
  assertUnitSystem(from);
  assertUnitSystem(to);
  if (from === to) return safeValue;
  return from === "imp" ? safeValue / YARDS_PER_METER : safeValue * YARDS_PER_METER;
}

/**
 * @param {Point} point
 * @param {UnitSystem} from
 * @param {UnitSystem} to
 * @returns {Point}
 */
export function convertPoint(point, from, to) {
  assertPoint(point, "point");
  return {
    x: convertLinear(point.x, from, to),
    y: convertLinear(point.y, from, to),
  };
}

/**
 * @param {AdjustmentDirection} direction
 * @returns {AdjustmentDirection}
 */
export function oppositeDirection(direction) {
  const opposite = OPPOSITE_DIRECTIONS[direction];
  if (!opposite) throw new RangeError(`Unknown adjustment direction: ${direction}`);
  return opposite;
}

/**
 * @param {Rotation} rotation
 * @returns {Rotation}
 */
export function oppositeRotation(rotation) {
  if (rotation === CLOCKWISE) return COUNTER_CLOCKWISE;
  if (rotation === COUNTER_CLOCKWISE) return CLOCKWISE;
  throw new RangeError(`Unknown rotation: ${rotation}`);
}

/**
 * Resolve a sparse rotation map. If only the opposite impact direction is
 * recorded, its inverse is returned. `null` means to follow the marked arrow.
 *
 * @param {RotationMap | null | undefined} rotation
 * @param {AdjustmentDirection} direction
 * @returns {Rotation | null}
 */
export function turnForDirection(rotation, direction) {
  oppositeDirection(direction); // validate even when the map is empty
  if (!rotation) return null;
  const direct = rotation[direction];
  if (direct === CLOCKWISE || direct === COUNTER_CLOCKWISE) return direct;
  const inverse = rotation[oppositeDirection(direction)];
  return inverse === CLOCKWISE || inverse === COUNTER_CLOCKWISE
    ? oppositeRotation(inverse)
    : null;
}

/**
 * @param {RotationMap | null | undefined} rotation
 * @param {"UP" | "RIGHT"} anchor
 * @returns {RotationSelection}
 */
export function rotationSelection(rotation, anchor) {
  const resolved = turnForDirection(rotation, anchor);
  if (!resolved) return "marked";
  return resolved === CLOCKWISE ? "cw" : "ccw";
}

/**
 * Build a complete opposing-direction map for the two turret axes.
 *
 * @param {RotationSelection} elevation
 * @param {RotationSelection} windage
 * @returns {RotationMap | null}
 */
export function buildRotationMap(elevation, windage) {
  /** @type {RotationMap} */
  const map = {};
  if (elevation !== "marked") {
    map.UP = elevation === "cw" ? CLOCKWISE : COUNTER_CLOCKWISE;
    map.DOWN = oppositeRotation(map.UP);
  }
  if (windage !== "marked") {
    map.RIGHT = windage === "cw" ? CLOCKWISE : COUNTER_CLOCKWISE;
    map.LEFT = oppositeRotation(map.RIGHT);
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * @param {AxisSpec} spec
 * @param {string} [name]
 * @returns {AxisSpec}
 */
export function validateAxisSpec(spec, name = "axis spec") {
  if (!spec || typeof spec !== "object") throw new TypeError(`${name} is required.`);
  const moaPerUnit = finiteNumber(spec.moaPerUnit, `${name}.moaPerUnit`);
  const step = finiteNumber(spec.step, `${name}.step`);
  const maxUnits = finiteNumber(spec.maxUnits, `${name}.maxUnits`);
  if (moaPerUnit <= 0) throw new RangeError(`${name}.moaPerUnit must be greater than zero.`);
  if (step <= 0) throw new RangeError(`${name}.step must be greater than zero.`);
  if (maxUnits <= 0) throw new RangeError(`${name}.maxUnits must be greater than zero.`);
  if (typeof spec.unit !== "string" || spec.unit.trim() === "") {
    throw new TypeError(`${name}.unit must be a non-empty string.`);
  }
  return { moaPerUnit, step, maxUnits, unit: spec.unit };
}

/**
 * Convert a profile into independent elevation and windage adjustment specs.
 * Turret travel is total lock-to-lock, so usable travel from center is half.
 *
 * @param {SightProfile} profile
 * @returns {{ elev: AxisSpec, wind: AxisSpec }}
 */
export function getAxisSpecs(profile) {
  if (!profile || typeof profile !== "object") throw new TypeError("profile is required.");
  if (profile.type === "irons") {
    const irons = /** @type {IronsProfile} */ (profile);
    return {
      elev: validateAxisSpec(irons.elev, "profile.elev"),
      wind: validateAxisSpec(irons.wind, "profile.wind"),
    };
  }
  const turret = /** @type {TurretProfile} */ (profile);
  const clickMOA = finiteNumber(turret.clickMOA, "profile.clickMOA");
  const travelMOA = finiteNumber(turret.travelMOA, "profile.travelMOA");
  if (clickMOA <= 0) throw new RangeError("profile.clickMOA must be greater than zero.");
  if (travelMOA <= 0) throw new RangeError("profile.travelMOA must be greater than zero.");
  const spec = validateAxisSpec(
    {
      moaPerUnit: clickMOA,
      step: 1,
      unit: "click",
      maxUnits: travelMOA / clickMOA / 2,
    },
    "profile turret",
  );
  return { elev: { ...spec }, wind: { ...spec } };
}

/**
 * Round a positive number of adjustment quanta to the nearest detent. Exact
 * half-detent values round outward, matching physical click-count convention.
 *
 * @param {number} quanta
 * @returns {number}
 */
export function roundAdjustmentSteps(quanta) {
  const value = finiteNumber(quanta, "quanta");
  if (value < 0) throw new RangeError("quanta cannot be negative.");
  return Math.floor(value + 0.5);
}

/**
 * @param {object} input
 * @param {number} input.offset Signed point-of-impact offset.
 * @param {number} input.distance
 * @param {UnitSystem} input.units
 * @param {AxisSpec} input.spec
 * @param {AdjustmentDirection} input.negativeDirection Direction needed for a negative offset.
 * @param {AdjustmentDirection} input.positiveDirection Direction needed for a positive offset.
 * @returns {AxisAdjustment}
 */
export function solveAxisAdjustment({
  offset,
  distance,
  units,
  spec,
  negativeDirection,
  positiveDirection,
}) {
  const safeOffset = finiteNumber(offset, "offset");
  if (oppositeDirection(negativeDirection) !== positiveDirection) {
    throw new RangeError("axis directions must be opposites.");
  }
  const safeSpec = validateAxisSpec(spec);
  const perUnit = safeSpec.moaPerUnit * linearPerMoa(distance, units);
  const quantum = perUnit * safeSpec.step;
  const steps = roundAdjustmentSteps(Math.abs(safeOffset) / quantum);
  const adjustedUnits = steps * safeSpec.step;
  const move = adjustedUnits * perUnit;
  const correction = safeOffset < 0 ? move : safeOffset > 0 ? -move : 0;
  const remaining = safeOffset + correction;
  return {
    dir: safeOffset > 0 ? positiveDirection : negativeDirection,
    steps,
    units: adjustedUnits,
    spec: safeSpec,
    perUnit,
    quantum,
    move,
    correction,
    remaining,
    residual: Math.abs(remaining),
    overTravel: adjustedUnits > safeSpec.maxUnits,
  };
}

/**
 * Calculate both axes and the expected point of impact after the rounded move.
 *
 * @param {object} input
 * @param {number} input.x Signed horizontal offset (left is negative).
 * @param {number} input.y Signed vertical offset (low is negative).
 * @param {number} input.distance
 * @param {UnitSystem} input.units
 * @param {SightProfile} input.profile
 * @returns {{ cx: number, cy: number, elev: AxisAdjustment, wind: AxisAdjustment, predicted: Point }}
 */
export function calculateAdjustment({ x, y, distance, units, profile }) {
  const point = assertPoint({ x, y }, "offset");
  const axes = getAxisSpecs(profile);
  const elev = solveAxisAdjustment({
    offset: point.y,
    distance,
    units,
    spec: axes.elev,
    negativeDirection: "UP",
    positiveDirection: "DOWN",
  });
  const wind = solveAxisAdjustment({
    offset: point.x,
    distance,
    units,
    spec: axes.wind,
    negativeDirection: "RIGHT",
    positiveDirection: "LEFT",
  });
  return {
    cx: point.x,
    cy: point.y,
    elev,
    wind,
    predicted: { x: wind.remaining, y: elev.remaining },
  };
}

/**
 * @param {Point} point
 * @param {string} [name]
 * @returns {Point}
 */
export function assertPoint(point, name = "point") {
  if (!point || typeof point !== "object") throw new TypeError(`${name} is required.`);
  return {
    x: finiteNumber(point.x, `${name}.x`),
    y: finiteNumber(point.y, `${name}.y`),
  };
}

/**
 * @param {readonly Point[]} points
 * @returns {Point | null}
 */
export function groupCenter(points) {
  if (!Array.isArray(points)) throw new TypeError("points must be an array.");
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  points.forEach((point, index) => {
    const safePoint = assertPoint(point, `points[${index}]`);
    x += safePoint.x;
    y += safePoint.y;
  });
  return { x: x / points.length, y: y / points.length };
}

/**
 * Maximum center-to-center distance between any two shots.
 *
 * @param {readonly Point[]} points
 * @returns {number}
 */
export function extremeSpread(points) {
  if (!Array.isArray(points)) throw new TypeError("points must be an array.");
  if (points.length < 2) {
    if (points.length === 1) assertPoint(points[0], "points[0]");
    return 0;
  }
  const safePoints = points.map((point, index) => assertPoint(point, `points[${index}]`));
  let spread = 0;
  for (let i = 0; i < safePoints.length; i += 1) {
    for (let j = i + 1; j < safePoints.length; j += 1) {
      spread = Math.max(
        spread,
        Math.hypot(safePoints[i].x - safePoints[j].x, safePoints[i].y - safePoints[j].y),
      );
    }
  }
  return spread;
}

const DECIMAL_PATTERN = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NEGATIVE_PATTERN = /^\s*-/;

/**
 * Validate a direction-plus-magnitude input. Negative text is rejected even
 * for -0 because direction is represented separately by the UI.
 *
 * @param {unknown} raw
 * @param {{ max?: number, label?: string }} [options]
 * @returns {{ ok: boolean, empty: boolean, value: number | null, code: string | null, message: string | null }}
 */
export function parseManualMagnitude(raw, options = {}) {
  const max = options.max ?? 100000;
  const label = options.label ?? "Offset";
  finiteNumber(max, "max");
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    return { ok: true, empty: true, value: 0, code: null, message: null };
  }
  if (NEGATIVE_PATTERN.test(text)) {
    return {
      ok: false,
      empty: false,
      value: null,
      code: "negative",
      message: `${label} cannot be negative; choose the direction separately.`,
    };
  }
  if (!DECIMAL_PATTERN.test(text)) {
    return {
      ok: false,
      empty: false,
      value: null,
      code: "invalid-number",
      message: `${label} must be a valid number.`,
    };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      empty: false,
      value: null,
      code: "not-finite",
      message: `${label} must be a finite number.`,
    };
  }
  if (value > max) {
    return {
      ok: false,
      empty: false,
      value: null,
      code: "too-large",
      message: `${label} must be ${max} or less.`,
    };
  }
  return { ok: true, empty: false, value, code: null, message: null };
}

/**
 * @typedef {object} ManualAxisInput
 * @property {string} direction
 * @property {unknown} value
 */

/**
 * @typedef {object} ManualValidationError
 * @property {"vertical" | "horizontal" | "form"} field
 * @property {string} code
 * @property {string} message
 */

/**
 * Validate manual entry and convert it to signed target coordinates.
 * Blank on one axis means zero; both axes blank is an incomplete entry.
 *
 * @param {{ vertical: ManualAxisInput, horizontal: ManualAxisInput }} input
 * @param {{ max?: number }} [options]
 * @returns {{ ok: boolean, point: Point | null, hasInput: boolean, errors: ManualValidationError[], values: { vertical: number | null, horizontal: number | null } }}
 */
export function validateManualOffsets(input, options = {}) {
  const vertical = parseManualMagnitude(input?.vertical?.value, {
    max: options.max,
    label: "Vertical offset",
  });
  const horizontal = parseManualMagnitude(input?.horizontal?.value, {
    max: options.max,
    label: "Horizontal offset",
  });
  /** @type {ManualValidationError[]} */
  const errors = [];
  if (!vertical.ok) {
    errors.push({
      field: "vertical",
      code: vertical.code ?? "invalid",
      message: vertical.message ?? "Vertical offset is invalid.",
    });
  }
  if (!horizontal.ok) {
    errors.push({
      field: "horizontal",
      code: horizontal.code ?? "invalid",
      message: horizontal.message ?? "Horizontal offset is invalid.",
    });
  }
  const verticalDirection = input?.vertical?.direction;
  const horizontalDirection = input?.horizontal?.direction;
  if (verticalDirection !== "LOW" && verticalDirection !== "HIGH") {
    errors.push({ field: "vertical", code: "invalid-direction", message: "Choose low or high." });
  }
  if (horizontalDirection !== "LEFT" && horizontalDirection !== "RIGHT") {
    errors.push({ field: "horizontal", code: "invalid-direction", message: "Choose left or right." });
  }
  const hasInput = !vertical.empty || !horizontal.empty;
  if (!hasInput) {
    errors.push({ field: "form", code: "empty", message: "Enter at least one offset." });
  }
  if (errors.length > 0 || vertical.value === null || horizontal.value === null) {
    return {
      ok: false,
      point: null,
      hasInput,
      errors,
      values: { vertical: vertical.value, horizontal: horizontal.value },
    };
  }
  const horizontalValue = horizontal.value === 0
    ? 0
    : horizontalDirection === "LEFT"
      ? -horizontal.value
      : horizontal.value;
  const verticalValue = vertical.value === 0
    ? 0
    : verticalDirection === "LOW"
      ? -vertical.value
      : vertical.value;
  return {
    ok: true,
    point: {
      x: horizontalValue,
      y: verticalValue,
    },
    hasInput,
    errors,
    values: { vertical: vertical.value, horizontal: horizontal.value },
  };
}

/**
 * Explain how to return from one lock-to-lock stop to mechanical center.
 * Odd totals have no exact center detent and must not be described as exact.
 *
 * @param {number} totalClicks
 * @returns {{ totalClicks: number, exactCenter: number, betweenDetents: boolean, primaryClicks: number, alternateClicks: number | null, options: number[] }}
 */
export function getMechanicalCenterGuidance(totalClicks) {
  const count = finiteNumber(totalClicks, "totalClicks");
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("totalClicks must be a non-negative integer.");
  }
  const lower = Math.floor(count / 2);
  const upper = Math.ceil(count / 2);
  const betweenDetents = lower !== upper;
  return {
    totalClicks: count,
    exactCenter: count / 2,
    betweenDetents,
    primaryClicks: lower,
    alternateClicks: betweenDetents ? upper : null,
    options: betweenDetents ? [lower, upper] : [lower],
  };
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {"head" | "tail"} keep
 * @returns {T[]}
 */
export function boundCollection(items, limit, keep) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array.");
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer.");
  if (keep !== "head" && keep !== "tail") throw new RangeError('keep must be "head" or "tail".');
  if (limit === 0) return [];
  return keep === "head" ? items.slice(0, limit) : items.slice(-limit);
}

/**
 * Append a chronological item and retain the newest tail.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {T} item
 * @param {number} [limit]
 * @returns {T[]}
 */
export function appendBounded(items, item, limit = COLLECTION_LIMITS.shots) {
  return boundCollection([...items, item], limit, "tail");
}

/**
 * Prepend a newest-first item and retain the newest head.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {T} item
 * @param {number} [limit]
 * @returns {T[]}
 */
export function prependBounded(items, item, limit = COLLECTION_LIMITS.logs) {
  return boundCollection([item, ...items], limit, "head");
}

/** @param {readonly Point[]} shots @returns {Point[]} */
export function boundShots(shots) {
  return boundCollection(shots, COLLECTION_LIMITS.shots, "tail");
}

/** @template T @param {readonly T[]} logs @returns {T[]} */
export function boundLogs(logs) {
  return boundCollection(logs, COLLECTION_LIMITS.logs, "head");
}
