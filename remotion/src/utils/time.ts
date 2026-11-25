import { staticFile } from 'remotion';

export function parseTime(t: string | number | undefined): number {
  if (typeof t === 'number') {
    return Number.isFinite(t) ? t : 0;
  }
  const clean = String(t ?? '0').trim();
  if (!clean) return 0;
  const parts = clean.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  if (parts.length === 3) {
    return (
      parseInt(parts[0], 10) * 3600 +
      parseInt(parts[1], 10) * 60 +
      parseFloat(parts[2])
    );
  }
  const val = parseFloat(clean);
  return Number.isFinite(val) ? val : 0;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function resolveAssetUrl(
  relPath: string | undefined,
  mediaBaseUrl?: string,
): string {
  if (!relPath) return '';
  if (relPath.startsWith('http://') || relPath.startsWith('https://')) {
    return relPath;
  }
  const clean = relPath.replace(/^\/+/, '');
  if (mediaBaseUrl) {
    return `${mediaBaseUrl.replace(/\/+$/, '')}/${clean}`;
  }
  return staticFile(clean);
}

export function getSongDurationSecs(start: string | number, end: string | number): number {
  const s = parseTime(start);
  const e = parseTime(end);
  return Math.max(1, e - s);
}

export function visualWidth(str: string): number {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += str.charCodeAt(i) > 255 ? 2 : 1;
  }
  return w;
}

export function splitIntroPages(text: string | undefined): string[] {
  const raw = (text || '').trim();
  if (!raw) return [''];
  const split = raw
    .split(/\r?\n\s*\r?\n|^---+$/m)
    .map((p) => p.trim())
    .filter(Boolean);
  return split.length > 0 ? split : [raw];
}

export function estimatePageReadingSecs(pageText: string): number {
  const chars = pageText.replace(/\s+/g, '').length;
  // ~1.3s fade buffer + ~0.2s per character, clamped between 2.8s and 12s
  return Math.max(2.8, Math.min(12, 1.3 + chars * 0.2));
}

export function computeIntroTiming(
  text: string | undefined,
  autoDuration: boolean | undefined,
  manualDuration: number | undefined,
): { pages: string[]; pageWeights: number[]; totalSecs: number } {
  const pages = splitIntroPages(text);
  const weights = pages.map((p) => estimatePageReadingSecs(p));
  const autoTotal =
    Math.round(weights.reduce((sum, w) => sum + w, 0) * 2) / 2;
  const totalSecs =
    autoDuration !== false
      ? Math.max(3, autoTotal)
      : Math.max(1, manualDuration || 8);
  return { pages, pageWeights: weights, totalSecs };
}
