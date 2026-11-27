import { useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '../../styles/op1/knob.css';

interface RotaryKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
  tone: 'blue' | 'green' | 'orange' | 'ivory';
  compact?: boolean;
  exactMax?: number;
  onChange: (value: number) => void;
}

export function RotaryKnob({ label, value, min, max, step, defaultValue, unit, tone, compact = false, exactMax = max, onChange }: RotaryKnobProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ y: number; value: number } | null>(null);
  const degrees = -135 + 270 * (value - min) / (max - min);
  const update = (next: number) => {
    const snapped = min + Math.round((next - min) / step) * step;
    onChange(Number(Math.min(max, Math.max(min, snapped)).toFixed(8)));
  };

  return (
    <div className={compact ? 'hardware-knob hardware-knob-compact' : 'hardware-knob'} data-tone={tone}>
      <span className="hardware-label" id={id}>{label}</span>
      <div className="knob-dial">
        <div
          className="knob-grip"
          style={{ '--angle': `${degrees}deg` } as CSSProperties}
          role="slider"
          tabIndex={0}
          aria-labelledby={id}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={`${value} ${unit}`}
          title="Drag to adjust. Double-click to reset."
          onPointerDown={event => {
            if (event.button !== 0) return;
            drag.current = { y: event.clientY, value };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
              update(drag.current.value + (drag.current.y - event.clientY) * (max - min) / 160);
            }
          }}
          onLostPointerCapture={() => { drag.current = null; }}
          onWheel={event => {
            if (document.activeElement === event.currentTarget && event.deltaY !== 0) {
              update(value - Math.sign(event.deltaY) * step);
            }
          }}
          onDoubleClick={() => update(defaultValue)}
          onKeyDown={event => {
            const adjustments: Record<string, number> = {
              ArrowUp: value + step,
              ArrowRight: value + step,
              ArrowDown: value - step,
              ArrowLeft: value - step,
              Home: min,
              End: max,
            };
            if (!Object.hasOwn(adjustments, event.key)) return;
            event.preventDefault();
            update(adjustments[event.key]);
          }}
        />
      </div>
      <label className="knob-value">
        <input
          aria-label={`${label} exact value`}
          type="number"
          min={min}
          max={Number.isFinite(exactMax) ? exactMax : undefined}
          step={step}
          value={draft ?? value}
          onChange={event => setDraft(event.currentTarget.value)}
          onBlur={event => {
            if (Number.isFinite(event.currentTarget.valueAsNumber)) {
              onChange(Math.min(exactMax, Math.max(min, event.currentTarget.valueAsNumber)));
            }
            setDraft(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <span>{unit}</span>
      </label>
    </div>
  );
}
