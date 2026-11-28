import { useState } from 'react';
import { useStudioStore } from '../state/useStudioStore';
import { coverSrc, formatSongDuration } from '../utils/time';
import { SafeImage } from './ui/SafeImage';
import { Segmented } from './ui/Segmented';
import { TactileButton } from './ui/TactileButton';

export function TrackRack() {
  const {
    playlist,
    rackFilter,
    setRackFilter,
    filteredSongs,
    activeView,
    activeIdx,
    readyCount,
    missingCount,
    selectIntro,
    selectSong,
    addEmptySong,
    reorderSongs,
  } = useStudioStore();

  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const totalCount = (playlist.songs || []).length;
  const introEnabled = Boolean(playlist.intro?.enabled);
  const introDur = Number(playlist.intro?.duration) || 8;

  return (
    <aside className="rack" data-testid="track-rack">
      <div className="rack-header">
        <span className="rack-title">TRACK RACK</span>
        <Segmented
          value={rackFilter}
          onChange={setRackFilter}
          options={[
            { value: 'all', label: 'ALL', testId: 'filter-all' },
            { value: 'missing', label: `MISS (${missingCount})`, testId: 'filter-miss' },
          ]}
        />
      </div>

      <div className="rack-list">
        <TactileButton customLayout
          active={activeView === 'intro'}
          aria-pressed={activeView === 'intro'}
          data-testid="rack-intro"
          className={
            activeView === 'intro' ? 'rack-item intro-item active' : 'rack-item intro-item'
          }
          onClick={() => selectIntro()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectIntro();
            }
          }}
        >
          <span className="rack-num">00</span>
          <span className="rack-thumb">INTRO</span>
          <span className="rack-meta">
            <span className="rack-song">开场白 &amp; 全局转场</span>
            <span className="rack-artist">
              {playlist.transition?.video_style || 'cross_dissolve'}
            </span>
          </span>
          <span className="rack-right">
            <span className="rack-dur">{introEnabled ? `${introDur}s` : 'OFF'}</span>
            <span className={introEnabled ? 'te-led green' : 'te-led off'} />
          </span>
        </TactileButton>

        {filteredSongs.map(({ song, idx }) => {
          const isActive = activeView === 'song' && activeIdx === idx;
          const isDragging = dragSrcIdx === idx;
          const isDragOver = dragOverIdx === idx && dragSrcIdx !== idx;
          const itemClasses = ['rack-item', 'rack-song-item'];
          if (isActive) itemClasses.push('active');
          if (isDragging) itemClasses.push('dragging');
          if (isDragOver) itemClasses.push('drag-over');

          const clipCount = Array.isArray(song.clips) ? song.clips.length : 0;

          return (
            <TactileButton customLayout
              key={`${idx}-${song.netease_id || song.title}`}
              active={isActive}
              aria-pressed={isActive}
              draggable
              data-testid={`rack-song-${idx}`}
              className={itemClasses.join(' ')}
              onClick={() => selectSong(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  selectSong(idx);
                } else if (e.key === ' ') {
                  if (isActive) {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  selectSong(idx);
                }
              }}
              onDragStart={() => setDragSrcIdx(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverIdx(idx);
              }}
              onDragEnd={() => {
                setDragSrcIdx(null);
                setDragOverIdx(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragSrcIdx;
                setDragSrcIdx(null);
                setDragOverIdx(null);
                if (from !== null && from !== idx) {
                  reorderSongs(from, idx);
                }
              }}
            >
              <span className="drag-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="rack-num">{String(idx + 1).padStart(2, '0')}</span>
              <span className="rack-thumb">
                <SafeImage
                  src={coverSrc(song)}
                  alt={song.title}
                  fallback={<span>NO IMG</span>}
                />
              </span>
              <span className="rack-meta">
                <span className="rack-song">{song.title || '未命名曲目'}</span>
                <span className="rack-artist">{song.artist || '未知歌手'}</span>
              </span>
              <span className="rack-right">
                <span className="rack-dur">
                  {formatSongDuration(song)}
                  {clipCount > 1 ? <span className="clip-tag">×{clipCount}</span> : null}
                </span>
                <span className="led-group">
                  <span className="led-cell" title="视频素材">
                    <span className={song.has_file ? 'te-led green' : 'te-led off'} />V
                  </span>
                  <span className="led-cell" title="-14 LUFS 响度标准化">
                    <span className={song.has_normalized ? 'te-led green' : 'te-led off'} />N
                  </span>
                  <span className="led-cell" title="双语歌词">
                    <span className={song.has_lyrics ? 'te-led green' : 'te-led off'} />L
                  </span>
                </span>
              </span>
            </TactileButton>
          );
        })}

        {rackFilter === 'missing' && filteredSongs.length === 0 ? (
          <div className="rack-empty-note">ALL TRACKS READY</div>
        ) : null}
      </div>

      <div className="rack-footer">
        <span>
          {readyCount}/{totalCount} READY · ↑↓ SWITCH
        </span>
        <TactileButton
          size="sm"
          data-testid="add-track-btn"
          onClick={() => addEmptySong()}
        >
          + NEW
        </TactileButton>
      </div>
    </aside>
  );
}
