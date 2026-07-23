// @ts-check

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOCKWISE,
  COUNTER_CLOCKWISE,
  UNIT_SYSTEMS,
  appendBounded,
  boundCollection,
  buildRotationMap,
  calculateAdjustment,
  convertDistance,
  convertLinear,
  convertPoint,
  extremeSpread,
  getAxisSpecs,
  getMechanicalCenterGuidance,
  groupCenter,
  linearPerMoa,
  oppositeDirection,
  oppositeRotation,
  parseManualMagnitude,
  prependBounded,
  rotationSelection,
  roundAdjustmentSteps,
  solveAxisAdjustment,
  turnForDirection,
  validateManualOffsets,
} from "../lib/domain.mjs";

/** @type {Parameters<typeof calculateAdjustment>[0]["profile"]} */
const TURRET = {
  id: "test-turret",
  name: "Test turret",
  short: "Test",
  clickMOA: 1,
  travelMOA: 100,
  rot: { UP: COUNTER_CLOCKWISE, RIGHT: CLOCKWISE },
};

/** @type {Parameters<typeof calculateAdjustment>[0]["profile"]} */
const IRONS = {
  id: "test-irons",
  name: "Test irons",
  short: "Irons",
  type: "irons",
  elev: { moaPerUnit: 8, step: 0.25, unit: "turn", maxUnits: 2 },
  wind: { moaPerUnit: 10, step: 0.1, unit: "mm", maxUnits: 3 },
};

/** @param {number} actual @param {number} expected @param {number} [epsilon] */
function closeTo(actual, expected, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
}

test("unit definitions and MOA scale are correct in both systems", () => {
  assert.equal(UNIT_SYSTEMS.imp.linearUnit, "in");
  assert.equal(UNIT_SYSTEMS.met.linearUnit, "cm");
  closeTo(linearPerMoa(100, "imp"), 1.047);
  closeTo(linearPerMoa(25, "imp"), 0.26175);
  closeTo(linearPerMoa(100, "met"), 2.908);
  closeTo(linearPerMoa(50, "met"), 1.454);
  assert.throws(() => linearPerMoa(0, "imp"), /greater than zero/);
  assert.throws(() => linearPerMoa(100, /** @type {never} */ ("bad")), /imp/);
});

test("linear, distance, and point conversion round-trip", () => {
  closeTo(convertLinear(1, "imp", "met"), 2.54);
  closeTo(convertLinear(2.54, "met", "imp"), 1);
  closeTo(convertDistance(100, "imp", "met"), 91.44);
  closeTo(convertDistance(100, "met", "imp"), 109.36132983377078);
  const metric = convertPoint({ x: -2, y: 3 }, "imp", "met");
  closeTo(metric.x, -5.08);
  closeTo(metric.y, 7.62);
  const imperial = convertPoint(metric, "met", "imp");
  closeTo(imperial.x, -2);
  closeTo(imperial.y, 3);
});

test("all four adjustment directions map toward the point of aim", () => {
  const oneMoa = linearPerMoa(100, "imp");
  const lowLeft = calculateAdjustment({ x: -oneMoa, y: -oneMoa, distance: 100, units: "imp", profile: TURRET });
  assert.equal(lowLeft.elev.dir, "UP");
  assert.equal(lowLeft.wind.dir, "RIGHT");
  assert.equal(lowLeft.elev.steps, 1);
  assert.equal(lowLeft.wind.steps, 1);
  closeTo(lowLeft.predicted.x, 0);
  closeTo(lowLeft.predicted.y, 0);

  const highRight = calculateAdjustment({ x: oneMoa, y: oneMoa, distance: 100, units: "imp", profile: TURRET });
  assert.equal(highRight.elev.dir, "DOWN");
  assert.equal(highRight.wind.dir, "LEFT");
  assert.equal(highRight.elev.steps, 1);
  assert.equal(highRight.wind.steps, 1);
  closeTo(highRight.predicted.x, 0);
  closeTo(highRight.predicted.y, 0);
});

test("metric calculation uses centimeters at meters", () => {
  const result = calculateAdjustment({ x: -5.816, y: 2.908, distance: 100, units: "met", profile: TURRET });
  assert.deepEqual(
    { wind: result.wind.dir, windSteps: result.wind.steps, elev: result.elev.dir, elevSteps: result.elev.steps },
    { wind: "RIGHT", windSteps: 2, elev: "DOWN", elevSteps: 1 },
  );
  closeTo(result.predicted.x, 0);
  closeTo(result.predicted.y, 0);
});

test("nearest-detent rounding is stable immediately around half steps", () => {
  const spec = { moaPerUnit: 1, step: 1, unit: "click", maxUnits: 10 };
  const quantum = linearPerMoa(100, "imp");
  /** @param {number} multiple */
  const solve = (multiple) => solveAxisAdjustment({
    offset: quantum * multiple,
    distance: 100,
    units: "imp",
    spec,
    negativeDirection: "UP",
    positiveDirection: "DOWN",
  });
  assert.equal(solve(0.499999).steps, 0);
  assert.equal(solve(0.5).steps, 1);
  assert.equal(solve(1.499999).steps, 1);
  assert.equal(solve(1.5).steps, 2);
  assert.equal(roundAdjustmentSteps(2.5), 3);
  assert.equal(solve(-0.5).dir, "UP");
  assert.equal(solve(-0.5).steps, 1);
});

test("travel boundary is allowed and a single detent beyond is flagged", () => {
  const spec = { moaPerUnit: 1, step: 1, unit: "click", maxUnits: 2 };
  const quantum = linearPerMoa(100, "imp");
  /** @param {number} offset */
  const solve = (offset) => solveAxisAdjustment({
    offset,
    distance: 100,
    units: "imp",
    spec,
    negativeDirection: "RIGHT",
    positiveDirection: "LEFT",
  });
  assert.equal(solve(2 * quantum).overTravel, false);
  assert.equal(solve(2.49 * quantum).overTravel, false);
  assert.equal(solve(2.5 * quantum).overTravel, true);
  assert.equal(solve(2.5 * quantum).units, 3);
});

test("irons preserve their independent fractional adjustment steps", () => {
  const axes = getAxisSpecs(IRONS);
  assert.deepEqual(axes.elev, IRONS.elev);
  assert.deepEqual(axes.wind, IRONS.wind);
  const result = calculateAdjustment({ x: -1.047, y: -2.094, distance: 100, units: "imp", profile: IRONS });
  assert.equal(result.elev.units, 0.25);
  assert.equal(result.elev.steps, 1);
  assert.equal(result.wind.units, 0.1);
  assert.equal(result.wind.steps, 1);
});

test("group center and extreme spread handle empty, singleton, and 3-4-5 geometry", () => {
  assert.equal(groupCenter([]), null);
  assert.equal(extremeSpread([]), 0);
  assert.deepEqual(groupCenter([{ x: 2, y: -1 }]), { x: 2, y: -1 });
  assert.equal(extremeSpread([{ x: 2, y: -1 }]), 0);
  const shots = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }];
  assert.deepEqual(groupCenter(shots), { x: 2, y: 4 / 3 });
  assert.equal(extremeSpread(shots), 5);
  assert.throws(() => extremeSpread([{ x: Number.NaN, y: 0 }]), /finite/);
});

test("sparse rotation helpers invert opposite directions", () => {
  assert.equal(oppositeDirection("UP"), "DOWN");
  assert.equal(oppositeRotation(CLOCKWISE), COUNTER_CLOCKWISE);
  assert.equal(turnForDirection({ UP: CLOCKWISE }, "DOWN"), COUNTER_CLOCKWISE);
  assert.equal(turnForDirection(null, "RIGHT"), null);
  assert.equal(rotationSelection({ DOWN: CLOCKWISE }, "UP"), "ccw");
  assert.equal(rotationSelection(null, "RIGHT"), "marked");
  assert.deepEqual(buildRotationMap("cw", "ccw"), {
    UP: CLOCKWISE,
    DOWN: COUNTER_CLOCKWISE,
    RIGHT: COUNTER_CLOCKWISE,
    LEFT: CLOCKWISE,
  });
  assert.equal(buildRotationMap("marked", "marked"), null);
});

test("manual magnitude rejects signed, non-decimal, non-finite, and excessive input", () => {
  assert.deepEqual(parseManualMagnitude(""), { ok: true, empty: true, value: 0, code: null, message: null });
  assert.equal(parseManualMagnitude(".25").value, 0.25);
  assert.equal(parseManualMagnitude("1e2").value, 100);
  assert.equal(parseManualMagnitude("-2").code, "negative");
  assert.equal(parseManualMagnitude("-0").code, "negative");
  assert.equal(parseManualMagnitude("0x10").code, "invalid-number");
  assert.equal(parseManualMagnitude("Infinity").code, "invalid-number");
  assert.equal(parseManualMagnitude("1e999").code, "not-finite");
  assert.equal(parseManualMagnitude("11", { max: 10 }).code, "too-large");
});

test("manual direction and magnitude convert to signed coordinates without direction reversal", () => {
  const lowLeft = validateManualOffsets({
    vertical: { direction: "LOW", value: "2" },
    horizontal: { direction: "LEFT", value: "1" },
  });
  assert.equal(lowLeft.ok, true);
  assert.deepEqual(lowLeft.point, { x: -1, y: -2 });

  const highRight = validateManualOffsets({
    vertical: { direction: "HIGH", value: "2" },
    horizontal: { direction: "RIGHT", value: "1" },
  });
  assert.equal(highRight.ok, true);
  assert.deepEqual(highRight.point, { x: 1, y: 2 });

  const oneAxis = validateManualOffsets({
    vertical: { direction: "LOW", value: "" },
    horizontal: { direction: "RIGHT", value: "1.5" },
  });
  assert.equal(oneAxis.ok, true);
  assert.deepEqual(oneAxis.point, { x: 1.5, y: 0 });

  const negative = validateManualOffsets({
    vertical: { direction: "LOW", value: "-2" },
    horizontal: { direction: "LEFT", value: "" },
  });
  assert.equal(negative.ok, false);
  assert.equal(negative.point, null);
  assert.ok(negative.errors.some((error) => error.field === "vertical" && error.code === "negative"));

  const empty = validateManualOffsets({
    vertical: { direction: "LOW", value: "" },
    horizontal: { direction: "LEFT", value: "" },
  });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((error) => error.field === "form" && error.code === "empty"));
});

test("mechanical-center guidance is exact for even totals and honest for odd totals", () => {
  assert.deepEqual(getMechanicalCenterGuidance(20), {
    totalClicks: 20,
    exactCenter: 10,
    betweenDetents: false,
    primaryClicks: 10,
    alternateClicks: null,
    options: [10],
  });
  assert.deepEqual(getMechanicalCenterGuidance(21), {
    totalClicks: 21,
    exactCenter: 10.5,
    betweenDetents: true,
    primaryClicks: 10,
    alternateClicks: 11,
    options: [10, 11],
  });
  assert.throws(() => getMechanicalCenterGuidance(1.5), /integer/);
  assert.throws(() => getMechanicalCenterGuidance(-1), /non-negative/);
});

test("bounded collection helpers retain the correct chronological side", () => {
  assert.deepEqual(appendBounded([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(prependBounded([3, 2, 1], 4, 3), [4, 3, 2]);
  assert.deepEqual(boundCollection([1, 2, 3], 2, "head"), [1, 2]);
  assert.deepEqual(boundCollection([1, 2, 3], 2, "tail"), [2, 3]);
  assert.deepEqual(boundCollection([1], 0, "tail"), []);
  assert.throws(() => boundCollection([1], -1, "tail"), /non-negative/);
});
