import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  analyzeVisualsApi,
  cancelRemotionApi,
  clearLogsApi,
  downloadAllApi,
  downloadNeteaseAudioBatchApi,
  downloadNeteaseAudioSingleApi,
  downloadSingleApi,
  fetchBiliStatusApi,
  fetchLyricsApi,
  fetchNeteaseAudioConfigApi,
  fetchPlaylistApi,
  fetchStatusApi,
  generateBiliQrApi,
  importNeteaseApi,
  logoutBiliApi,
  openRemotionStudioApi,
  pollBiliQrApi,
  refetchLyricsApi,
  renderRemotionApi,
  runPreprocessApi,
  saveNeteaseAudioConfigApi,
  savePlaylistApi,
  searchCandidatesApi,
  uploadMediaApi,
} from '../api/client';
import {
  RUNTIME_SONG_FIELDS,
  type ActiveView,
  type BiliStatus,
  type CandidateItem,
  type CandidatePlatform,
  type EffectiveSourceMode,
  type IntroBgMode,
  type LyricLine,
  type MediaSourceMode,
  type NeteaseAudioConfig,
  type PlaylistConfig,
  type RackFilter,
  type ReasonMode,
  type SaveState,
  type SongClip,
  type SongItem,
  type StatusState,
  type ThemeMode,
  type ToastState,
  type WorkspaceTab,
} from '../types/studio';
import {
  applyClipsToSong,
  computeAutoIntroDuration,
  computeTotalPlaylistDurationStr,
  fmtSec,
  getEffectiveClips,
  parseSec,
  splitReasonParagraphs,
  syncTimingsArray,
} from '../utils/time';

const EMPTY_PLAYLIST: PlaylistConfig = {
  output_sequence_name: '',
  fps: 60,
  resolution: { width: 1920, height: 1080 },
  intro: {
    enabled: false,
    text: '',
    auto_duration: true,
    duration: 8,
    bg_mode: 'blur_first_song',
    bg_image: '',
  },
  transition: {
    video_style: 'cross_dissolve',
    video_duration: 0.6,
    audio_duration: 0.8,
  },
  songs: [],
};

const EMPTY_STATUS: StatusState = {
  is_downloading: false,
  is_rendering: false,
  queue_count: 0,
  current_song: '',
  logs: [],
  progress_percent: 0,
};

function createEmptySong(): SongItem {
  return {
    title: '未命名曲目',
    artist: '未知歌手',
    album: '',
    netease_id: '',
    youtube_url: '',
    media_source: 'auto',
    start: '0:00',
    end: '0:30',
    clips: [],
    file_path: '',
    audio_path: '',
    normalized_path: '',
    cover_url: '',
    cover_path: '',
    reason: '',
    reason_mode: 'auto',
    reason_timings: [],
    transition_style: 'inherit',
    visual_effect: 'auto',
    visual_modifiers: [],
    display_index: null,
    lyrics_path: '',
    lyrics_offset: 0,
    lyrics_enabled: true,
    shadow_boost: 'auto',
    detected_bright: {},
  };
}

function getEffectiveSourceMode(song: SongItem | null): EffectiveSourceMode {
  if (!song) return 'video_url';
  if (song.media_source === 'netease_cover') return 'netease_cover';
  if (song.media_source === 'local') return 'local';
  if (song.media_source === 'auto' && song.file_path && song.file_path.includes('_local.')) {
    return 'local';
  }
  return 'video_url';
}

function matchSongsByPriority(
  sourceSongs: SongItem[],
  targetSongs: SongItem[],
): Array<SongItem | null> {
  const matches: Array<SongItem | null> = new Array(sourceSongs.length).fill(null);
  const used = new Set<SongItem>();

  for (let idx = 0; idx < sourceSongs.length; idx++) {
    const src = sourceSongs[idx];
    if (!src.netease_id) continue;
    const byId = targetSongs.find(
      (s) => !used.has(s) && s.netease_id && s.netease_id === src.netease_id,
    );
    if (byId) {
      matches[idx] = byId;
      used.add(byId);
    }
  }

  for (let idx = 0; idx < sourceSongs.length; idx++) {
    if (matches[idx]) continue;
    const src = sourceSongs[idx];
    const sameIdx = targetSongs[idx];
    if (
      sameIdx &&
      !used.has(sameIdx) &&
      sameIdx.title === src.title &&
      sameIdx.artist === src.artist
    ) {
      matches[idx] = sameIdx;
      used.add(sameIdx);
    }
  }

  for (let idx = 0; idx < sourceSongs.length; idx++) {
    if (matches[idx]) continue;
    const src = sourceSongs[idx];
    const byTitle = targetSongs.find(
      (s) => !used.has(s) && s.title === src.title && s.artist === src.artist,
    );
    if (byTitle) {
      matches[idx] = byTitle;
      used.add(byTitle);
    }
  }

  for (let idx = 0; idx < sourceSongs.length; idx++) {
    if (matches[idx]) continue;
    const sameIdx = targetSongs[idx];
    if (sameIdx && !used.has(sameIdx)) {
      matches[idx] = sameIdx;
      used.add(sameIdx);
    }
  }

  return matches;
}

const songTokenMap = new WeakMap<SongItem, symbol>();

function getSongToken(song: SongItem): symbol {
  let tok = songTokenMap.get(song);
  if (!tok) {
    tok = Symbol('song');
    songTokenMap.set(song, tok);
  }
  return tok;
}

function transferSongToken(fromSong: SongItem, toSong: SongItem): SongItem {
  if (fromSong !== toSong) {
    const tok = getSongToken(fromSong);
    songTokenMap.set(toSong, tok);
  }
  return toSong;
}

function findSongIndexByToken(songs: SongItem[], token: symbol): number {
  return songs.findIndex((s) => getSongToken(s) === token);
}

function transferMatchedTokens(
  prevSongs: SongItem[],
  nextSongs: SongItem[],
): Map<number, number> {
  const matches = matchSongsByPriority(prevSongs, nextSongs);
  const nextIndexBySong = new Map<SongItem, number>();
  nextSongs.forEach((song, idx) => {
    nextIndexBySong.set(song, idx);
  });
  const indexMap = new Map<number, number>();
  prevSongs.forEach((prevSong, idx) => {
    const matched = matches[idx];
    if (matched) {
      transferSongToken(prevSong, matched);
      const nextIdx = nextIndexBySong.get(matched);
      if (nextIdx !== undefined) {
        indexMap.set(idx, nextIdx);
      }
    }
  });
  return indexMap;
}

function remapIndexRecordByIndexMap<T>(
  rec: Record<number, T>,
  indexMap: Map<number, number>,
): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [rawKey, val] of Object.entries(rec)) {
    const k = Number(rawKey);
    if (!Number.isInteger(k)) continue;
    const mapped = indexMap.get(k);
    if (mapped !== undefined) {
      next[mapped] = val;
    }
  }
  return next;
}

function mergeRuntimeFields(localPl: PlaylistConfig, serverPl: PlaylistConfig): PlaylistConfig {
  const localSongs = localPl.songs || [];
  const serverSongs = serverPl.songs || [];
  const matches = matchSongsByPriority(localSongs, serverSongs);
  return {
    ...localPl,
    songs: localSongs.map((song, idx) => {
      const matched = matches[idx];
      if (!matched) return song;
      const next: SongItem = { ...song };
      const nextRec = next as Record<string, unknown>;
      const matchedRec = matched as Record<string, unknown>;
      for (const field of RUNTIME_SONG_FIELDS) {
        if (field in matched) {
          nextRec[field] = matchedRec[field];
        }
      }
      if (matched.file_path) next.file_path = matched.file_path;
      if (matched.normalized_path) next.normalized_path = matched.normalized_path;
      if (matched.cover_path) next.cover_path = matched.cover_path;
      if (matched.audio_path) next.audio_path = matched.audio_path;
      if (matched.lyrics_path) next.lyrics_path = matched.lyrics_path;
      if (matched.detected_bright && Object.keys(matched.detected_bright).length > 0) {
        next.detected_bright = matched.detected_bright;
      }
      return transferSongToken(song, next);
    }),
  };
}

function remapIndexRecordOnDelete<T>(
  rec: Record<number, T>,
  deletedIdx: number,
): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [rawKey, val] of Object.entries(rec)) {
    const k = Number(rawKey);
    if (!Number.isInteger(k) || k === deletedIdx) continue;
    next[k > deletedIdx ? k - 1 : k] = val;
  }
  return next;
}

function remapIndexRecordOnReorder<T>(
  rec: Record<number, T>,
  fromIdx: number,
  toIdx: number,
): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [rawKey, val] of Object.entries(rec)) {
    const k = Number(rawKey);
    if (!Number.isInteger(k)) continue;
    let mapped = k;
    if (k === fromIdx) mapped = toIdx;
    else if (fromIdx < toIdx && k > fromIdx && k <= toIdx) mapped = k - 1;
    else if (fromIdx > toIdx && k >= toIdx && k < fromIdx) mapped = k + 1;
    next[mapped] = val;
  }
  return next;
}

export interface StudioStoreContextValue {
  hydrated: boolean;
  theme: ThemeMode;
  toggleTheme: () => void;
  playlist: PlaylistConfig;
  status: StatusState;
  dirty: boolean;
  saveState: SaveState;
  saveError: string | null;
  isSaving: boolean;
  openingStudio: boolean;
  rackFilter: RackFilter;
  setRackFilter: (f: RackFilter) => void;
  activeView: ActiveView;
  activeIdx: number;
  activeTab: WorkspaceTab;
  setActiveTab: (t: WorkspaceTab) => void;
  activeClipIdx: number;
  mediaVersion: number;
  filteredSongs: Array<{ song: SongItem; idx: number }>;
  activeSong: SongItem | null;
  activeClips: SongClip[];
  activeClip: SongClip | null;
  activeMediaUrl: string;
  activeSourceMode: EffectiveSourceMode;
  totalDurationStr: string;
  readyCount: number;
  missingCount: number;
  introPageCount: number;
  trimCurrentSec: number;
  trimTotalSec: number;
  isPlaying: boolean;
  trimLoopPlaying: boolean;
  setTrimLoopPlaying: (v: boolean) => void;
  lyricsLines: LyricLine[];
  loadingLyrics: boolean;
  activeLyricIdx: number;
  showLogs: boolean;
  setShowLogs: (v: boolean | ((prev: boolean) => boolean)) => void;
  showTools: boolean;
  setShowTools: (v: boolean | ((prev: boolean) => boolean)) => void;
  toast: ToastState | null;
  dismissToast: () => void;
  notify: (message: string, kind?: 'info' | 'success') => void;
  notifyError: (message: string, opts?: { persistent?: boolean; showRetry?: boolean }) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  selectSong: (idx: number) => void;
  selectIntro: () => void;
  stepTrack: (delta: number) => void;
  setSequenceName: (name: string) => void;
  savePlaylist: (opts?: { silent?: boolean; successMessage?: string }) => Promise<boolean>;
  retrySave: () => Promise<boolean>;
  addEmptySong: () => Promise<void>;
  deleteSong: (idx: number) => Promise<void>;
  reorderSongs: (fromIdx: number, toIdx: number) => Promise<void>;
  switchTrimClip: (cIdx: number) => void;
  addTrimClip: () => void;
  removeTrimClip: (cIdx: number) => void;
  setTrimPoint: (which: 'in' | 'out') => void;
  nudgeTrim: (which: 'in' | 'out', delta: number) => void;
  setScrubPoint: (which: 'in' | 'out', sec: number) => void;
  setClipReason: (text: string) => void;
  setClipReasonMode: (mode: ReasonMode) => void;
  setClipReasonTiming: (pIdx: number, val: number) => void;
  stampClipReasonTiming: (pIdx: number) => void;
  applyTrimAndSave: () => Promise<boolean>;
  onVideoLoaded: () => void;
  onVideoTimeUpdate: () => void;
  onFxTimeUpdate: (seconds: number) => void;
  onVideoPlayState: (playing: boolean) => void;
  togglePlay: () => void;
  seekTo: (sec: number) => void;
  seekBy: (delta: number) => void;
  nudgeLyricsOffset: (delta: number) => void;
  resetLyricsOffset: () => void;
  alignLyricToCurrent: (ln: LyricLine) => void;
  refetchLyrics: () => Promise<void>;
  updateActiveSongField: <K extends keyof SongItem>(key: K, value: SongItem[K]) => void;
  setClipVisualEffect: (value: string) => void;
  toggleVisualModifier: (modId: string) => Promise<void>;
  saveMeta: () => Promise<boolean>;
  updateIntroField: (
    patch: Partial<PlaylistConfig['intro']>,
    opts?: { recalc?: boolean },
  ) => void;
  setIntroBgMode: (mode: IntroBgMode) => void;
  updateGlobalTransition: (patch: Partial<PlaylistConfig['transition']>) => void;
  saveIntroConfig: () => Promise<boolean>;
  activePlatform: CandidatePlatform;
  activeCandidates: CandidateItem[];
  customQuery: string;
  setCustomQuery: (q: string) => void;
  loadingCandidates: boolean;
  sourceGalleryOpen: boolean;
  setSourceGalleryOpen: (v: boolean) => void;
  openCandidateGallery: () => void;
  setPlatform: (p: CandidatePlatform) => void;
  searchCandidates: (idx?: number) => Promise<void>;
  lockedCandidate: CandidateItem | null;
  showCandidateGallery: boolean;
  sourceCanPlayVideo: boolean;
  setSourceMode: (mode: MediaSourceMode) => Promise<void>;
  adoptCandidate: (cand: CandidateItem, autoDownload?: boolean) => Promise<void>;
  uploadingLocal: boolean;
  uploadLocalFile: (file: File) => Promise<void>;
  downloadSingle: (idx?: number) => Promise<void>;
  downloadAll: () => Promise<void>;
  runPreprocess: () => Promise<void>;
  analyzeAllVisuals: () => Promise<void>;
  openRemotionStudio: () => Promise<string | undefined>;
  renderRemotionVideo: () => Promise<void>;
  cancelRemotionRender: () => Promise<void>;
  clearLogs: () => Promise<void>;
  showNeteaseModal: boolean;
  setShowNeteaseModal: (v: boolean) => void;
  importingNetease: boolean;
  importNetease: (url: string, limit: number, append: boolean) => Promise<boolean>;
  biliUser: BiliStatus;
  showBiliModal: boolean;
  biliQrLoading: boolean;
  biliQrUrl: string;
  biliQrMessage: string;
  openBiliModal: () => Promise<void>;
  closeBiliModal: () => void;
  generateBiliQr: () => Promise<void>;
  logoutBili: () => Promise<void>;
  showNeteaseAudioModal: boolean;
  setShowNeteaseAudioModal: (v: boolean) => void;
  neteaseAudioCfg: NeteaseAudioConfig;
  savingNeteaseAudioCfg: boolean;
  openNeteaseAudioModal: () => Promise<void>;
  saveNeteaseAudioCfg: (payload: {
    api_url?: string;
    api_key?: string;
    default_quality?: string;
    script_text?: string;
  }) => Promise<boolean>;
  downloadNeteaseAudioSingle: (
    idx: number,
    mode: 'video' | 'audio',
    quality: string,
  ) => Promise<void>;
  downloadNeteaseAudioBatch: (
    mode: 'video' | 'audio',
    quality: string,
    missingOnly: boolean,
  ) => Promise<void>;
}

const StudioStoreContext = createContext<StudioStoreContextValue | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const initialTheme: ThemeMode =
    typeof window !== 'undefined' && localStorage.getItem('mrv_theme') === 'dark'
      ? 'dark'
      : 'light';

  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [hydrated, setHydrated] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistConfig>(EMPTY_PLAYLIST);
  const [status, setStatus] = useState<StatusState>(EMPTY_STATUS);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [openingStudio, setOpeningStudio] = useState(false);

  const [rackFilter, setRackFilter] = useState<RackFilter>('all');
  const [activeView, setActiveView] = useState<ActiveView>('song');
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('trim');
  const [activeClipIdx, setActiveClipIdx] = useState(0);
  const [mediaVersion, setMediaVersion] = useState(() => Date.now());
  const [mediaSyncPending, setMediaSyncPending] = useState(false);

  const [trimCurrentSec, setTrimCurrentSec] = useState(0);
  const [trimTotalSec, setTrimTotalSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimLoopPlaying, setTrimLoopPlaying] = useState(false);

  const [lyricsLines, setLyricsLines] = useState<LyricLine[]>([]);
  const [loadingLyrics, setLoadingLyrics] = useState(false);

  const [showLogs, setShowLogs] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [candidatesMap, setCandidatesMap] = useState<Record<number, CandidateItem[]>>({});
  const [platformMap, setPlatformMap] = useState<Record<number, CandidatePlatform>>({});
  const [customQueries, setCustomQueries] = useState<Record<number, string>>({});
  const [loadingCandidatesMap, setLoadingCandidatesMap] = useState<Record<number, boolean>>({});
  const [sourceGalleryOpen, setSourceGalleryOpen] = useState(false);
  const [undownloadedPickUrl, setUndownloadedPickUrl] = useState('');
  const [uploadingLocal, setUploadingLocal] = useState(false);

  const [showNeteaseModal, setShowNeteaseModal] = useState(false);
  const [importingNetease, setImportingNetease] = useState(false);

  const [biliUser, setBiliUser] = useState<BiliStatus>({
    logged_in: false,
    uname: '',
    is_vip: false,
    vip_label: '',
  });
  const [showBiliModal, setShowBiliModal] = useState(false);
  const [biliQrLoading, setBiliQrLoading] = useState(false);
  const [biliQrUrl, setBiliQrUrl] = useState('');
  const [biliQrMessage, setBiliQrMessage] = useState('请使用手机 B 站 App 扫码登录');

  const [showNeteaseAudioModal, setShowNeteaseAudioModal] = useState(false);
  const [neteaseAudioCfg, setNeteaseAudioCfg] = useState<NeteaseAudioConfig>({
    configured: false,
    api_url: '',
    api_key_masked: '',
    default_quality: 'flac',
    qualities: [],
  });
  const [savingNeteaseAudioCfg, setSavingNeteaseAudioCfg] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playlistRef = useRef(playlist);
  const dirtyRef = useRef(dirty);
  const saveEpochRef = useRef(0);
  const wasBusyRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const biliPollTimerRef = useRef<number | null>(null);
  const biliQrEpochRef = useRef(0);
  const biliModalOpenRef = useRef(false);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const activeIdxRef = useRef(activeIdx);
  const activeViewRef = useRef(activeView);
  const activeTabRef = useRef(activeTab);
  const candidatesMapRef = useRef(candidatesMap);
  const platformMapRef = useRef(platformMap);
  const customQueriesRef = useRef(customQueries);
  const loadingCandidatesMapRef = useRef(loadingCandidatesMap);
  const autoSearchedTokensRef = useRef<Set<symbol>>(new Set());
  const searchEpochByTokenRef = useRef<Map<symbol, number>>(new Map());
  const lyricsEpochRef = useRef(0);
  const pendingLyricsReloadRef = useRef(false);
  const neteaseAudioEpochRef = useRef(0);
  const mediaSyncEpochRef = useRef(0);
  const committedMediaSyncEpochRef = useRef(0);

  playlistRef.current = playlist;
  dirtyRef.current = dirty;
  activeIdxRef.current = activeIdx;
  activeViewRef.current = activeView;
  activeTabRef.current = activeTab;
  candidatesMapRef.current = candidatesMap;
  platformMapRef.current = platformMap;
  customQueriesRef.current = customQueries;
  loadingCandidatesMapRef.current = loadingCandidatesMap;

  const commitPlaylist = useCallback((next: PlaylistConfig, markDirty = true) => {
    playlistRef.current = next;
    setPlaylist(next);
    if (markDirty) {
      saveEpochRef.current += 1;
      dirtyRef.current = true;
      setDirty(true);
      setSaveState('dirty');
      setSaveError(null);
    }
  }, []);

  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, [clearToastTimer]);

  const notify = useCallback(
    (message: string, kind: 'info' | 'success' = 'info') => {
      clearToastTimer();
      setToast({ message, kind, persistent: false, showRetry: false });
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
      }, 2400);
    },
    [clearToastTimer],
  );

  const notifyError = useCallback(
    (message: string, opts?: { persistent?: boolean; showRetry?: boolean }) => {
      clearToastTimer();
      const persistent = Boolean(opts?.persistent);
      setToast({
        message,
        kind: 'error',
        persistent,
        showRetry: Boolean(opts?.showRetry),
      });
      if (!persistent) {
        toastTimerRef.current = window.setTimeout(() => {
          setToast(null);
        }, 3600);
      }
    },
    [clearToastTimer],
  );

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('mrv_theme', next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mrv_theme', theme);
  }, [theme]);

  const loadLyrics = useCallback(async (idx: number) => {
    const epoch = (lyricsEpochRef.current += 1);
    const targetSong = (playlistRef.current.songs || [])[idx];
    if (idx < 0 || !targetSong) {
      setLyricsLines([]);
      setLoadingLyrics(false);
      return;
    }
    const songToken = getSongToken(targetSong);
    setLoadingLyrics(true);
    try {
      const data = await fetchLyricsApi(idx);
      const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
      if (
        lyricsEpochRef.current === epoch &&
        currentIdx >= 0 &&
        activeIdxRef.current === currentIdx
      ) {
        setLyricsLines(data.lines || []);
      }
    } catch {
      const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
      if (
        lyricsEpochRef.current === epoch &&
        currentIdx >= 0 &&
        activeIdxRef.current === currentIdx
      ) {
        setLyricsLines([]);
      }
    } finally {
      if (lyricsEpochRef.current === epoch) {
        setLoadingLyrics(false);
      }
    }
  }, []);

  const remapCandidateCaches = useCallback((indexMap: Map<number, number>) => {
    candidatesMapRef.current = remapIndexRecordByIndexMap(candidatesMapRef.current, indexMap);
    platformMapRef.current = remapIndexRecordByIndexMap(platformMapRef.current, indexMap);
    customQueriesRef.current = remapIndexRecordByIndexMap(customQueriesRef.current, indexMap);
    loadingCandidatesMapRef.current = remapIndexRecordByIndexMap(
      loadingCandidatesMapRef.current,
      indexMap,
    );
    setCandidatesMap((prev) => remapIndexRecordByIndexMap(prev, indexMap));
    setPlatformMap((prev) => remapIndexRecordByIndexMap(prev, indexMap));
    setCustomQueries((prev) => remapIndexRecordByIndexMap(prev, indexMap));
    setLoadingCandidatesMap((prev) => remapIndexRecordByIndexMap(prev, indexMap));
  }, []);

  const fetchPlaylist = useCallback(
    async (preserveIndex = true) => {
      try {
        const data = await fetchPlaylistApi();
        const prevIdx = activeIdxRef.current;
        let indexMap: Map<number, number> | null = null;
        if (preserveIndex) {
          indexMap = transferMatchedTokens(
            playlistRef.current.songs || [],
            data.songs || [],
          );
          remapCandidateCaches(indexMap);
        }
        playlistRef.current = data;
        setPlaylist(data);
        dirtyRef.current = false;
        setDirty(false);
        setSaveState('saved');
        setSaveError(null);
        committedMediaSyncEpochRef.current = mediaSyncEpochRef.current;
        setMediaSyncPending(false);
        if (!preserveIndex) {
          pendingLyricsReloadRef.current = false;
          setMediaVersion(Date.now());
          candidatesMapRef.current = {};
          platformMapRef.current = {};
          customQueriesRef.current = {};
          loadingCandidatesMapRef.current = {};
          autoSearchedTokensRef.current.clear();
          searchEpochByTokenRef.current.clear();
          setCandidatesMap({});
          setPlatformMap({});
          setCustomQueries({});
          setLoadingCandidatesMap({});
        }
        const len = (data.songs || []).length;
        let nextIdx = -1;
        if (len > 0) {
          if (!preserveIndex) {
            nextIdx = 0;
          } else {
            const mapped = indexMap?.get(prevIdx);
            if (mapped !== undefined && mapped >= 0 && mapped < len) {
              nextIdx = mapped;
            } else if (prevIdx >= 0) {
              nextIdx = Math.min(prevIdx, len - 1);
            } else {
              nextIdx = 0;
            }
          }
        }
        activeIdxRef.current = nextIdx;
        setActiveIdx(nextIdx);
        setActiveClipIdx(0);
        setIsPlaying(false);
        setTrimCurrentSec(0);
        setTrimTotalSec(0);
        setSourceGalleryOpen(false);
        setUndownloadedPickUrl('');
        pendingLyricsReloadRef.current = false;
        if (nextIdx >= 0) {
          loadLyrics(nextIdx);
        } else {
          lyricsEpochRef.current += 1;
          setLyricsLines([]);
          setLoadingLyrics(false);
        }
      } finally {
        setHydrated(true);
      }
    },
    [loadLyrics, remapCandidateCaches],
  );

  const executeSave = useCallback(
    async (opts?: {
      silent?: boolean;
      successMessage?: string;
      overridePlaylist?: PlaylistConfig;
    }): Promise<boolean> => {
      const epoch = saveEpochRef.current;
      const syncEpochAtStart = mediaSyncEpochRef.current;
      const snapshot = opts?.overridePlaylist ?? playlistRef.current;
      setIsSaving(true);
      try {
        await savePlaylistApi(snapshot);
        if (syncEpochAtStart > committedMediaSyncEpochRef.current) {
          committedMediaSyncEpochRef.current = syncEpochAtStart;
          setMediaVersion(Date.now());
        }
        if (mediaSyncEpochRef.current === committedMediaSyncEpochRef.current) {
          setMediaSyncPending(false);
          if (pendingLyricsReloadRef.current) {
            pendingLyricsReloadRef.current = false;
            if (activeIdxRef.current >= 0) {
              void loadLyrics(activeIdxRef.current);
            }
          }
        }
        if (saveEpochRef.current === epoch) {
          dirtyRef.current = false;
          setDirty(false);
          setSaveState('saved');
          setSaveError(null);
          if (!opts?.silent) {
            notify(opts?.successMessage || '配置已保存', 'success');
          } else {
            setToast((prev) => (prev?.showRetry ? null : prev));
          }
        } else {
          dirtyRef.current = true;
          setDirty(true);
          setSaveState('dirty');
        }
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '保存失败，请检查服务或磁盘状态';
        dirtyRef.current = true;
        setDirty(true);
        setSaveState('error');
        setSaveError(msg);
        notifyError(`保存失败: ${msg}`, { persistent: true, showRetry: true });
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [loadLyrics, notify, notifyError],
  );

  const savePlaylist = useCallback(
    async (opts?: {
      silent?: boolean;
      successMessage?: string;
      overridePlaylist?: PlaylistConfig;
    }): Promise<boolean> => {
      const nextPromise = saveChainRef.current.then(
        () => executeSave(opts),
        () => executeSave(opts),
      );
      saveChainRef.current = nextPromise;
      return nextPromise;
    },
    [executeSave],
  );

  const retrySave = useCallback(async () => {
    const hadPendingMediaSync = mediaSyncEpochRef.current > committedMediaSyncEpochRef.current;
    const hadPendingLyricsReload = pendingLyricsReloadRef.current;
    const ok = await savePlaylist({ silent: false, successMessage: '重试保存成功' });
    if (
      ok &&
      hadPendingMediaSync &&
      !hadPendingLyricsReload &&
      mediaSyncEpochRef.current === committedMediaSyncEpochRef.current &&
      activeIdxRef.current >= 0
    ) {
      loadLyrics(activeIdxRef.current);
    }
    return ok;
  }, [loadLyrics, savePlaylist]);

  const filteredSongs = useMemo(() => {
    const list = (playlist.songs || []).map((song, idx) => ({ song, idx }));
    if (rackFilter === 'missing') {
      return list.filter(({ song }) => !song.has_file && !song.has_normalized);
    }
    return list;
  }, [playlist.songs, rackFilter]);

  const activeSong = useMemo(() => {
    if (activeView !== 'song') return null;
    const list = playlist.songs || [];
    if (activeIdx < 0 || activeIdx >= list.length) return null;
    return list[activeIdx];
  }, [activeView, activeIdx, playlist.songs]);

  const activeClips = useMemo(() => getEffectiveClips(activeSong), [activeSong]);

  const clampedClipIdx = useMemo(() => {
    if (activeClips.length === 0) return 0;
    return Math.max(0, Math.min(activeClipIdx, activeClips.length - 1));
  }, [activeClipIdx, activeClips.length]);

  const activeClip = activeClips[clampedClipIdx] || null;

  const activeMediaUrl = useMemo(() => {
    if (mediaSyncPending || !activeSong || (!activeSong.has_file && !activeSong.has_normalized)) {
      return '';
    }
    return `/api/media/${activeIdx}?v=${mediaVersion}`;
  }, [mediaSyncPending, activeSong, activeIdx, mediaVersion]);

  const activeSourceMode = useMemo(() => getEffectiveSourceMode(activeSong), [activeSong]);

  const totalDurationStr = useMemo(
    () => computeTotalPlaylistDurationStr(playlist),
    [playlist],
  );

  const readyCount = useMemo(
    () => (playlist.songs || []).filter((s) => s.has_file || s.has_normalized).length,
    [playlist.songs],
  );

  const missingCount = useMemo(
    () => (playlist.songs || []).filter((s) => !s.has_file && !s.has_normalized).length,
    [playlist.songs],
  );

  const introPageCount = useMemo(
    () => Math.max(1, splitReasonParagraphs(playlist.intro?.text).length),
    [playlist.intro?.text],
  );

  const selectSong = useCallback(
    (idx: number) => {
      if (activeViewRef.current === 'song' && activeIdxRef.current === idx) {
        return;
      }
      setActiveView('song');
      activeViewRef.current = 'song';
      setActiveIdx(idx);
      activeIdxRef.current = idx;
      setActiveClipIdx(0);
      setIsPlaying(false);
      setTrimCurrentSec(0);
      setTrimTotalSec(0);
      setSourceGalleryOpen(false);
      setUndownloadedPickUrl('');
      if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
        lyricsEpochRef.current += 1;
        setLyricsLines([]);
        setLoadingLyrics(false);
        pendingLyricsReloadRef.current = true;
      } else {
        pendingLyricsReloadRef.current = false;
        loadLyrics(idx);
      }
    },
    [loadLyrics],
  );

  const selectIntro = useCallback(() => {
    pendingLyricsReloadRef.current = false;
    setActiveView('intro');
    activeViewRef.current = 'intro';
    setIsPlaying(false);
  }, []);

  const stepTrack = useCallback(
    (delta: number) => {
      if (!filteredSongs.length) return;
      if (activeViewRef.current !== 'song') {
        selectSong(filteredSongs[0].idx);
        return;
      }
      const pos = filteredSongs.findIndex((item) => item.idx === activeIdxRef.current);
      const nextPos = Math.max(0, Math.min(filteredSongs.length - 1, (pos < 0 ? 0 : pos) + delta));
      selectSong(filteredSongs[nextPos].idx);
    },
    [filteredSongs, selectSong],
  );

  const setSequenceName = useCallback(
    (name: string) => {
      commitPlaylist({ ...playlistRef.current, output_sequence_name: name }, true);
    },
    [commitPlaylist],
  );

  const updateSongAt = useCallback(
    (idx: number, updater: (song: SongItem) => SongItem, markDirty = true): PlaylistConfig | null => {
      const songs = playlistRef.current.songs || [];
      if (idx < 0 || idx >= songs.length) return null;
      const nextSongs = songs.map((s, i) => (i === idx ? transferSongToken(s, updater(s)) : s));
      const next: PlaylistConfig = { ...playlistRef.current, songs: nextSongs };
      commitPlaylist(next, markDirty);
      return next;
    },
    [commitPlaylist],
  );

  const updateActiveClip = useCallback(
    (updater: (clip: SongClip, allClips: SongClip[]) => SongClip) => {
      const idx = activeIdxRef.current;
      return updateSongAt(idx, (song) => {
        const clips = getEffectiveClips(song);
        const cIdx = Math.max(0, Math.min(activeClipIdx, clips.length - 1));
        const updated = clips.map((c, i) => (i === cIdx ? updater(c, clips) : c));
        return applyClipsToSong(song, updated);
      });
    },
    [activeClipIdx, updateSongAt],
  );

  const seekTo = useCallback(
    (sec: number) => {
      const v = videoRef.current;
      const maxDur = trimTotalSec > 0 ? trimTotalSec : 99999;
      const target = Math.max(0, Math.min(maxDur, sec));
      setTrimCurrentSec(target);
      if (v) v.currentTime = target;
    },
    [trimTotalSec],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const cur = videoRef.current ? videoRef.current.currentTime : trimCurrentSec;
      seekTo(cur + delta);
    },
    [seekTo, trimCurrentSec],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const switchTrimClip = useCallback(
    (cIdx: number) => {
      if (cIdx === clampedClipIdx) return;
      setActiveClipIdx(cIdx);
      const nextClip = activeClips[cIdx];
      if (nextClip && videoRef.current && trimTotalSec > 0) {
        const startSec = parseSec(nextClip.start);
        videoRef.current.currentTime = Math.min(trimTotalSec, startSec);
        setTrimCurrentSec(videoRef.current.currentTime);
      }
    },
    [activeClips, clampedClipIdx, trimTotalSec],
  );

  const addTrimClip = useCallback(() => {
    const idx = activeIdxRef.current;
    const song = playlistRef.current.songs[idx];
    if (!song) return;
    const clips = getEffectiveClips(song);
    const cur = clips[Math.max(0, Math.min(activeClipIdx, clips.length - 1))];
    const prevEnd = parseSec(cur?.end);
    const newStart = Math.min(trimTotalSec || prevEnd + 10, prevEnd + 5);
    const newEnd = Math.min(trimTotalSec || newStart + 20, newStart + 20);
    const nextClips: SongClip[] = [
      ...clips,
      {
        start: fmtSec(newStart),
        end: fmtSec(Math.max(newStart + 3, newEnd)),
        reason: '',
        reason_mode: 'auto',
        reason_timings: [],
      },
    ];
    updateSongAt(idx, (s) => applyClipsToSong(s, nextClips));
    setActiveClipIdx(nextClips.length - 1);
  }, [activeClipIdx, trimTotalSec, updateSongAt]);

  const removeTrimClip = useCallback(
    (cIdx: number) => {
      const idx = activeIdxRef.current;
      const song = playlistRef.current.songs[idx];
      if (!song) return;
      const clips = getEffectiveClips(song);
      if (clips.length <= 1) return;
      const nextClips = clips.filter((_, i) => i !== cIdx);
      updateSongAt(idx, (s) => applyClipsToSong(s, nextClips));
      setActiveClipIdx(Math.max(0, Math.min(cIdx, nextClips.length - 1)));
    },
    [updateSongAt],
  );

  const setTrimPoint = useCallback(
    (which: 'in' | 'out') => {
      const durRaw =
        videoRef.current && Number.isFinite(videoRef.current.duration)
          ? videoRef.current.duration
          : trimTotalSec;
      const hasDur = Number.isFinite(durRaw) && durRaw > 0;
      const maxDur = hasDur ? Math.max(0.1, Math.round(durRaw * 10) / 10) : Infinity;
      const cur = videoRef.current ? videoRef.current.currentTime : trimCurrentSec;
      const rawRounded = Math.max(0, Math.round((Number.isFinite(cur) ? cur : 0) * 10) / 10);
      const rounded = hasDur ? Math.min(maxDur, rawRounded) : rawRounded;
      updateActiveClip((clip) => {
        let start = Math.max(0, parseSec(clip.start));
        let end = Math.max(0, parseSec(clip.end));
        if (which === 'in') {
          const maxStart = hasDur ? Math.max(0, Math.round((maxDur - 0.5) * 10) / 10) : Infinity;
          start = Math.min(rounded, maxStart);
          if (hasDur) {
            end = Math.min(maxDur, end);
          }
          if (end <= start) {
            const nextEnd = Math.round((start + 0.5) * 10) / 10;
            end = hasDur ? Math.min(maxDur, nextEnd) : nextEnd;
          }
        } else {
          if (rounded <= start) {
            const fallbackEnd = Math.round(Math.max(0.5, start + 0.5) * 10) / 10;
            end = hasDur ? Math.min(maxDur, fallbackEnd) : fallbackEnd;
            if (end <= start) {
              start = Math.max(0, Math.round((end - 0.5) * 10) / 10);
            }
          } else {
            end = hasDur ? Math.min(maxDur, rounded) : rounded;
          }
        }
        return { ...clip, start: fmtSec(start), end: fmtSec(end) };
      });
    },
    [trimCurrentSec, trimTotalSec, updateActiveClip],
  );

  const nudgeTrim = useCallback(
    (which: 'in' | 'out', delta: number) => {
      let targetSeek = 0;
      updateActiveClip((clip) => {
        let start = parseSec(clip.start);
        let end = parseSec(clip.end);
        if (which === 'in') {
          const maxStart = Math.max(0, Math.round((end - 0.1) * 10) / 10);
          start = Math.min(maxStart, Math.max(0, Math.round((start + delta) * 10) / 10));
          if (end <= start) {
            end = Math.round((start + 0.1) * 10) / 10;
          }
          targetSeek = start;
        } else {
          const minEnd = Math.round((start + 0.1) * 10) / 10;
          end = Math.max(minEnd, Math.round((end + delta) * 10) / 10);
          targetSeek = end;
        }
        return { ...clip, start: fmtSec(start), end: fmtSec(end) };
      });
      seekTo(targetSeek);
    },
    [seekTo, updateActiveClip],
  );

  const setScrubPoint = useCallback(
    (which: 'in' | 'out', sec: number) => {
      let targetSeek = sec;
      updateActiveClip((clip) => {
        let start = parseSec(clip.start);
        let end = parseSec(clip.end);
        if (which === 'in') {
          start = Math.min(sec, Math.max(0, end - 0.5));
          targetSeek = start;
        } else {
          end = Math.max(sec, start + 0.5);
          targetSeek = end;
        }
        return { ...clip, start: fmtSec(start), end: fmtSec(end) };
      });
      seekTo(targetSeek);
    },
    [seekTo, updateActiveClip],
  );

  const setClipReason = useCallback(
    (text: string) => {
      updateActiveClip((clip) => {
        const count = splitReasonParagraphs(text).length;
        const dur = Math.max(4, parseSec(clip.end) - parseSec(clip.start));
        const nextTimings =
          clip.reason_mode === 'manual'
            ? syncTimingsArray(clip.reason_timings, count, dur)
            : clip.reason_timings;
        return { ...clip, reason: text, reason_timings: nextTimings };
      });
    },
    [updateActiveClip],
  );

  const setClipReasonMode = useCallback(
    (mode: ReasonMode) => {
      updateActiveClip((clip) => {
        const count = splitReasonParagraphs(clip.reason).length;
        const dur = Math.max(4, parseSec(clip.end) - parseSec(clip.start));
        const nextTimings =
          mode === 'manual'
            ? syncTimingsArray(clip.reason_timings, count, dur)
            : clip.reason_timings;
        return { ...clip, reason_mode: mode, reason_timings: nextTimings };
      });
    },
    [updateActiveClip],
  );

  const setClipReasonTiming = useCallback(
    (pIdx: number, val: number) => {
      updateActiveClip((clip) => {
        const count = splitReasonParagraphs(clip.reason).length;
        const dur = Math.max(4, parseSec(clip.end) - parseSec(clip.start));
        const nextTimings = syncTimingsArray(clip.reason_timings, count, dur);
        nextTimings[pIdx] = Number.isFinite(val) ? val : 0;
        return { ...clip, reason_timings: nextTimings };
      });
    },
    [updateActiveClip],
  );

  const stampClipReasonTiming = useCallback(
    (pIdx: number) => {
      updateActiveClip((clip) => {
        const count = splitReasonParagraphs(clip.reason).length;
        const dur = Math.max(4, parseSec(clip.end) - parseSec(clip.start));
        const nextTimings = syncTimingsArray(clip.reason_timings, count, dur);
        const rel = Math.max(0, Math.round((trimCurrentSec - parseSec(clip.start)) * 10) / 10);
        nextTimings[pIdx] = rel;
        return { ...clip, reason_timings: nextTimings };
      });
    },
    [trimCurrentSec, updateActiveClip],
  );

  const applyTrimAndSave = useCallback(async () => {
    return savePlaylist({ silent: false, successMessage: '定剪分段、文案与歌词偏移已保存' });
  }, [savePlaylist]);

  const onVideoLoaded = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    setTrimTotalSec(dur);
    if (v.closest('[hidden]')) return;
    const clipStart = activeClip ? parseSec(activeClip.start) : 0;
    if (dur > 0 && clipStart < dur) {
      v.currentTime = clipStart;
      setTrimCurrentSec(clipStart);
    } else {
      setTrimCurrentSec(v.currentTime || 0);
    }
  }, [activeClip]);

  const onVideoTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.closest('[hidden]')) return;
    setTrimCurrentSec(v.currentTime);
    if (trimLoopPlaying && activeClip) {
      const startSec = parseSec(activeClip.start);
      const endSec = parseSec(activeClip.end);
      if (endSec > startSec && v.currentTime >= endSec) {
        v.currentTime = startSec;
      }
    }
  }, [activeClip, trimLoopPlaying]);

  const onVideoPlayState = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const nudgeLyricsOffset = useCallback(
    (delta: number) => {
      updateSongAt(activeIdxRef.current, (song) => ({
        ...song,
        lyrics_offset: Math.round(((Number(song.lyrics_offset) || 0) + delta) * 10) / 10,
      }));
    },
    [updateSongAt],
  );

  const resetLyricsOffset = useCallback(() => {
    updateSongAt(activeIdxRef.current, (song) => ({
      ...song,
      lyrics_offset: 0,
    }));
  }, [updateSongAt]);

  const alignLyricToCurrent = useCallback(
    (ln: LyricLine) => {
      const video = videoRef.current;
      const cur = video && !video.closest('[hidden]') ? video.currentTime : trimCurrentSec;
      const offset = Math.round((cur - (ln.time || 0)) * 10) / 10;
      updateSongAt(activeIdxRef.current, (song) => ({
        ...song,
        lyrics_offset: offset,
      }));
      notify(`歌词偏移已对齐: ${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`);
    },
    [notify, trimCurrentSec, updateSongAt],
  );

  const refetchLyrics = useCallback(async () => {
    const idx = activeIdxRef.current;
    const targetSong = (playlistRef.current.songs || [])[idx];
    if (idx < 0 || !targetSong) return;
    const songToken = getSongToken(targetSong);
    if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
      const ok = await savePlaylist({ silent: true });
      if (!ok) return;
    }
    const syncedIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
    if (syncedIdx < 0) return;
    const epoch = (lyricsEpochRef.current += 1);
    setLoadingLyrics(true);
    try {
      const data = await refetchLyricsApi(syncedIdx);
      const lines = data.lines || [];
      const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
      if (
        lyricsEpochRef.current === epoch &&
        currentIdx >= 0 &&
        activeIdxRef.current === currentIdx
      ) {
        setLyricsLines(lines);
      }
      notify(`已拉取 ${lines.length} 句歌词`);
    } catch {
      notifyError('歌词拉取失败');
    } finally {
      if (lyricsEpochRef.current === epoch) {
        setLoadingLyrics(false);
      }
    }
  }, [notify, notifyError, savePlaylist]);

  const activeLyricIdx = useMemo(() => {
    if (!lyricsLines.length) return -1;
    const off = Number(activeSong?.lyrics_offset) || 0;
    for (let i = 0; i < lyricsLines.length; i += 1) {
      const start = (lyricsLines[i].time || 0) + off;
      const end =
        i + 1 < lyricsLines.length ? (lyricsLines[i + 1].time || 0) + off : start + 6;
      if (trimCurrentSec >= start && trimCurrentSec < end) {
        return i;
      }
    }
    return -1;
  }, [activeSong?.lyrics_offset, lyricsLines, trimCurrentSec]);

  const updateActiveSongField = useCallback(
    <K extends keyof SongItem>(key: K, value: SongItem[K]) => {
      updateSongAt(activeIdxRef.current, (song) => {
        const next: SongItem = { ...song, [key]: value };
        if ((key === 'start' || key === 'end') && Array.isArray(song.clips) && song.clips.length > 0) {
          const nextClips = song.clips.map((c, i) =>
            i === 0 ? { ...c, [key]: value as string } : c,
          );
          next.clips = nextClips;
        }
        return next;
      });
    },
    [updateSongAt],
  );

  const setClipVisualEffect = useCallback((value: string) => {
    if (activeClips.length < 2) {
      updateActiveSongField('visual_effect', value);
      return;
    }
    updateActiveClip(clip => ({ ...clip, visual_effect: value === 'inherit' ? undefined : value }));
  }, [activeClips.length, updateActiveClip, updateActiveSongField]);

  const toggleVisualModifier = useCallback(async (modId: string) => {
    const toggle = (mods: string[] = []) => mods.includes(modId) ? mods.filter(mod => mod !== modId) : [...mods, modId];
    const next = activeClips.length > 1
      ? updateActiveClip(clip => ({ ...clip, visual_modifiers: toggle(clip.visual_modifiers ?? activeSong?.visual_modifiers) }))
      : updateSongAt(activeIdxRef.current, song => ({ ...song, visual_modifiers: toggle(song.visual_modifiers) }));
    if (next) await savePlaylist({ silent: true, overridePlaylist: next });
  }, [activeClips.length, activeSong?.visual_modifiers, savePlaylist, updateActiveClip, updateSongAt]);

  const saveMeta = useCallback(async () => {
    return savePlaylist({ silent: false });
  }, [savePlaylist]);

  const updateIntroField = useCallback(
    (patch: Partial<PlaylistConfig['intro']>, opts?: { recalc?: boolean }) => {
      const prevIntro = playlistRef.current.intro;
      const nextIntro = { ...prevIntro, ...patch };
      if (opts?.recalc && nextIntro.auto_duration !== false) {
        nextIntro.duration = computeAutoIntroDuration(nextIntro.text);
      }
      commitPlaylist({ ...playlistRef.current, intro: nextIntro }, true);
    },
    [commitPlaylist],
  );

  const setIntroBgMode = useCallback(
    (mode: IntroBgMode) => {
      updateIntroField({ bg_mode: mode });
    },
    [updateIntroField],
  );

  const updateGlobalTransition = useCallback(
    (patch: Partial<PlaylistConfig['transition']>) => {
      commitPlaylist(
        {
          ...playlistRef.current,
          transition: { ...playlistRef.current.transition, ...patch },
        },
        true,
      );
    },
    [commitPlaylist],
  );

  const saveIntroConfig = useCallback(async () => {
    return savePlaylist({ silent: false, successMessage: '开场白与全局转场配置已保存' });
  }, [savePlaylist]);

  const addEmptySong = useCallback(async () => {
    mediaSyncEpochRef.current += 1;
    const nextSongs = [...(playlistRef.current.songs || []), createEmptySong()];
    const nextPl = { ...playlistRef.current, songs: nextSongs };
    commitPlaylist(nextPl, true);
    setRackFilter('all');
    const newIdx = nextSongs.length - 1;
    setActiveView('song');
    activeViewRef.current = 'song';
    setActiveIdx(newIdx);
    activeIdxRef.current = newIdx;
    setActiveClipIdx(0);
    setActiveTab('stage');
    activeTabRef.current = 'stage';
    setIsPlaying(false);
    setTrimCurrentSec(0);
    setTrimTotalSec(0);
    setSourceGalleryOpen(false);
    setUndownloadedPickUrl('');
    lyricsEpochRef.current += 1;
    setLyricsLines([]);
    setLoadingLyrics(false);
    pendingLyricsReloadRef.current = false;
    const ok = await savePlaylist({ silent: true, overridePlaylist: nextPl });
    if (ok) {
      notify('已新增曲目');
    }
  }, [commitPlaylist, notify, savePlaylist]);

  const deleteSong = useCallback(
    async (idx: number) => {
      const songs = playlistRef.current.songs || [];
      const target = songs[idx];
      if (!target || !window.confirm(`确定删除「${target.title}」？`)) return;
      const deletedToken = songTokenMap.get(target);
      if (deletedToken) {
        autoSearchedTokensRef.current.delete(deletedToken);
        searchEpochByTokenRef.current.delete(deletedToken);
      }
      mediaSyncEpochRef.current += 1;
      setMediaSyncPending(true);
      const prevActive = activeIdxRef.current;
      const nextSongs = songs.filter((_, i) => i !== idx);
      const nextPl = { ...playlistRef.current, songs: nextSongs };
      commitPlaylist(nextPl, true);
      candidatesMapRef.current = remapIndexRecordOnDelete(candidatesMapRef.current, idx);
      platformMapRef.current = remapIndexRecordOnDelete(platformMapRef.current, idx);
      customQueriesRef.current = remapIndexRecordOnDelete(customQueriesRef.current, idx);
      loadingCandidatesMapRef.current = remapIndexRecordOnDelete(
        loadingCandidatesMapRef.current,
        idx,
      );
      setCandidatesMap((prev) => remapIndexRecordOnDelete(prev, idx));
      setPlatformMap((prev) => remapIndexRecordOnDelete(prev, idx));
      setCustomQueries((prev) => remapIndexRecordOnDelete(prev, idx));
      setLoadingCandidatesMap((prev) => remapIndexRecordOnDelete(prev, idx));
      let nextIdx = -1;
      if (nextSongs.length > 0) {
        if (idx < prevActive) nextIdx = prevActive - 1;
        else if (prevActive >= nextSongs.length) nextIdx = nextSongs.length - 1;
        else nextIdx = prevActive;
      }
      setActiveIdx(nextIdx);
      activeIdxRef.current = nextIdx;
      setActiveClipIdx(0);
      setIsPlaying(false);
      setTrimCurrentSec(0);
      setTrimTotalSec(0);
      setSourceGalleryOpen(false);
      setUndownloadedPickUrl('');
      if (idx <= prevActive || nextIdx < 0) {
        lyricsEpochRef.current += 1;
        setLyricsLines([]);
        setLoadingLyrics(false);
        pendingLyricsReloadRef.current = nextIdx >= 0;
      }
      const ok = await savePlaylist({ silent: true, overridePlaylist: nextPl });
      if (ok) {
        if (
          nextIdx >= 0 &&
          pendingLyricsReloadRef.current &&
          mediaSyncEpochRef.current === committedMediaSyncEpochRef.current
        ) {
          pendingLyricsReloadRef.current = false;
          loadLyrics(nextIdx);
        }
        notify('已删除曲目');
      }
    },
    [commitPlaylist, loadLyrics, notify, savePlaylist],
  );

  const reorderSongs = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
      const nextSongs = [...(playlistRef.current.songs || [])];
      if (fromIdx < 0 || fromIdx >= nextSongs.length || toIdx < 0 || toIdx >= nextSongs.length) {
        return;
      }
      mediaSyncEpochRef.current += 1;
      setMediaSyncPending(true);
      setIsPlaying(false);
      const [moved] = nextSongs.splice(fromIdx, 1);
      nextSongs.splice(toIdx, 0, moved);
      let nextActive = activeIdxRef.current;
      if (nextActive === fromIdx) nextActive = toIdx;
      else if (fromIdx < nextActive && toIdx >= nextActive) nextActive -= 1;
      else if (fromIdx > nextActive && toIdx <= nextActive) nextActive += 1;
      const nextPl = { ...playlistRef.current, songs: nextSongs };
      commitPlaylist(nextPl, true);
      candidatesMapRef.current = remapIndexRecordOnReorder(
        candidatesMapRef.current,
        fromIdx,
        toIdx,
      );
      platformMapRef.current = remapIndexRecordOnReorder(platformMapRef.current, fromIdx, toIdx);
      customQueriesRef.current = remapIndexRecordOnReorder(customQueriesRef.current, fromIdx, toIdx);
      loadingCandidatesMapRef.current = remapIndexRecordOnReorder(
        loadingCandidatesMapRef.current,
        fromIdx,
        toIdx,
      );
      setCandidatesMap((prev) => remapIndexRecordOnReorder(prev, fromIdx, toIdx));
      setPlatformMap((prev) => remapIndexRecordOnReorder(prev, fromIdx, toIdx));
      setCustomQueries((prev) => remapIndexRecordOnReorder(prev, fromIdx, toIdx));
      setLoadingCandidatesMap((prev) => remapIndexRecordOnReorder(prev, fromIdx, toIdx));
      setActiveIdx(nextActive);
      activeIdxRef.current = nextActive;
      const ok = await savePlaylist({ silent: true, overridePlaylist: nextPl });
      if (ok) notify('曲目顺序已更新');
    },
    [commitPlaylist, notify, savePlaylist],
  );

  const activePlatform: CandidatePlatform = platformMap[activeIdx] || 'all';
  const activeCandidates: CandidateItem[] = candidatesMap[activeIdx] || [];
  const customQuery =
    customQueries[activeIdx] ??
    (activeSong ? `${activeSong.title} ${activeSong.artist}`.trim() : '');
  const loadingCandidates = Boolean(loadingCandidatesMap[activeIdx]);

  const setCustomQuery = useCallback((q: string) => {
    const idx = activeIdxRef.current;
    if (customQueriesRef.current[idx] === q) return;
    customQueriesRef.current = { ...customQueriesRef.current, [idx]: q };
    setCustomQueries((prev) => (prev[idx] === q ? prev : { ...prev, [idx]: q }));
  }, []);

  const searchCandidates = useCallback(
    async (idx = activeIdxRef.current) => {
      const song = (playlistRef.current.songs || [])[idx];
      if (!song) return;
      const songToken = getSongToken(song);
      autoSearchedTokensRef.current.add(songToken);
      const epoch = (searchEpochByTokenRef.current.get(songToken) || 0) + 1;
      searchEpochByTokenRef.current.set(songToken, epoch);
      setSourceGalleryOpen(true);
      const platform = platformMapRef.current[idx] || 'all';
      const query = (customQueriesRef.current[idx] || `${song.title} ${song.artist}`).trim();
      if (customQueriesRef.current[idx] !== query) {
        customQueriesRef.current = { ...customQueriesRef.current, [idx]: query };
        setCustomQueries((prev) => (prev[idx] === query ? prev : { ...prev, [idx]: query }));
      }
      loadingCandidatesMapRef.current = { ...loadingCandidatesMapRef.current, [idx]: true };
      setLoadingCandidatesMap((prev) => (prev[idx] === true ? prev : { ...prev, [idx]: true }));
      try {
        const data = await searchCandidatesApi(query, platform, 12);
        const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
        if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
          const list = data.candidates || [];
          candidatesMapRef.current = { ...candidatesMapRef.current, [currentIdx]: list };
          setCandidatesMap((prev) => ({ ...prev, [currentIdx]: list }));
        }
      } catch {
        const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
        if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
          notifyError('候选检索失败');
        }
      } finally {
        const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
        if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
          loadingCandidatesMapRef.current = {
            ...loadingCandidatesMapRef.current,
            [currentIdx]: false,
          };
          setLoadingCandidatesMap((prev) => ({ ...prev, [currentIdx]: false }));
        }
      }
    },
    [notifyError],
  );

  const openCandidateGallery = useCallback(() => {
    setSourceGalleryOpen(true);
    const idx = activeIdxRef.current;
    if (
      idx >= 0 &&
      candidatesMapRef.current[idx] === undefined &&
      !loadingCandidatesMapRef.current[idx]
    ) {
      searchCandidates(idx);
    }
  }, [searchCandidates]);

  const setPlatform = useCallback(
    (p: CandidatePlatform) => {
      const idx = activeIdxRef.current;
      const song = (playlistRef.current.songs || [])[idx];
      if (!song) return;
      const songToken = getSongToken(song);
      autoSearchedTokensRef.current.add(songToken);
      const epoch = (searchEpochByTokenRef.current.get(songToken) || 0) + 1;
      searchEpochByTokenRef.current.set(songToken, epoch);
      platformMapRef.current = { ...platformMapRef.current, [idx]: p };
      setPlatformMap((prev) => ({ ...prev, [idx]: p }));
      setSourceGalleryOpen(true);
      const query = (customQueriesRef.current[idx] || `${song.title} ${song.artist}`).trim();
      if (customQueriesRef.current[idx] !== query) {
        customQueriesRef.current = { ...customQueriesRef.current, [idx]: query };
        setCustomQueries((prev) => (prev[idx] === query ? prev : { ...prev, [idx]: query }));
      }
      loadingCandidatesMapRef.current = { ...loadingCandidatesMapRef.current, [idx]: true };
      setLoadingCandidatesMap((prev) => (prev[idx] === true ? prev : { ...prev, [idx]: true }));
      searchCandidatesApi(query, p, 12)
        .then((data) => {
          const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
          if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
            const list = data.candidates || [];
            candidatesMapRef.current = { ...candidatesMapRef.current, [currentIdx]: list };
            setCandidatesMap((prev) => ({ ...prev, [currentIdx]: list }));
          }
        })
        .catch(() => {
          const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
          if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
            notifyError('候选检索失败');
          }
        })
        .finally(() => {
          const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
          if (currentIdx >= 0 && searchEpochByTokenRef.current.get(songToken) === epoch) {
            loadingCandidatesMapRef.current = {
              ...loadingCandidatesMapRef.current,
              [currentIdx]: false,
            };
            setLoadingCandidatesMap((prev) => ({ ...prev, [currentIdx]: false }));
          }
        });
    },
    [notifyError],
  );

  const lockedCandidate = useMemo(() => {
    const url = activeSong?.youtube_url;
    if (!url) return null;
    return activeCandidates.find((c) => c.url === url) || null;
  }, [activeCandidates, activeSong?.youtube_url]);

  const showCandidateGallery = useMemo(() => {
    if (!activeSong || activeSourceMode !== 'video_url') return false;
    if (sourceGalleryOpen) return true;
    return !activeSong.youtube_url && !activeSong.has_file;
  }, [activeSong, activeSourceMode, sourceGalleryOpen]);

  const sourceCanPlayVideo = useMemo(() => {
    if (!activeSong || !activeMediaUrl) return false;
    if (
      activeSourceMode === 'video_url' &&
      undownloadedPickUrl &&
      undownloadedPickUrl === activeSong.youtube_url
    ) {
      return false;
    }
    return true;
  }, [activeMediaUrl, activeSong, activeSourceMode, undownloadedPickUrl]);

  const setSourceMode = useCallback(
    async (mode: MediaSourceMode) => {
      if (mode !== 'video_url') setSourceGalleryOpen(false);
      const next = updateSongAt(activeIdxRef.current, (song) => ({
        ...song,
        media_source: mode,
      }));
      if (next) {
        await savePlaylist({ silent: true, overridePlaylist: next });
      }
    },
    [savePlaylist, updateSongAt],
  );

  const downloadSingle = useCallback(
    async (idx = activeIdxRef.current) => {
      if (idx < 0) return;
      const ok = await savePlaylist({ silent: true });
      if (!ok) return;
      try {
        const data = await downloadSingleApi(idx, true, '1080');
        notify(data.message || '已加入下载队列');
      } catch (err) {
        notifyError(err instanceof Error ? err.message : '启动失败');
      }
    },
    [notify, notifyError, savePlaylist],
  );

  const downloadAll = useCallback(async () => {
    setShowTools(false);
    const ok = await savePlaylist({ silent: true });
    if (!ok) return;
    try {
      await downloadAllApi(false, '1080');
      notify('已启动全量分流下载');
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '已有任务在进行中');
    }
  }, [notify, notifyError, savePlaylist]);

  const adoptCandidate = useCallback(
    async (cand: CandidateItem, autoDownload = false) => {
      const idx = activeIdxRef.current;
      const prevSong = playlistRef.current.songs[idx];
      if (!prevSong) return;
      const changed = prevSong.youtube_url !== cand.url;
      if (changed) setUndownloadedPickUrl(cand.url);
      setSourceGalleryOpen(false);
      const next = updateSongAt(idx, (song) => ({
        ...song,
        youtube_url: cand.url,
        media_source: 'video_url',
      }));
      if (!next) return;
      const ok = await savePlaylist({ silent: true, overridePlaylist: next });
      if (!ok) return;
      if (autoDownload) {
        await downloadSingle(idx);
      } else {
        notify('已锁定候选视频');
      }
    },
    [downloadSingle, notify, savePlaylist, updateSongAt],
  );

  const uploadLocalFile = useCallback(
    async (file: File) => {
      const idx = activeIdxRef.current;
      const targetSong = (playlistRef.current.songs || [])[idx];
      if (!file || idx < 0 || !targetSong) return;
      const songToken = getSongToken(targetSong);
      setUploadingLocal(true);
      setIsSaving(true);
      if (dirtyRef.current) {
        setSaveState('dirty');
      }
      const runUpload = async () => {
        try {
          while (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
            const synced = await executeSave({ silent: true });
            if (!synced) return;
            setIsSaving(true);
          }
          const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
          if (currentIdx < 0) return;
          const res = await uploadMediaApi(currentIdx, file);
          setMediaVersion(Date.now());
          if (!dirtyRef.current) {
            await fetchPlaylist(true);
            notify(`已导入本地视频: ${file.name}`);
          } else {
            const postUploadIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
            if (postUploadIdx < 0) return;
            const next = updateSongAt(
              postUploadIdx,
              (song) => ({
                ...song,
                file_path: res.file_path,
                normalized_path: '',
                media_source: 'local',
                has_file: true,
                has_normalized: false,
              }),
              true,
            );
            if (next) {
              const ok = await executeSave({ silent: true, overridePlaylist: next });
              if (ok) {
                notify(`已导入本地视频: ${file.name}`);
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : '本地视频导入失败';
          if (dirtyRef.current) {
            setSaveState('error');
            setSaveError(msg);
            notifyError(msg, { persistent: true, showRetry: true });
          } else {
            setSaveState('saved');
            notifyError(msg);
          }
        } finally {
          setUploadingLocal(false);
          setIsSaving(false);
        }
      };
      const queued = saveChainRef.current.then(runUpload, runUpload);
      saveChainRef.current = queued;
      await queued;
    },
    [executeSave, fetchPlaylist, notify, notifyError, updateSongAt],
  );

  const runPreprocess = useCallback(async () => {
    setShowTools(false);
    if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
      const ok = await savePlaylist({ silent: true });
      if (!ok) return;
    }
    try {
      await runPreprocessApi(false);
      notify('已启动素材预处理');
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '已有任务在进行中');
    }
  }, [notify, notifyError, savePlaylist]);

  const analyzeAllVisuals = useCallback(async () => {
    setShowTools(false);
    if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
      const ok = await savePlaylist({ silent: true });
      if (!ok) return;
    }
    try {
      await analyzeVisualsApi();
      notify('已启动视觉分析与双语歌词');
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '已有任务在进行中');
    }
  }, [notify, notifyError, savePlaylist]);

  const pollStatus = useCallback(async () => {
    try {
      const data = await fetchStatusApi();
      setStatus(data);
      const isBusy = Boolean(data.is_downloading || data.is_rendering);
      if (wasBusyRef.current && !isBusy) {
        setMediaVersion(Date.now());
        setIsPlaying(false);
        setUndownloadedPickUrl('');
        try {
          const serverPl = await fetchPlaylistApi();
          if (!dirtyRef.current) {
            const prevIdx = activeIdxRef.current;
            const prevSongs = playlistRef.current.songs || [];
            const nextSongs = serverPl.songs || [];
            const prevSong = prevIdx >= 0 ? prevSongs[prevIdx] : null;
            const indexMap = transferMatchedTokens(prevSongs, nextSongs);
            remapCandidateCaches(indexMap);
            committedMediaSyncEpochRef.current = mediaSyncEpochRef.current;
            setMediaSyncPending(false);
            pendingLyricsReloadRef.current = false;
            playlistRef.current = serverPl;
            setPlaylist(serverPl);
            setDirty(false);
            setSaveState('saved');
            const len = nextSongs.length;
            let nextIdx = -1;
            if (len > 0) {
              const mapped = indexMap.get(prevIdx);
              if (mapped !== undefined && mapped >= 0 && mapped < len) {
                nextIdx = mapped;
              } else if (prevIdx >= 0) {
                nextIdx = Math.min(prevIdx, len - 1);
              } else {
                nextIdx = 0;
              }
            }
            const nextSong = nextIdx >= 0 ? nextSongs[nextIdx] : null;
            const sameSongIdentity =
              Boolean(prevSong && nextSong) &&
              prevIdx === nextIdx &&
              prevSong?.title === nextSong?.title &&
              prevSong?.artist === nextSong?.artist &&
              (prevSong?.netease_id || '') === (nextSong?.netease_id || '');
            activeIdxRef.current = nextIdx;
            setActiveIdx(nextIdx);
            if (!sameSongIdentity) {
              setActiveClipIdx(0);
              setTrimCurrentSec(0);
              setTrimTotalSec(0);
              setSourceGalleryOpen(false);
            }
            if (nextIdx >= 0) {
              loadLyrics(nextIdx);
            } else {
              lyricsEpochRef.current += 1;
              setLyricsLines([]);
              setLoadingLyrics(false);
            }
          } else {
            const merged = mergeRuntimeFields(playlistRef.current, serverPl);
            playlistRef.current = merged;
            setPlaylist(merged);
          }
        } catch {
        }
      }
      wasBusyRef.current = isBusy;
    } catch {
    }
  }, [loadLyrics, remapCandidateCaches]);

  const openRemotionStudio = useCallback(async () => {
    dismissToast();
    const ok = await savePlaylist({ silent: true });
    if (!ok) return;
    setOpeningStudio(true);
    try {
      const data = await openRemotionStudioApi();
      if (!data.url) throw new Error('Remotion Studio 未返回访问地址');
      notify('Remotion Studio 已就绪');
      return data.url;
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '启动 Studio 失败');
    } finally {
      setOpeningStudio(false);
    }
  }, [dismissToast, notify, notifyError, savePlaylist]);

  const renderRemotionVideo = useCallback(async () => {
    dismissToast();
    const ok = await savePlaylist({ silent: true });
    if (!ok) return;
    try {
      await renderRemotionApi(playlistRef.current.output_sequence_name || null);
      setShowLogs(true);
      notify('已启动 Remotion 1080p60 渲染');
      pollStatus();
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '已有任务在进行中');
    }
  }, [dismissToast, notify, notifyError, pollStatus, savePlaylist]);

  const cancelRemotionRender = useCallback(async () => {
    dismissToast();
    try {
      const data = await cancelRemotionApi();
      notify(data.message || '已发送停止信号');
      pollStatus();
    } catch (err) {
      notifyError(err instanceof Error ? err.message : '停止失败');
    }
  }, [dismissToast, notify, notifyError, pollStatus]);

  const clearLogs = useCallback(async () => {
    try {
      await clearLogsApi();
      setStatus((prev) => ({ ...prev, logs: [] }));
    } catch {
    }
  }, []);

  const importNetease = useCallback(
    async (url: string, limit: number, append: boolean): Promise<boolean> => {
      const trimmed = url.trim();
      if (!trimmed) return false;
      setImportingNetease(true);
      try {
        const data = await importNeteaseApi(trimmed, limit || 10, append);
        setShowNeteaseModal(false);
        await fetchPlaylist(false);
        if ((playlistRef.current.songs || []).length > 0) {
          setActiveView('song');
          activeViewRef.current = 'song';
        }
        notify(`已导入 ${data.count} 首歌曲`);
        return true;
      } catch (err) {
        notifyError(err instanceof Error ? err.message : '导入失败');
        return false;
      } finally {
        setImportingNetease(false);
      }
    },
    [fetchPlaylist, notify, notifyError],
  );

  const stopBiliPoll = useCallback(() => {
    biliQrEpochRef.current += 1;
    if (biliPollTimerRef.current !== null) {
      window.clearInterval(biliPollTimerRef.current);
      biliPollTimerRef.current = null;
    }
  }, []);

  const fetchBiliStatus = useCallback(async () => {
    try {
      const data = await fetchBiliStatusApi();
      setBiliUser(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const generateBiliQr = useCallback(async () => {
    stopBiliPoll();
    const epoch = biliQrEpochRef.current;
    if (!biliModalOpenRef.current) return;
    setBiliQrLoading(true);
    setBiliQrUrl('');
    setBiliQrMessage('正在生成二维码...');
    try {
      const data = await generateBiliQrApi();
      if (biliQrEpochRef.current !== epoch || !biliModalOpenRef.current) return;
      setBiliQrUrl(data.url);
      setBiliQrMessage('请使用手机 B 站 App 扫码');
      const qrKey = data.qrcode_key;
      biliPollTimerRef.current = window.setInterval(async () => {
        if (biliQrEpochRef.current !== epoch || !biliModalOpenRef.current) {
          stopBiliPoll();
          return;
        }
        try {
          const pData = await pollBiliQrApi(qrKey);
          if (biliQrEpochRef.current !== epoch || !biliModalOpenRef.current) return;
          if (pData.status === 'scanned') {
            setBiliQrMessage('已扫码，请在手机端确认');
          } else if (pData.status === 'success') {
            stopBiliPoll();
            setBiliQrMessage('登录成功');
            await fetchBiliStatus();
            notify('B站登录成功');
          } else if (pData.status === 'expired') {
            stopBiliPoll();
            setBiliQrMessage('二维码已过期，请刷新');
          }
        } catch {
        }
      }, 2000);
    } catch (err) {
      if (biliQrEpochRef.current !== epoch || !biliModalOpenRef.current) return;
      setBiliQrMessage(err instanceof Error ? err.message : '生成失败');
    } finally {
      if (biliQrEpochRef.current === epoch) {
        setBiliQrLoading(false);
      }
    }
  }, [fetchBiliStatus, notify, stopBiliPoll]);

  const openBiliModal = useCallback(async () => {
    setShowTools(false);
    biliModalOpenRef.current = true;
    setShowBiliModal(true);
    const st = await fetchBiliStatus();
    if (!biliModalOpenRef.current) return;
    if (!st?.logged_in) {
      generateBiliQr();
    }
  }, [fetchBiliStatus, generateBiliQr]);

  const closeBiliModal = useCallback(() => {
    biliModalOpenRef.current = false;
    stopBiliPoll();
    setBiliQrLoading(false);
    setShowBiliModal(false);
  }, [stopBiliPoll]);

  const logoutBili = useCallback(async () => {
    try {
      await logoutBiliApi();
      await fetchBiliStatus();
      generateBiliQr();
      notify('已退出 B 站登录');
    } catch {
    }
  }, [fetchBiliStatus, generateBiliQr, notify]);

  const fetchNeteaseAudioCfg = useCallback(async () => {
    try {
      const data = await fetchNeteaseAudioConfigApi();
      setNeteaseAudioCfg(data);
    } catch {
    }
  }, []);

  const updateShowNeteaseAudioModal = useCallback((v: boolean) => {
    if (!v) {
      neteaseAudioEpochRef.current += 1;
    }
    setShowNeteaseAudioModal(v);
  }, []);

  const openNeteaseAudioModal = useCallback(async () => {
    setShowTools(false);
    const epoch = (neteaseAudioEpochRef.current += 1);
    await fetchNeteaseAudioCfg();
    if (neteaseAudioEpochRef.current !== epoch) return;
    setShowNeteaseAudioModal(true);
  }, [fetchNeteaseAudioCfg]);

  const saveNeteaseAudioCfg = useCallback(
    async (payload: {
      api_url?: string;
      api_key?: string;
      default_quality?: string;
      script_text?: string;
    }): Promise<boolean> => {
      setSavingNeteaseAudioCfg(true);
      try {
        const data = await saveNeteaseAudioConfigApi(payload);
        setNeteaseAudioCfg(data);
        notify('网易云音源配置已保存');
        return true;
      } catch (err) {
        notifyError(err instanceof Error ? err.message : '保存失败');
        return false;
      } finally {
        setSavingNeteaseAudioCfg(false);
      }
    },
    [notify, notifyError],
  );

  const downloadNeteaseAudioSingle = useCallback(
    async (idx: number, mode: 'video' | 'audio', quality: string) => {
      const targetSong = (playlistRef.current.songs || [])[idx];
      if (idx < 0 || !targetSong) return;
      const songToken = getSongToken(targetSong);
      if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
        const ok = await savePlaylist({ silent: true });
        if (!ok) return;
      }
      const currentIdx = findSongIndexByToken(playlistRef.current.songs || [], songToken);
      if (currentIdx < 0) return;
      try {
        const data = await downloadNeteaseAudioSingleApi(currentIdx, mode, quality, true);
        notify(data.message || '已加入队列');
      } catch (err) {
        notifyError(err instanceof Error ? err.message : '启动失败');
      }
    },
    [notify, notifyError, savePlaylist],
  );

  const downloadNeteaseAudioBatch = useCallback(
    async (mode: 'video' | 'audio', quality: string, missingOnly: boolean) => {
      if (mediaSyncEpochRef.current > committedMediaSyncEpochRef.current) {
        const ok = await savePlaylist({ silent: true });
        if (!ok) return;
      }
      try {
        await downloadNeteaseAudioBatchApi(mode, quality, !missingOnly, missingOnly);
        setShowNeteaseAudioModal(false);
        notify('已启动网易云批量任务');
      } catch (err) {
        notifyError(err instanceof Error ? err.message : '已有任务在进行中');
      }
    },
    [notify, notifyError, savePlaylist],
  );

  useEffect(() => {
    if (
      activeView === 'song' &&
      activeTab === 'source' &&
      activeIdx >= 0 &&
      activeSourceMode === 'video_url' &&
      activeSong &&
      !activeSong.youtube_url &&
      !activeSong.has_file
    ) {
      const songToken = getSongToken(activeSong);
      if (
        !autoSearchedTokensRef.current.has(songToken) &&
        candidatesMapRef.current[activeIdx] === undefined &&
        !loadingCandidatesMapRef.current[activeIdx]
      ) {
        autoSearchedTokensRef.current.add(songToken);
        searchCandidates(activeIdx);
      }
    }
  }, [activeIdx, activeSong, activeSourceMode, activeTab, activeView, searchCandidates]);

  useEffect(() => {
    fetchPlaylist(false).catch(() => {});
    fetchBiliStatus();
    fetchNeteaseAudioCfg();
    pollStatus();
    const timer = window.setInterval(pollStatus, 2000);
    return () => {
      window.clearInterval(timer);
      biliModalOpenRef.current = false;
      neteaseAudioEpochRef.current += 1;
      stopBiliPoll();
      clearToastTimer();
    };
  }, [clearToastTimer, fetchBiliStatus, fetchNeteaseAudioCfg, fetchPlaylist, pollStatus, stopBiliPoll]);

  useEffect(() => {
    const showKeyPress = (id: string) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const button = document.getElementById(id);
      if (!button || button.getAnimations().length) return;
      button.animate(
        [{ transform: 'translateY(2px)' }, { transform: 'translateY(0)' }],
        { duration: 120, easing: 'ease-out' },
      );
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        neteaseAudioEpochRef.current += 1;
        if (showBiliModal) closeBiliModal();
        setShowNeteaseModal(false);
        setShowNeteaseAudioModal(false);
        setShowTools(false);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (activeViewRef.current === 'song' && activeTabRef.current === 'trim') {
          applyTrimAndSave();
        } else {
          savePlaylist({ silent: false });
        }
        return;
      }

      if (showNeteaseModal || showBiliModal || showNeteaseAudioModal) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepTrack(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepTrack(-1);
        return;
      }
      if (activeViewRef.current === 'song' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '1') {
          setActiveTab('trim');
          return;
        }
        if (e.key === '2') {
          setActiveTab('source');
          return;
        }
        if (e.key === '3') {
          setActiveTab('stage');
          return;
        }
      }

      if (activeViewRef.current !== 'song' || activeTabRef.current !== 'trim') return;
      if (!videoRef.current) return;

      if (e.code === 'Space') {
        if (videoRef.current.closest('[hidden]')) return;
        e.preventDefault();
        togglePlay();
        showKeyPress('transport-play-key');
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        setTrimPoint('in');
        showKeyPress('trim-set-in-key');
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        setTrimPoint('out');
        showKeyPress('trim-set-out-key');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekBy(-(e.shiftKey ? 2 : 0.5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekBy(e.shiftKey ? 2 : 0.5);
      }
    };

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (showTools && target && !target.closest('.tools-wrap')) {
        setShowTools(false);
      }
    };

    window.addEventListener('keydown', onKeydown);
    window.addEventListener('click', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('click', onDocClick);
    };
  }, [
    applyTrimAndSave,
    closeBiliModal,
    savePlaylist,
    seekBy,
    setTrimPoint,
    showBiliModal,
    showNeteaseAudioModal,
    showNeteaseModal,
    showTools,
    stepTrack,
    togglePlay,
  ]);

  const value: StudioStoreContextValue = {
    hydrated,
    theme,
    toggleTheme,
    playlist,
    status,
    dirty,
    saveState,
    saveError,
    isSaving,
    openingStudio,
    rackFilter,
    setRackFilter,
    activeView,
    activeIdx,
    activeTab,
    setActiveTab,
    activeClipIdx: clampedClipIdx,
    mediaVersion,
    filteredSongs,
    activeSong,
    activeClips,
    activeClip,
    activeMediaUrl,
    activeSourceMode,
    totalDurationStr,
    readyCount,
    missingCount,
    introPageCount,
    trimCurrentSec,
    trimTotalSec,
    isPlaying,
    trimLoopPlaying,
    setTrimLoopPlaying,
    lyricsLines,
    loadingLyrics,
    activeLyricIdx,
    showLogs,
    setShowLogs,
    showTools,
    setShowTools,
    toast,
    dismissToast,
    notify,
    notifyError,
    videoRef,
    selectSong,
    selectIntro,
    stepTrack,
    setSequenceName,
    savePlaylist,
    retrySave,
    addEmptySong,
    deleteSong,
    reorderSongs,
    switchTrimClip,
    addTrimClip,
    removeTrimClip,
    setTrimPoint,
    nudgeTrim,
    setScrubPoint,
    setClipReason,
    setClipReasonMode,
    setClipReasonTiming,
    stampClipReasonTiming,
    applyTrimAndSave,
    onVideoLoaded,
    onVideoTimeUpdate,
    onFxTimeUpdate: setTrimCurrentSec,
    onVideoPlayState,
    togglePlay,
    seekTo,
    seekBy,
    nudgeLyricsOffset,
    resetLyricsOffset,
    alignLyricToCurrent,
    refetchLyrics,
    updateActiveSongField,
    setClipVisualEffect,
    toggleVisualModifier,
    saveMeta,
    updateIntroField,
    setIntroBgMode,
    updateGlobalTransition,
    saveIntroConfig,
    activePlatform,
    activeCandidates,
    customQuery,
    setCustomQuery,
    loadingCandidates,
    sourceGalleryOpen,
    setSourceGalleryOpen,
    openCandidateGallery,
    setPlatform,
    searchCandidates,
    lockedCandidate,
    showCandidateGallery,
    sourceCanPlayVideo,
    setSourceMode,
    adoptCandidate,
    uploadingLocal,
    uploadLocalFile,
    downloadSingle,
    downloadAll,
    runPreprocess,
    analyzeAllVisuals,
    openRemotionStudio,
    renderRemotionVideo,
    cancelRemotionRender,
    clearLogs,
    showNeteaseModal,
    setShowNeteaseModal,
    importingNetease,
    importNetease,
    biliUser,
    showBiliModal,
    biliQrLoading,
    biliQrUrl,
    biliQrMessage,
    openBiliModal,
    closeBiliModal,
    generateBiliQr,
    logoutBili,
    showNeteaseAudioModal,
    setShowNeteaseAudioModal: updateShowNeteaseAudioModal,
    neteaseAudioCfg,
    savingNeteaseAudioCfg,
    openNeteaseAudioModal,
    saveNeteaseAudioCfg,
    downloadNeteaseAudioSingle,
    downloadNeteaseAudioBatch,
  };

  return (
    <StudioStoreContext.Provider value={value}>
      {children}
    </StudioStoreContext.Provider>
  );
}

export function useStudioStore(): StudioStoreContextValue {
  const ctx = useContext(StudioStoreContext);
  if (!ctx) {
    throw new Error('useStudioStore must be used inside StudioProvider');
  }
  return ctx;
}
