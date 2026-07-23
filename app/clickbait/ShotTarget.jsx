"use client";

import { forwardRef, memo, useId, useRef, useState } from "react";
import { C, FONT_MONO, fmt } from "./ui";

const TARGET_SVG_STYLE = {
  width: "100%",
  display: "block",
  touchAction: "pan-y pinch-zoom",
  cursor: "crosshair",
  background: C.paper,
  border: `2px solid ${C.ink}`,
  borderRadius: 4,
  boxShadow: `3px 3px 0 ${C.grid}`,
  marginTop: 12,
};

const ShotTarget = memo(forwardRef(function ShotTarget(
  { span, gridStep, lin, shots, ghosts = [], center, predicted, onTap },
  forwardedRef
) {
  const keyboardHelpId = useId();
  const size = 340;
  const px = (units) => size / 2 + (units * size) / span;
  const py = (units) => size / 2 - (units * size) / span;
  const pxPerUnit = size / span;
  const pointer = useRef(null);
  const [keyboardCursor, setKeyboardCursor] = useState({ x: 0, y: 0 });
  const [keyboardActive, setKeyboardActive] = useState(false);
  const keyboardBound = span / 2;
  const boundedKeyboardCursor = {
    x: Math.max(-keyboardBound, Math.min(keyboardBound, keyboardCursor.x)),
    y: Math.max(-keyboardBound, Math.min(keyboardBound, keyboardCursor.y)),
  };

  const gridLines = [];
  for (let units = gridStep; units <= span / 2; units += gridStep) {
    gridLines.push(units, -units);
  }

  const faceRadius = size * 0.46;
  const ringFractions = [0.78, 0.56, 0.34];

  const pointFromClient = (element, clientX, clientY) => {
    const rect = element.getBoundingClientRect();
    const fractionX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const fractionY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { x: (fractionX - 0.5) * span, y: (0.5 - fractionY) * span };
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId || start.moved) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) start.moved = true;
  };

  const clearPointer = (element, pointerId) => {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    pointer.current = null;
  };

  const handlePointerUp = (event) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    if (!start.moved) {
      event.preventDefault();
      const point = pointFromClient(event.currentTarget, event.clientX, event.clientY);
      setKeyboardCursor(point);
      onTap(point);
    }
    clearPointer(event.currentTarget, event.pointerId);
  };

  const handlePointerCancel = (event) => {
    if (pointer.current?.id === event.pointerId) {
      clearPointer(event.currentTarget, event.pointerId);
    }
  };

  const handleKeyDown = (event) => {
    const bound = span / 2;
    const step = event.shiftKey ? gridStep / 4 : gridStep;
    const deltas = {
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    if (deltas[event.key]) {
      event.preventDefault();
      const [dx, dy] = deltas[event.key];
      setKeyboardCursor((point) => ({
        x: Math.max(-bound, Math.min(bound, point.x + dx)),
        y: Math.max(-bound, Math.min(bound, point.y + dy)),
      }));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setKeyboardCursor({ x: 0, y: 0 });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.repeat) return;
      onTap(boundedKeyboardCursor);
    }
  };

  const holeRadius = Math.max(4, pxPerUnit * 0.16);
  const splatterRadius = holeRadius * 2.1;

  const horizontalPosition = boundedKeyboardCursor.x === 0
    ? "centered horizontally"
    : `${fmt(Math.abs(boundedKeyboardCursor.x), 2)} ${lin} ${boundedKeyboardCursor.x < 0 ? "left" : "right"}`;
  const verticalPosition = boundedKeyboardCursor.y === 0
    ? "centered vertically"
    : `${fmt(Math.abs(boundedKeyboardCursor.y), 2)} ${lin} ${boundedKeyboardCursor.y < 0 ? "low" : "high"}`;

  return (
    <>
      <p id={keyboardHelpId} className="sr-only">
        Use the arrow keys to move by one grid square, or Shift plus an arrow key for a quarter square.
        Press Enter or Space to mark a shot. Press Home to return the marker to the point of aim.
        In group mode, repeat this for every shot in the group.
      </p>
      <svg
        ref={forwardedRef}
        viewBox={`0 0 ${size} ${size}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={() => { pointer.current = null; }}
        onKeyDown={handleKeyDown}
        onFocus={() => setKeyboardActive(true)}
        onBlur={() => setKeyboardActive(false)}
        style={TARGET_SVG_STYLE}
        role="button"
        tabIndex={0}
        aria-describedby={keyboardHelpId}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Enter Space Home"
        aria-label={`Target coordinate picker. Marker is ${verticalPosition} and ${horizontalPosition}.`}
      >
        <line x1={0} y1={size / 2} x2={size} y2={size / 2} stroke={C.gridStrong} strokeWidth={1.8} />
        <line x1={size / 2} y1={0} x2={size / 2} y2={size} stroke={C.gridStrong} strokeWidth={1.8} />
        {gridLines.map((units, index) => (
          <g key={index}>
            <line x1={px(units)} y1={0} x2={px(units)} y2={size} stroke={C.gridStrong} strokeWidth={1.1} />
            <line x1={0} y1={py(units)} x2={size} y2={py(units)} stroke={C.gridStrong} strokeWidth={1.1} />
          </g>
        ))}

        <circle cx={size / 2} cy={size / 2} r={faceRadius} fill={C.face} />
        {ringFractions.map((fraction, index) => (
          <circle
            key={index}
            cx={size / 2}
            cy={size / 2}
            r={faceRadius * fraction}
            fill="none"
            stroke={C.faceRing}
            strokeWidth={1.6}
          />
        ))}
        {gridLines.map((units, index) => (
          <g key={`face-${index}`} opacity={0.8}>
            <line x1={px(units)} y1={0} x2={px(units)} y2={size} stroke={C.faceRing} strokeWidth={1.1} />
            <line x1={0} y1={py(units)} x2={size} y2={py(units)} stroke={C.faceRing} strokeWidth={1.1} />
          </g>
        ))}

        <g transform={`rotate(45 ${size / 2} ${size / 2})`}>
          <rect x={size / 2 - 9} y={size / 2 - 9} width={18} height={18} fill={C.red} />
        </g>
        <circle cx={size / 2} cy={size / 2} r={2.4} fill={C.paper} />

        {ghosts.map((shot, index) => (
          <circle
            key={`ghost-${index}`}
            cx={px(shot.x)}
            cy={py(shot.y)}
            r={holeRadius}
            fill={C.ink}
            stroke={C.paper}
            strokeWidth={1.5}
            opacity={0.4}
          />
        ))}

        {shots.map((shot, index) => (
          <g key={index}>
            <circle
              cx={px(shot.x)}
              cy={py(shot.y)}
              r={splatterRadius}
              fill="none"
              stroke={C.splat}
              strokeWidth={holeRadius * 0.95}
              opacity={0.95}
            />
            <circle
              cx={px(shot.x)}
              cy={py(shot.y)}
              r={holeRadius}
              fill={C.ink}
              stroke={C.splat}
              strokeWidth={1.5}
            />
          </g>
        ))}

        {center && shots.length > 1 && (
          <g fill="none">
            <g stroke={C.paper} strokeWidth={7}>
              <line x1={px(center.x) - 12} y1={py(center.y)} x2={px(center.x) + 12} y2={py(center.y)} />
              <line x1={px(center.x)} y1={py(center.y) - 12} x2={px(center.x)} y2={py(center.y) + 12} />
              <circle cx={px(center.x)} cy={py(center.y)} r={7} />
            </g>
            <g stroke={C.ink} strokeWidth={4.5}>
              <line x1={px(center.x) - 12} y1={py(center.y)} x2={px(center.x) + 12} y2={py(center.y)} />
              <line x1={px(center.x)} y1={py(center.y) - 12} x2={px(center.x)} y2={py(center.y) + 12} />
              <circle cx={px(center.x)} cy={py(center.y)} r={7} />
            </g>
            <g stroke={C.orange} strokeWidth={2}>
              <line x1={px(center.x) - 12} y1={py(center.y)} x2={px(center.x) + 12} y2={py(center.y)} />
              <line x1={px(center.x)} y1={py(center.y) - 12} x2={px(center.x)} y2={py(center.y) + 12} />
              <circle cx={px(center.x)} cy={py(center.y)} r={7} />
            </g>
          </g>
        )}

        {predicted && (
          <g fill="none">
            <circle
              cx={px(predicted.x)}
              cy={py(predicted.y)}
              r={11}
              stroke={C.ink}
              strokeWidth={5.5}
              strokeDasharray="4 3"
            />
            <circle
              cx={px(predicted.x)}
              cy={py(predicted.y)}
              r={11}
              stroke={C.white}
              strokeWidth={2}
              strokeDasharray="4 3"
            />
            <circle cx={px(predicted.x)} cy={py(predicted.y)} r={4.5} fill={C.ink} />
            <circle cx={px(predicted.x)} cy={py(predicted.y)} r={2} fill={C.white} />
          </g>
        )}

        {keyboardActive && (
          <g fill="none" pointerEvents="none">
            <circle cx={px(boundedKeyboardCursor.x)} cy={py(boundedKeyboardCursor.y)} r={13} stroke={C.paper} strokeWidth={6} />
            <circle cx={px(boundedKeyboardCursor.x)} cy={py(boundedKeyboardCursor.y)} r={13} stroke={C.ink} strokeWidth={2.5} />
            <line x1={px(boundedKeyboardCursor.x) - 18} y1={py(boundedKeyboardCursor.y)} x2={px(boundedKeyboardCursor.x) + 18} y2={py(boundedKeyboardCursor.y)} stroke={C.paper} strokeWidth={6} />
            <line x1={px(boundedKeyboardCursor.x)} y1={py(boundedKeyboardCursor.y) - 18} x2={px(boundedKeyboardCursor.x)} y2={py(boundedKeyboardCursor.y) + 18} stroke={C.paper} strokeWidth={6} />
            <line x1={px(boundedKeyboardCursor.x) - 18} y1={py(boundedKeyboardCursor.y)} x2={px(boundedKeyboardCursor.x) + 18} y2={py(boundedKeyboardCursor.y)} stroke={C.ink} strokeWidth={2.5} />
            <line x1={px(boundedKeyboardCursor.x)} y1={py(boundedKeyboardCursor.y) - 18} x2={px(boundedKeyboardCursor.x)} y2={py(boundedKeyboardCursor.y) + 18} stroke={C.ink} strokeWidth={2.5} />
          </g>
        )}

        <text x={8} y={size - 8} fontFamily={FONT_MONO} fontSize={10.5} fill={C.inkSoft}>
          1 square = {gridStep} {lin}
        </text>
      </svg>
      <div className="target-keyboard-hint" aria-hidden="true">
        Keyboard: arrows move · Shift + arrows fine-tune · Enter marks
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {keyboardActive ? `Marker ${verticalPosition}, ${horizontalPosition}.` : ""}
      </span>
    </>
  );
}));

export default ShotTarget;
