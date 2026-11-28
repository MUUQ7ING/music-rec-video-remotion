import { isPublicDemo, publicDemoResponse } from './publicDemo';
import {
  RUNTIME_SONG_FIELDS,
  type BiliQrGenerateResponse,
  type BiliQrPollResponse,
  type BiliStatus,
  type CandidateItem,
  type CandidatePlatform,
  type LyricsResponse,
  type NeteaseAudioConfig,
  type PlaylistConfig,
  type SongItem,
  type StatusState,
} from '../types/studio';

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function extractErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    if (typeof rec.detail === 'string' && rec.detail.trim()) return rec.detail;
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
  }
  return fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await (isPublicDemo ? publicDemoResponse(url, init) : fetch(url, init));
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(data, `HTTP ${res.status}`), data);
  }
  return data as T;
}

export interface PreviewWaveform {
  duration: number;
  peaks: number[];
}

export function loadPreviewWaveform(index: number, signal: AbortSignal): Promise<PreviewWaveform> {
  return requestJson<PreviewWaveform>(`/api/waveform/${index}`, { signal });
}

export function normalizeSong(raw: Partial<SongItem>): SongItem {
  return {
    ...raw,
    title: raw.title ?? '未命名曲目',
    artist: raw.artist ?? '',
    album: raw.album ?? '',
    netease_id: raw.netease_id ?? '',
    youtube_url: raw.youtube_url ?? '',
    media_source: raw.media_source ?? 'auto',
    start: raw.start ?? '0:00',
    end: raw.end ?? '0:30',
    clips: Array.isArray(raw.clips) ? raw.clips : [],
    file_path: raw.file_path ?? '',
    audio_path: raw.audio_path ?? '',
    normalized_path: raw.normalized_path ?? '',
    cover_url: raw.cover_url ?? '',
    cover_path: raw.cover_path ?? '',
    reason: raw.reason ?? '',
    reason_mode: raw.reason_mode === 'manual' ? 'manual' : 'auto',
    reason_timings: Array.isArray(raw.reason_timings) ? raw.reason_timings : [],
    transition_style: raw.transition_style ?? 'inherit',
    visual_effect: raw.visual_effect ?? 'auto',
    visual_modifiers: Array.isArray(raw.visual_modifiers) ? raw.visual_modifiers : [],
    display_index: raw.display_index ?? null,
    lyrics_path: raw.lyrics_path ?? '',
    lyrics_offset: Number(raw.lyrics_offset) || 0,
    lyrics_enabled: raw.lyrics_enabled !== false,
    shadow_boost: raw.shadow_boost ?? 'auto',
    detected_bright: raw.detected_bright && typeof raw.detected_bright === 'object' ? raw.detected_bright : {},
  };
}

export function normalizePlaylist(raw: Partial<PlaylistConfig>): PlaylistConfig {
  return {
    ...raw,
    output_sequence_name: raw.output_sequence_name ?? '音乐推荐合辑',
    resolution: raw.resolution ?? { width: 1920, height: 1080 },
    fps: Number(raw.fps) || 60,
    intro: raw.intro ?? {
      enabled: false,
      text: '',
      auto_duration: true,
      duration: 8,
      bg_mode: 'blur_first_song',
      bg_image: '',
    },
    transition: raw.transition ?? {
      video_style: 'cross_dissolve',
      video_duration: 0.6,
      audio_duration: 0.8,
    },
    songs: Array.isArray(raw.songs) ? raw.songs.map(normalizeSong) : [],
  };
}

export function sanitizePlaylistForSave(playlist: PlaylistConfig): PlaylistConfig {
  const runtimeSet = new Set<string>(RUNTIME_SONG_FIELDS);
  return {
    ...playlist,
    songs: (playlist.songs || []).map((song) => {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(song)) {
        if (!runtimeSet.has(k)) {
          cleaned[k] = v;
        }
      }
      return cleaned as unknown as SongItem;
    }),
  };
}

export async function fetchPlaylistApi(): Promise<PlaylistConfig> {
  const data = await requestJson<Partial<PlaylistConfig>>('/api/playlist');
  return normalizePlaylist(data);
}

export async function savePlaylistApi(
  playlist: PlaylistConfig,
): Promise<{ status: string; message?: string }> {
  return requestJson<{ status: string; message?: string }>('/api/playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: sanitizePlaylistForSave(playlist) }),
  });
}

export async function fetchStatusApi(): Promise<StatusState> {
  return requestJson<StatusState>('/api/status');
}

export async function clearLogsApi(): Promise<{ status: string }> {
  return requestJson<{ status: string }>('/api/logs/clear', { method: 'POST' });
}

export async function fetchLyricsApi(idx: number): Promise<LyricsResponse> {
  return requestJson<LyricsResponse>(`/api/lyrics/${idx}`);
}

export async function refetchLyricsApi(idx: number): Promise<LyricsResponse> {
  return requestJson<LyricsResponse>(`/api/lyrics/${idx}`, { method: 'POST' });
}

export async function searchCandidatesApi(
  query: string,
  platform: CandidatePlatform,
  limit = 12,
): Promise<{ status: string; candidates: CandidateItem[] }> {
  const params = new URLSearchParams({
    query,
    platform,
    limit: String(limit),
  });
  return requestJson<{ status: string; candidates: CandidateItem[] }>(
    `/api/candidates?${params.toString()}`,
  );
}

export async function uploadMediaApi(
  idx: number,
  file: File,
): Promise<{ status: string; file_path: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return requestJson<{ status: string; file_path: string }>(`/api/upload_media/${idx}`, {
    method: 'POST',
    body: fd,
  });
}

export async function downloadSingleApi(
  idx: number,
  force = true,
  quality = '1080',
): Promise<{ status: string; message?: string; queue_count?: number }> {
  return requestJson('/api/download_single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: idx, force, quality }),
  });
}

export async function downloadAllApi(
  force = false,
  quality = '1080',
): Promise<{ status: string; message?: string }> {
  return requestJson('/api/download_all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force, quality }),
  });
}

export async function runPreprocessApi(
  force = false,
): Promise<{ status: string; message?: string }> {
  return requestJson('/api/preprocess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
}

export async function analyzeVisualsApi(): Promise<{ status: string }> {
  return requestJson('/api/analyze_visuals', { method: 'POST' });
}

export async function openRemotionStudioApi(): Promise<{ status: string; url: string }> {
  return requestJson('/api/remotion/studio', { method: 'POST' });
}

export async function renderRemotionApi(
  outputName: string | null,
): Promise<{ status: string; message?: string }> {
  return requestJson('/api/remotion/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_name: outputName }),
  });
}

export async function cancelRemotionApi(): Promise<{ status: string; message?: string }> {
  return requestJson('/api/remotion/cancel', { method: 'POST' });
}

export function fetchProjectsApi() {
  return requestJson<{ active: string; projects: { id: string; name: string }[] }>('/api/projects');
}

export function createProjectApi(name: string, duplicate: boolean) {
  return requestJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, duplicate }),
  });
}

export function activateProjectApi(id: string) {
  return requestJson(`/api/projects/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

export function importProjectsApi(urls: string[], limit: number) {
  return requestJson('/api/projects/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls, limit }),
  });
}

export async function importNeteaseApi(
  url: string,
  limit: number,
  append: boolean,
): Promise<{ status: string; count: number; playlist_name?: string }> {
  return requestJson('/api/netease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, limit, append }),
  });
}

export function fetchYoutubeCookiesApi() {
  return requestJson<{ configured: boolean }>('/api/youtube/cookies');
}

export function importYoutubeCookiesApi(file: File) {
  const form = new FormData();
  form.append('file', file);
  return requestJson<{ configured: boolean }>('/api/youtube/cookies', { method: 'POST', body: form });
}

export async function fetchBiliStatusApi(): Promise<BiliStatus> {
  return requestJson<BiliStatus>('/api/bilibili/status');
}

export async function generateBiliQrApi(): Promise<BiliQrGenerateResponse> {
  return requestJson<BiliQrGenerateResponse>('/api/bilibili/qr/generate', { method: 'POST' });
}

export async function pollBiliQrApi(qrcodeKey: string): Promise<BiliQrPollResponse> {
  return requestJson<BiliQrPollResponse>(
    `/api/bilibili/qr/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
  );
}

export async function logoutBiliApi(): Promise<{ status: string }> {
  return requestJson('/api/bilibili/logout', { method: 'POST' });
}

export async function fetchNeteaseAudioConfigApi(): Promise<NeteaseAudioConfig> {
  return requestJson<NeteaseAudioConfig>('/api/netease_audio/config');
}

export async function saveNeteaseAudioConfigApi(payload: {
  api_url?: string;
  api_key?: string;
  default_quality?: string;
  script_text?: string;
}): Promise<NeteaseAudioConfig> {
  return requestJson<NeteaseAudioConfig>('/api/netease_audio/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function downloadNeteaseAudioSingleApi(
  index: number,
  mode: 'video' | 'audio',
  quality: string,
  force = true,
): Promise<{ status: string; message?: string; queue_count?: number }> {
  return requestJson('/api/netease_audio/download_single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, mode, quality, force }),
  });
}

export async function downloadNeteaseAudioBatchApi(
  mode: 'video' | 'audio',
  quality: string,
  force: boolean,
  missingOnly: boolean,
): Promise<{ status: string; message?: string }> {
  return requestJson('/api/netease_audio/download_all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, quality, force, missing_only: missingOnly }),
  });
}
