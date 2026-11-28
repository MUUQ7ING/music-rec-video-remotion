import { isPublicDemo } from '../api/publicDemo';
import { ReasonPanel } from './ReasonPanel';
import { ColumnDivider } from './ColumnDivider';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { SequenceMix, type MixReading } from './SequenceMix';
import { AudioMeter } from './ui/Hardware';
import { fmtSec, parseSec } from '../utils/time';
import { expandPlaylistSegments } from '../../../remotion/src/utils/segments';
import type { PlaylistConfig } from '../../../remotion/src/types';
import { useStudioStore } from '../state/useStudioStore';
import { IntroGlobalView } from '../views/IntroGlobalView';
import { StageFxView } from '../views/StageFxView';
import { TactileButton } from './ui/TactileButton';
import { Bay } from './ui/Bay';

export default function TrackCompositionPreview({ full = false, transportRef, onPlaybackChange, onSourceTimeChange }: {
  full?: boolean;
  transportRef?: RefObject<PlayerRef | null>;
  onPlaybackChange?: (playing: boolean) => void;
  onSourceTimeChange?: (seconds: number) => void;
}) {
  const { playlist, activeSong, activeClip, activeClipIdx, activeClips, activeIdx, activeView, switchTrimClip, trimLoopPlaying, setClipReasonTiming } = useStudioStore();
  const localPlayer = useRef<PlayerRef>(null);
  const player = transportRef ?? localPlayer;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mix, setMix] = useState<MixReading | null>(null);
  const inputProps = useMemo(() => {
    const composition: PlaylistConfig = {
      ...playlist,
      intro: full ? playlist.intro : { ...playlist.intro, enabled: false },
      songs: (full ? playlist.songs : activeSong ? [{
        ...activeSong,
        clips: activeClip ? [activeClip] : activeSong.clips,
      }] : []).map(song => ({
        ...song,
        normalized_path: song.has_normalized ? song.normalized_path : '',
        file_path: song.has_file ? song.file_path : '',
        audio_path: song.has_audio ? song.audio_path : '',
        cover_path: song.has_cover ? song.cover_path : '',
        lyrics_path: song.has_lyrics ? song.lyrics_path : '',
      })),
    };
    return { playlist: composition, mediaBaseUrl: '/api/composition-media' };
  }, [playlist, activeSong, activeClip, full]);
  const fps = playlist.fps || 60;
  const segments = useMemo(() => {
    let frame = 0;
    return expandPlaylistSegments(inputProps.playlist, fps).map(segment => {
      const start = frame;
      frame += segment.durationFrames - segment.transitionAfterFrames;
      return { ...segment, start, next: frame };
    });
  }, [inputProps, fps]);
  const frames = segments.at(-1)?.next ?? 0;
  const selectedSegmentIndex = segments.findIndex(segment => segment.songIndex === activeIdx && segment.clipIndex === activeClipIdx);
  const chosen = segments[selectedSegmentIndex];
  const selectedStart = useRef(chosen?.start);
  selectedStart.current = chosen?.start;
  useEffect(() => {
    if (!full) return;
    player.current?.seekTo(activeView === 'intro' ? 0 : selectedStart.current ?? 0);
  }, [full, activeIdx, activeClipIdx, activeView, player]);
  useEffect(() => {
    const instance = player.current;
    if (!instance || !onPlaybackChange) return;
    const play = () => onPlaybackChange(true);
    const pause = () => onPlaybackChange(false);
    pause();
    instance.addEventListener('play', play);
    instance.addEventListener('pause', pause);
    instance.addEventListener('ended', pause);
    return () => {
      instance.removeEventListener('play', play);
      instance.removeEventListener('pause', pause);
      instance.removeEventListener('ended', pause);
    };
  }, [player, onPlaybackChange, activeIdx, activeClipIdx, activeSong?.has_file, activeSong?.has_normalized, activeSong?.has_audio]);

  const sourceStart = parseSec(activeClip?.start);
  useEffect(() => {
    const instance = player.current;
    if (!instance || !onSourceTimeChange) return;
    const sync = () => onSourceTimeChange(sourceStart + instance.getCurrentFrame() / fps);
    sync();
    instance.addEventListener('timeupdate', sync);
    instance.addEventListener('seeked', sync);
    return () => {
      instance.removeEventListener('timeupdate', sync);
      instance.removeEventListener('seeked', sync);
    };
  }, [player, onSourceTimeChange, sourceStart, fps, activeIdx, activeClipIdx,
    activeSong?.has_file, activeSong?.has_normalized, activeSong?.has_audio]);

  useEffect(() => {
    const instance = player.current;
    if (!full || !instance) return;
    const sync = () => setPosition(instance.getCurrentFrame());
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    sync();
    instance.addEventListener('frameupdate', sync);
    instance.addEventListener('seeked', sync);
    instance.addEventListener('play', play);
    instance.addEventListener('pause', pause);
    instance.addEventListener('ended', pause);
    return () => {
      instance.removeEventListener('frameupdate', sync);
      instance.removeEventListener('seeked', sync);
      instance.removeEventListener('play', play);
      instance.removeEventListener('pause', pause);
      instance.removeEventListener('ended', pause);
    };
  }, [full, player]);

  const width = playlist.resolution?.width || 1920;
  const height = playlist.resolution?.height || 1080;

  const preview = (
    <Bay title={full ? "Sequence Preview" : "FX Preview"}>
      {full || (isPublicDemo && activeSong?.cover_url) || activeSong?.has_file || activeSong?.has_normalized || activeSong?.has_audio ? (
        <Player
          ref={player}
          key={full ? "full" : `${activeIdx}-${activeClipIdx}`}
          component={SequenceMix}
          inputProps={{ ...inputProps, onMix: full ? setMix : undefined }}
          durationInFrames={Math.max(1, frames)}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          controls={!full && !transportRef}
          clickToPlay={!full && !transportRef}
          spaceKeyToPlayOrPause={!full && !transportRef}
          loop={Boolean(transportRef && trimLoopPlaying)}
          style={{ width: '100%', aspectRatio: width / height }}
        />
      ) : <span>添加本地素材后可预览效果。</span>}
    </Bay>
  );

  if (!full) return preview;

  return (
    <div className="deck-body full-edit">
      <div className="sequence-monitor">
        <div className="sequence-glass">
          <div className="sequence-time"><strong>{fmtSec(position / fps)}</strong> / {fmtSec(frames / fps)}</div>
          {preview}
          <div className="sequence-meters" aria-label="Composition mix">
            <AudioMeter label="L" db={Math.round(mix?.left ?? -60)} />
            <AudioMeter label="R" db={Math.round(mix?.right ?? -60)} />
            <span>{mix ? (mix.clip ? 'CLIP · dBFS' : 'Mix · dBFS') : 'Mix meter unavailable'}</span>
          </div>
        </div>
        <Bay title="Sequence Tape" right={
          <div className="sequence-transport">
            <TactileButton variant="dark" onClick={event => player.current?.toggle(event)}>{playing ? 'Pause' : 'Play'}</TactileButton>
            {activeView === 'song' && chosen && selectedSegmentIndex > 0 && (
              <TactileButton onClick={() => player.current?.seekTo(Math.max(0, chosen.start - Math.round(fps / 2)))}>
                Preview Transition
              </TactileButton>
            )}
          </div>
        }>
          <div className="sequence-tape-track">
            <div className="sequence-tape-progress" style={{ width: `${Math.min(100, position / Math.max(1, frames - 1) * 100)}%` }} />
            <input className="sequence-scrub" type="range" aria-label="Sequence playhead" min={0} max={Math.max(0, frames - 1)} value={Math.min(position, Math.max(0, frames - 1))} onChange={event => player.current?.seekTo(Number(event.target.value))} />
          </div>
        </Bay>
        {activeView === 'song' && chosen && (
          <ReasonPanel
            onStamp={index => {
              const current = player.current?.getCurrentFrame() ?? chosen.start;
              const clipFrame = Math.max(0, Math.min(chosen.durationFrames - 1, current - chosen.start));
              setClipReasonTiming(index, Math.round(clipFrame / fps * 10) / 10);
            }}
          />
        )}
      </div>
      <div className="full-inspector">
        <ColumnDivider side="sequence" />
        <div className="song-inspector">
          {activeView === 'intro' ? <IntroGlobalView /> : <>
            {chosen && <Bay title="Selected Clip">
              <strong>{chosen.song.title}</strong>
              {activeClips.length > 1 && (
                <select
                  className="te-select"
                  aria-label="Selected clip"
                  value={activeClipIdx}
                  onChange={event => switchTrimClip(Number(event.target.value))}
                >
                  {activeClips.map((clip, index) => (
                    <option key={index} value={index}>Clip {index + 1} · {clip.start}–{clip.end}</option>
                  ))}
                </select>
              )}
              <p>Sequence {fmtSec(chosen.start / fps)}–{fmtSec((chosen.start + chosen.durationFrames) / fps)}</p>
              <p>Source {chosen.clip.start}–{chosen.clip.end}</p>
            </Bay>}
            <StageFxView embedded />
          </>}
        </div>
      </div>
    </div>
  );
}
