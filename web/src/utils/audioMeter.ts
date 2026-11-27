export interface AudioMeterSnapshot {
  dbL: number;
  dbR: number;
  peakDbL: number;
  peakDbR: number;
  segmentsL: number;
  segmentsR: number;
  lufs: number;
  hasSignal: boolean;
  isClipping: boolean;
  active: boolean;
}

interface MeterGraph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  splitter: ChannelSplitterNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  bufL: Float32Array<ArrayBuffer>;
  bufR: Float32Array<ArrayBuffer>;
}

const graphMap = new WeakMap<HTMLMediaElement, MeterGraph>();
const blockedSet = new WeakSet<HTMLMediaElement>();

export const IDLE_METER_SNAPSHOT: AudioMeterSnapshot = {
  dbL: -60,
  dbR: -60,
  peakDbL: -60,
  peakDbR: -60,
  segmentsL: 0,
  segmentsR: 0,
  lufs: -60,
  hasSignal: false,
  isClipping: false,
  active: false,
};

function dbToSegments(db: number): number {
  if (db <= -60) return 0;
  return Math.max(1, Math.min(22, Math.round(((db + 60) / 66) * 22)));
}

function measureBuffer(buf: Float32Array<ArrayBuffer>): { rms: number; peak: number } {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = buf[i];
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
    sumSq += v * v;
  }
  const rms = buf.length > 0 ? Math.sqrt(sumSq / buf.length) : 0;
  return { rms, peak };
}

export function ensureMeterGraph(el: HTMLMediaElement): MeterGraph | null {
  if (blockedSet.has(el) || typeof window === 'undefined') {
    return null;
  }
  const existing = graphMap.get(el);
  if (existing) {
    if (existing.ctx.state === 'suspended') {
      existing.ctx.resume().catch(() => {});
    }
    return existing;
  }
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return null;
    }
    const ctx = new AudioCtx();
    const source = ctx.createMediaElementSource(el);
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    analyserL.fftSize = 1024;
    analyserR.fftSize = 1024;
    analyserL.smoothingTimeConstant = 0.65;
    analyserR.smoothingTimeConstant = 0.65;
    source.connect(ctx.destination);
    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    const graph: MeterGraph = {
      ctx,
      source,
      splitter,
      analyserL,
      analyserR,
      bufL: new Float32Array(new ArrayBuffer(analyserL.fftSize * 4)),
      bufR: new Float32Array(new ArrayBuffer(analyserR.fftSize * 4)),
    };
    graphMap.set(el, graph);
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return graph;
  } catch {
    blockedSet.add(el);
    return null;
  }
}

export function releaseMeterGraph(el: HTMLMediaElement | null): void {
  if (!el) return;
  const graph = graphMap.get(el);
  if (!graph) return;
  graphMap.delete(el);
  try {
    graph.source.disconnect();
    graph.splitter.disconnect();
    graph.analyserL.disconnect();
    graph.analyserR.disconnect();
  } catch {
  }
  if (graph.ctx.state !== 'closed') {
    graph.ctx.close().catch(() => {});
  }
}

export function sampleAudioMeter(el: HTMLMediaElement | null): AudioMeterSnapshot {
  if (!el || el.paused || el.ended || el.readyState < 2 || el.muted) {
    return IDLE_METER_SNAPSHOT;
  }
  const graph = ensureMeterGraph(el);
  if (!graph) {
    return IDLE_METER_SNAPSHOT;
  }
  try {
    graph.analyserL.getFloatTimeDomainData(graph.bufL);
    graph.analyserR.getFloatTimeDomainData(graph.bufR);
    const mL = measureBuffer(graph.bufL);
    const mR = measureBuffer(graph.bufR);
    const effR = mR.rms === 0 && mL.rms > 0 ? mL : mR;
    const dbL = mL.rms > 1e-7 ? Math.max(-60, Math.min(6, 20 * Math.log10(mL.rms))) : -60;
    const dbR = effR.rms > 1e-7 ? Math.max(-60, Math.min(6, 20 * Math.log10(effR.rms))) : -60;
    const peakDbL = mL.peak > 1e-7 ? Math.max(-60, Math.min(6, 20 * Math.log10(mL.peak))) : -60;
    const peakDbR = effR.peak > 1e-7 ? Math.max(-60, Math.min(6, 20 * Math.log10(effR.peak))) : -60;
    const meanSq = (mL.rms * mL.rms + effR.rms * effR.rms) / 2;
    const lufs = meanSq > 1e-10 ? Math.max(-60, -0.691 + 10 * Math.log10(meanSq)) : -60;
    return {
      dbL,
      dbR,
      peakDbL,
      peakDbR,
      segmentsL: dbToSegments(dbL),
      segmentsR: dbToSegments(dbR),
      lufs,
      hasSignal: Math.max(peakDbL, peakDbR) > -50,
      isClipping: Math.max(peakDbL, peakDbR) >= -0.3,
      active: true,
    };
  } catch {
    return IDLE_METER_SNAPSHOT;
  }
}
