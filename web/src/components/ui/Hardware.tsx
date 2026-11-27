import type { ReactNode } from 'react';

export type LedTone = 'green' | 'amber' | 'blue' | 'orange' | 'red' | 'off';

export function LedIndicator({ tone, children }: { tone: LedTone; children: ReactNode }) {
  return <span className="hardware-led" data-tone={tone}><i aria-hidden="true" />{children}</span>;
}

export function HardwarePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="hardware-panel">
      <h2 className="hardware-label">{title}</h2>
      {children}
    </section>
  );
}

export function OLEDDisplay({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="oled-bezel" aria-label={title}>
      <div className="oled-glass">{children}</div>
    </section>
  );
}

export function HardwareSwitch({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className="hardware-switch hardware-label" type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      {label}<span className="switch-track" aria-hidden="true"><i /></span>
    </button>
  );
}

export function AudioMeter({ label, db }: { label: string; db: number }) {
  const segments = 28;
  const level = Math.max(-60, Math.min(0, db));
  const lit = Math.round((level + 60) / 60 * segments);
  return (
    <div className="oled-meter" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={level} aria-valuetext={`${level} dBFS`}>
      <span>{label}</span>
      <div className="oled-meter-bars" aria-hidden="true">
        {Array.from({ length: segments }, (_, index) => (
          <i key={index} data-lit={index < lit} data-band={index >= 26 ? 'peak' : index >= 21 ? 'high' : 'signal'} />
        ))}
      </div>
      <output>{level} dB</output>
    </div>
  );
}
