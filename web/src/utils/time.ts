import type { PlaylistConfig, SongClip, SongItem } from '../types/studio';

export function parseSec(t: string | number | undefined): number {
  if (typeof t === 'number') {
    return Number.isFinite(t) ? t : 0;
  }
  const raw = String(t ?? '0').trim();
  if (!raw) return 0;
  const sign = raw.startsWith('-') ? -1 : 1;
  const s = sign < 0 ? raw.slice(1).trim() : raw;
  if (!s) return 0;
  const parts = s.split(':');
  if (parts.length === 3) {
    const total =
      (parseInt(parts[0], 10) || 0) * 3600 +
      (parseInt(parts[1], 10) || 0) * 60 +
      (parseFloat(parts[2]) || 0);
    return Number.isFinite(total) ? sign * total : 0;
  }
  if (parts.length === 2) {
    const total = (parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0);
    return Number.isFinite(total) ? sign * total : 0;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? sign * v : 0;
}

export function fmtSec(sec: number): string {
  if (!Number.isFinite(sec)) {
    return '0:00.0';
  }
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  const rem = ((tenths % 600) / 10).toFixed(1);
  return `${m}:${parseFloat(rem) < 10 ? '0' + rem : rem}`;
}

export function splitReasonParagraphs(text: string | undefined): string[] {
  const raw = (text || '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n\s*\r?\n|^---+$/m)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function computeAutoIntroDuration(text: string | undefined): number {
  const pages = splitReasonParagraphs(text);
  const list = pages.length ? pages : [''];
  const total = list.reduce((sum, p) => {
    const chars = p.replace(/\s+/g, '').length;
    return sum + Math.max(2.8, Math.min(12, 1.3 + chars * 0.2));
  }, 0);
  return Math.max(3, Math.round(total * 2) / 2);
}

export function syncTimingsArray(
  timings: number[] | undefined,
  count: number,
  totalSecs: number,
): number[] {
  const arr = Array.isArray(timings) ? [...timings] : [];
  if (arr.length > count) arr.length = count;
  const step = count > 0 ? Math.max(2, Math.round((totalSecs / count) * 10) / 10) : 5;
  for (let i = 0; i < count; i += 1) {
    if (typeof arr[i] !== 'number' || Number.isNaN(arr[i])) {
      arr[i] = i === 0 ? 0 : Math.round(i * step * 10) / 10;
    }
  }
  return arr;
}

export function cloneClip(c: Partial<SongClip>): SongClip {
  return {
    start: c.start || '0:00',
    end: c.end || '0:30',
    reason: c.reason || '',
    reason_mode: c.reason_mode === 'manual' ? 'manual' : 'auto',
    reason_timings: Array.isArray(c.reason_timings) ? [...c.reason_timings] : [],
  };
}

export function getEffectiveClips(song: SongItem | null | undefined): SongClip[] {
  if (!song) return [];
  if (Array.isArray(song.clips) && song.clips.length > 0) {
    return song.clips.map(cloneClip);
  }
  return [
    cloneClip({
      start: song.start || '0:00',
      end: song.end || '0:30',
      reason: song.reason || '',
      reason_mode: song.reason_mode || 'auto',
      reason_timings: song.reason_timings,
    }),
  ];
}

export function applyClipsToSong(song: SongItem, clips: SongClip[]): SongItem {
  const normalized = clips.length > 0 ? clips.map(cloneClip) : [cloneClip({})];
  const first = normalized[0];
  return {
    ...song,
    start: first.start,
    end: first.end,
    reason: first.reason,
    reason_mode: first.reason_mode,
    reason_timings: [...first.reason_timings],
    clips: normalized.length > 1 ? normalized : [],
  };
}

export function songTotalSeconds(song: SongItem | null | undefined): number {
  if (!song) return 0;
  if (Array.isArray(song.clips) && song.clips.length > 0) {
    return song.clips.reduce(
      (acc, c) => acc + Math.max(0, parseSec(c.end) - parseSec(c.start)),
      0,
    );
  }
  return Math.max(0, parseSec(song.end) - parseSec(song.start));
}

export function formatSongDuration(song: SongItem | null | undefined): string {
  const d = songTotalSeconds(song);
  return d > 0 ? `${d.toFixed(1)}s` : '--';
}

export function computeTotalPlaylistDurationStr(playlist: PlaylistConfig): string {
  let sum = playlist.intro?.enabled ? Number(playlist.intro.duration) || 0 : 0;
  for (const s of playlist.songs || []) {
    sum += songTotalSeconds(s);
  }
  return fmtSec(sum);
}

export function coverSrc(song: SongItem | null | undefined): string {
  if (!song) return '';
  if (song.cover_path && song.has_cover !== false) {
    const parts = song.cover_path.split('/');
    const last = parts[parts.length - 1] || '';
    const winParts = last.split('\\');
    const name = winParts[winParts.length - 1] || '';
    if (name) {
      return `/covers/${encodeURIComponent(name)}`;
    }
  }
  return song.cover_url || '';
}
