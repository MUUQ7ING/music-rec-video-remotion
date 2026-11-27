import { useEffect, useState } from 'react';
import { AudioMeter, HardwarePanel, HardwareSwitch, LedIndicator, OLEDDisplay } from '../components/ui/Hardware';
import type { LedTone } from '../components/ui/Hardware';
import { RotaryKnob } from '../components/ui/RotaryKnob';
import { TactileButton } from '../components/ui/TactileButton';
import '../styles/op1/showcase.css';

const statuses: { tone: LedTone; label: string }[] = [
  { tone: 'green', label: 'Ready' },
  { tone: 'amber', label: 'Queued' },
  { tone: 'blue', label: 'Downloading' },
  { tone: 'orange', label: 'Rendering' },
  { tone: 'red', label: 'Failed' },
  { tone: 'off', label: 'Offline' },
];

export default function HardwareShowcase() {
  const [volume, setVolume] = useState(72);
  const [offset, setOffset] = useState(0);
  const [transition, setTransition] = useState(0.6);
  const [fade, setFade] = useState(0.8);
  const [seconds, setSeconds] = useState(42.16);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [dark, setDark] = useState(false);
  const [input, setInput] = useState(36);
  const [output, setOutput] = useState(58);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setSeconds(current => {
      const next = current + 0.1;
      return loop && next >= output ? input : next;
    }), 100);
    return () => window.clearInterval(timer);
  }, [playing, loop, input, output]);

  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  const level = playing && !muted && volume > 0 ? Math.round(-55 + volume * 0.49 + Math.sin(seconds * 9) * 4) : -60;

  return (
    <main className="hardware-showcase" data-finish={dark ? 'graphite' : 'silver'}>
      <div className="hardware-chassis">
        <header className="hardware-header">
          <div>
            <p className="hardware-label">Music Recommendation Workstation</p>
            <h1>MRV<span>–</span>02</h1>
          </div>
          <nav aria-label="Showcase navigation">
            <TactileButton className="hardware-key" aria-pressed={dark} onClick={() => setDark(!dark)}>{dark ? 'Silver' : 'Graphite'}</TactileButton>
            <a href="/">Open Studio <span aria-hidden="true">↗</span></a>
          </nav>
        </header>
        <div className="hardware-face">
          <HardwarePanel title="Monitor">
            <OLEDDisplay title="Transport display">
              <div className="oled-header hardware-label">
                <span>Transport test signal</span>
                <LedIndicator tone={playing ? 'green' : 'off'}>{playing ? 'Running' : 'Standby'}</LedIndicator>
              </div>
              <div className="oled-time">{time}<span> / TC</span></div>
              <div className="oled-meters">
                <AudioMeter label="L" db={level} />
                <AudioMeter label="R" db={Math.max(-60, level - 3)} />
              </div>
              <div className="oled-footer hardware-label">
                <span>In {input.toFixed(2)} s</span><span>Out {output.toFixed(2)} s</span>
              </div>
            </OLEDDisplay>
          </HardwarePanel>
          <HardwarePanel title="Parameter controls">
            <div className="knob-bank">
              <RotaryKnob label="Volume" value={volume} min={0} max={100} step={1} defaultValue={72} unit="%" tone="blue" onChange={setVolume} />
              <RotaryKnob label="Lyrics offset" value={offset} min={-5} max={5} step={0.1} defaultValue={0} unit="s" tone="green" onChange={setOffset} />
              <RotaryKnob label="Video transition" value={transition} min={0} max={3} step={0.1} defaultValue={0.6} unit="s" tone="orange" onChange={setTransition} />
              <RotaryKnob label="Audio fade" value={fade} min={0} max={3} step={0.1} defaultValue={0.8} unit="s" tone="ivory" onChange={setFade} />
            </div>
            <p className="knob-help">Drag or use arrow keys. Double-click to reset.</p>
          </HardwarePanel>
          <HardwarePanel title="Transport">
            <div className="hardware-keys">
              <TactileButton className="hardware-key" onClick={() => setSeconds(input)}>↤ In point</TactileButton>
              <TactileButton className="hardware-key play-key" active={playing} aria-pressed={playing} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ Pause' : '▶ Play'}</TactileButton>
              <TactileButton className="hardware-key" onClick={() => { setPlaying(false); setSeconds(input); }}>■ Stop</TactileButton>
              <TactileButton className="hardware-key edit-key" onClick={() => setInput(Math.min(output - 0.1, seconds))}>Set In</TactileButton>
              <TactileButton className="hardware-key edit-key" disabled={seconds <= input} onClick={() => setOutput(seconds)}>Set Out</TactileButton>
            </div>
            <div className="hardware-switches">
              <HardwareSwitch label="Loop" on={loop} onChange={setLoop} />
              <HardwareSwitch label="Mute" on={muted} onChange={setMuted} />
            </div>
          </HardwarePanel>
          <HardwarePanel title="Status indicators">
            <div className="hardware-statuses">
              {statuses.map(({ tone, label }) => <LedIndicator key={tone} tone={tone}>{label}</LedIndicator>)}
            </div>
          </HardwarePanel>
        </div>
      </div>
    </main>
  );
}
