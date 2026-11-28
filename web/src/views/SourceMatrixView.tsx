import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Bay } from '../components/ui/Bay';
import { SafeImage } from '../components/ui/SafeImage';
import { Segmented } from '../components/ui/Segmented';
import { TactileButton } from '../components/ui/TactileButton';
import { useStudioStore } from '../state/useStudioStore';
import { coverSrc } from '../utils/time';

export function SourceMatrixView() {
  const {
    activeIdx,
    activeSong,
    activeMediaUrl,
    activeSourceMode,
    activePlatform,
    activeCandidates,
    customQuery,
    setCustomQuery,
    loadingCandidates,
    showCandidateGallery,
    setSourceGalleryOpen,
    openCandidateGallery,
    setPlatform,
    searchCandidates,
    lockedCandidate,
    sourceCanPlayVideo,
    setSourceMode,
    adoptCandidate,
    uploadingLocal,
    uploadLocalFile,
    updateActiveSongField,
    downloadSingle,
    openNeteaseAudioModal,
    downloadNeteaseAudioSingle,
    neteaseAudioCfg,
  } = useStudioStore();

  const [localDragActive, setLocalDragActive] = useState(false);
  const [stagePlaying, setStagePlaying] = useState(false);
  const stageVideoRef = useRef<HTMLVideoElement | null>(null);
  const localUploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setStagePlaying(false);
  }, [activeIdx, activeMediaUrl, activeSourceMode]);

  if (!activeSong) return null;

  const toggleStagePlay = () => {
    const v = stageVideoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await uploadLocalFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setLocalDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await uploadLocalFile(file);
    }
  };

  return (
    <div className="deck-body fill-mode">
      <section className="source-routing panel-box" aria-label="素材來源">
        <h2>Input source</h2>
        <Segmented
          className="source-mode-seg"
          value={activeSourceMode}
          onChange={(m) => setSourceMode(m)}
          options={[
            {
              value: 'video_url',
              label: '视频链接',
              testId: 'source-mode-video_url',
            },
            {
              value: 'netease_cover',
              label: '封面合成',
              testId: 'source-mode-netease_cover',
            },
            {
              value: 'local',
              label: '本地视频',
              testId: 'source-mode-local',
            },
          ]}
        />
      </section>
      <div className="source-grid">
        <section className="panel-box cand-bay" data-testid="cand-bay">
          {activeSourceMode === 'video_url' ? (
            <>
              <div className="panel-head">
                <span>Candidate preview</span>
                <span className="mono">
                  {showCandidateGallery
                    ? `${activeCandidates.length} RESULTS`
                    : lockedCandidate || activeSong.youtube_url
                      ? 'LOCKED'
                      : sourceCanPlayVideo
                        ? 'CACHED'
                        : 'STANDBY'}
                </span>
              </div>
              <div className="cand-toolbar">
                <input
                  type="text"
                  className="te-input"
                  style={{ flex: '1 1 180px', minWidth: 140 }}
                  data-testid="cand-search-input"
                  value={customQuery}
                  onChange={(e) => setCustomQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') searchCandidates();
                  }}
                  placeholder="输入检索关键词..."
                />
                <Segmented
                  value={activePlatform}
                  onChange={setPlatform}
                  options={[
                    { value: 'all', label: 'ALL' },
                    { value: 'bilibili', label: 'BILI' },
                    { value: 'youtube', label: 'YT' },
                  ]}
                />
                <TactileButton
                  size="sm"
                  disabled={loadingCandidates}
                  data-testid="cand-search-btn"
                  onClick={() => searchCandidates()}
                >
                  检索
                </TactileButton>
                <TactileButton
                  size="sm"
                  data-testid="cand-switch-btn"
                  onClick={() => {
                    if (showCandidateGallery) {
                      setSourceGalleryOpen(false);
                    } else {
                      openCandidateGallery();
                    }
                  }}
                >
                  {showCandidateGallery ? '← 主视频' : '更换候选'}
                </TactileButton>
              </div>

              {showCandidateGallery ? (
                <div className="cand-scroll">
                  {loadingCandidates ? (
                    <div className="cand-empty">
                      <span>SEARCHING CANDIDATES...</span>
                    </div>
                  ) : activeCandidates.length === 0 ? (
                    <div className="cand-empty">
                      <span>NO CANDIDATES FOUND · TRY CUSTOM QUERY</span>
                    </div>
                  ) : (
                    <div className="cand-grid">
                      {activeCandidates.map((cand, cIdx) => {
                        const selected = activeSong.youtube_url === cand.url;
                        return (
                          <div key={`${cand.id}-${cIdx}`} className={selected ? 'cand-card selected' : 'cand-card'}>
                            <TactileButton
                              customLayout
                              className="cand-select"
                              data-testid={`cand-card-${cIdx}`}
                              onClick={() => adoptCandidate(cand, false)}
                            >
                              <span className="cand-thumb">
                                <SafeImage
                                  src={cand.thumbnail}
                                  alt={cand.title}
                                  fallback={<span className="mono">{cand.platform.toUpperCase()}</span>}
                                />
                                <span className="cand-badge tl">{cand.platform.toUpperCase()}</span>
                                <span className="cand-badge br">{cand.duration_str || '--'}</span>
                                {selected ? <span className="cand-badge tr">LOCKED</span> : null}
                              </span>
                              <span className="cand-title">{cand.title}</span>
                            </TactileButton>
                            <div className="cand-foot">
                              <span className="cand-uploader">{cand.uploader || 'Unknown'}</span>
                              <TactileButton size="xs" onClick={() => adoptCandidate(cand, true)}>
                                下载
                              </TactileButton>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="stage-focus" data-testid="locked-source-stage">
                  <div className="stage-screen">
                    <div className="screen-bezel stage-screen-bezel">
                      <div className="screen-frame">
                        <div className="screen-bar">
                          <span>VIDEO LINK</span>
                          <span>
                            {sourceCanPlayVideo
                              ? stagePlaying
                                ? 'PLAYING'
                                : 'READY'
                              : 'STANDBY'}
                          </span>
                        </div>
                        <div className="stage-video-wrap">
                          {sourceCanPlayVideo ? (
                            <video
                              key={activeMediaUrl}
                              ref={stageVideoRef}
                              src={activeMediaUrl}
                              playsInline
                              preload="metadata"
                              onPlay={() => setStagePlaying(true)}
                              onPause={() => setStagePlaying(false)}
                              onEnded={() => setStagePlaying(false)}
                            />
                          ) : (
                            <>
                              <SafeImage
                                src={lockedCandidate?.thumbnail || coverSrc(activeSong)}
                                alt={activeSong.title}
                                className="stage-poster"
                                fallback={null}
                              />
                              <div className="stage-overlay source-preview-overlay">
                                <div className="mono">
                                  {lockedCandidate?.title || activeSong.youtube_url || activeSong.title}
                                </div>
                                <span className="source-preview-note">下载后可在这里预览</span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="stage-focus-foot">
                    <span className="telemetry-path mono">
                      {activeSong.youtube_url || activeSong.file_path || 'NO SOURCE LINK'}
                    </span>
                    <div className="cand-actions">
                      {sourceCanPlayVideo ? (
                        <TactileButton
                          variant="dark"
                          size="sm"
                          onClick={() => toggleStagePlay()}
                        >
                          {stagePlaying ? '❚❚ PAUSE' : '▶ PREVIEW'}
                        </TactileButton>
                      ) : null}
                      {activeSong.youtube_url && !sourceCanPlayVideo ? (
                        <TactileButton variant="accent" size="sm" onClick={() => downloadSingle(activeIdx)}>
                          ↓ 下载视频
                        </TactileButton>
                      ) : null}
                      {activeSong.youtube_url ? (
                        <a
                          href={activeSong.youtube_url}
                          target="_blank"
                          rel="noreferrer"
                          className="te-btn te-btn-sm te-btn-ghost"
                        >
                          打开原链接 ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : activeSourceMode === 'netease_cover' ? (
            <>
              <div className="panel-head">
                <span>COVER VIDEO STAGE</span>
                <span className="mono">{activeSong.has_file ? 'READY' : 'SYNTH PENDING'}</span>
              </div>
              <div className="stage-focus">
                <div className="stage-screen">
                  <div className="screen-bezel stage-screen-bezel">
                    <div className="screen-frame">
                      <div className="screen-bar">
                        <span>SYS.02 · NETEASE_SYNTH</span>
                        <span>
                          {activeMediaUrl
                            ? stagePlaying
                              ? 'PLAYING'
                              : 'READY'
                            : 'SYNTH PENDING'}
                        </span>
                      </div>
                      <div className="stage-video-wrap">
                        {activeMediaUrl ? (
                          <video
                            key={activeMediaUrl}
                            ref={stageVideoRef}
                            src={activeMediaUrl}
                            playsInline
                            preload="metadata"
                            onPlay={() => setStagePlaying(true)}
                            onPause={() => setStagePlaying(false)}
                            onEnded={() => setStagePlaying(false)}
                          />
                        ) : (
                          <div className="stage-overlay">
                            <SafeImage
                              src={coverSrc(activeSong)}
                              alt={activeSong.title}
                              className="stage-cover-hero"
                              fallback={null}
                            />
                            <div>{activeSong.title}</div>
                            <TactileButton
                              variant="accent"
                              onClick={() => downloadSingle(activeIdx)}
                            >
                              合成 1080P 封面视频
                            </TactileButton>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                {activeMediaUrl ? (
                  <div className="stage-focus-foot">
                    <span className="telemetry-path mono">
                      {activeSong.file_path || activeSong.title}
                    </span>
                    <TactileButton
                      variant="dark"
                      size="sm"
                      onClick={() => toggleStagePlay()}
                    >
                      {stagePlaying ? '❚❚ PAUSE' : '▶ PREVIEW'}
                    </TactileButton>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="panel-head">
                <span>LOCAL VIDEO STAGE</span>
                <span className="mono telemetry-path panel-head-path">
                  {activeSong.file_path || 'UNBOUND'}
                </span>
              </div>
              <div className="stage-focus">
                {activeMediaUrl ? (
                  <>
                    <div className="stage-screen">
                      <div className="screen-bezel stage-screen-bezel">
                        <div className="screen-frame">
                          <div className="screen-bar">
                            <span>SYS.02 · LOCAL_STAGE</span>
                            <span>{stagePlaying ? 'PLAYING' : 'READY'}</span>
                          </div>
                          <div className="stage-video-wrap">
                            <video
                              key={activeMediaUrl}
                              ref={stageVideoRef}
                              src={activeMediaUrl}
                              playsInline
                              preload="metadata"
                              onPlay={() => setStagePlaying(true)}
                              onPause={() => setStagePlaying(false)}
                              onEnded={() => setStagePlaying(false)}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="stage-focus-foot">
                      <span className="telemetry-path mono">
                        {activeSong.file_path || 'LOCAL VIDEO'}
                      </span>
                      <TactileButton
                        variant="dark"
                        size="sm"
                        onClick={() => toggleStagePlay()}
                      >
                        {stagePlaying ? '❚❚ PAUSE' : '▶ PREVIEW'}
                      </TactileButton>
                    </div>
                  </>
                ) : (
                  <TactileButton customLayout
                    className={
                      localDragActive ? 'stage-drop-hero drag-active' : 'stage-drop-hero'
                    }
                    onClick={() => localUploadRef.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        localUploadRef.current?.click();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setLocalDragActive(true);
                    }}
                    onDragLeave={() => setLocalDragActive(false)}
                    onDrop={handleDrop}
                  >
                    <span className="mono">拖拽或点击选择本地 MP4 / MOV / MKV</span>
                    <span className="transport-hint">支持将文件直接拖到此处</span>
                  </TactileButton>
                )}
              </div>
            </>
          )}
        </section>

        <div className="source-bay" data-testid="source-bay">
          <Bay title="SOURCE ACTIONS">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeSourceMode === 'video_url' ? (
                <>
                  <div className="field">
                    <label className="field-label">VIDEO URL (BILI / YT)</label>
                    <textarea
                      rows={2}
                      className="te-textarea mono"
                      value={activeSong.youtube_url || ''}
                      onChange={(e) => updateActiveSongField('youtube_url', e.target.value)}
                      placeholder="粘贴 B站 / YouTube 视频链接..."
                    />
                  </div>
                  {showCandidateGallery || !activeSong.youtube_url || sourceCanPlayVideo ? (
                    <TactileButton variant="accent" onClick={() => downloadSingle(activeIdx)}>
                      ↓ {sourceCanPlayVideo ? '重新下载视频' : '下载视频'}
                    </TactileButton>
                  ) : null}
                </>
              ) : null}

              {activeSourceMode === 'netease_cover' ? (
                <div className="netease-synth-card" data-testid="netease-synth-card">
                  <div className="netease-synth-head">
                    <div className="netease-synth-cover">
                      <SafeImage
                        src={coverSrc(activeSong)}
                        alt={activeSong.title}
                        fallback={<span>COVER</span>}
                      />
                    </div>
                    <div className="rack-meta">
                      <div className="rack-song">{activeSong.title}</div>
                      <div className="rack-artist">1080P 封面合成</div>
                    </div>
                  </div>
                  <TactileButton
                    variant="accent"
                    onClick={() => downloadSingle(activeIdx)}
                  >
                    合成 1080P 封面视频
                  </TactileButton>
                </div>
              ) : null}

              {activeSourceMode === 'local' ? (
                <div
                  className={localDragActive ? 'drop-zone drag-active' : 'drop-zone'}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setLocalDragActive(true);
                  }}
                  onDragLeave={() => setLocalDragActive(false)}
                  onDrop={handleDrop}
                >
                  <div className="mono">
                    {uploadingLocal ? 'UPLOADING...' : '选择或拖放本地视频文件'}
                  </div>
                  <input
                    ref={localUploadRef}
                    type="file"
                    accept="video/*"
                    className="te-file"
                    data-testid="local-upload-input"
                    onChange={handleFileChange}
                  />
                </div>
              ) : null}
            </div>
          </Bay>

          <Bay title="AUDIO AUX">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="telemetry-row">
                <span className={activeSong.has_audio ? 'te-led green' : 'te-led off'} />
                <span>AUDIO</span>
                <span className="telemetry-path">
                  {activeSong.has_audio
                    ? `READY (${activeSong.audio_size_mb || 0}MB)`
                    : 'NOT DOWNLOADED'}
                </span>
              </div>
              <div className="empty-card-actions">
                <TactileButton
                  size="sm"
                  onClick={() =>
                    downloadNeteaseAudioSingle(
                      activeIdx,
                      'audio',
                      neteaseAudioCfg.default_quality || 'flac',
                    )
                  }
                >
                  拉取无损音频
                </TactileButton>
                <TactileButton
                  variant="ghost"
                  size="sm"
                  onClick={() => openNeteaseAudioModal()}
                >
                  音源配置
                </TactileButton>
              </div>
            </div>
          </Bay>

          <Bay title="LOCAL STATUS">
            <div className="telemetry-list">
              <div className="telemetry-row">
                <span className={activeSong.has_file ? 'te-led green' : 'te-led off'} />
                <span>RAW MV</span>
                <span className="telemetry-path">{activeSong.file_path || 'EMPTY'}</span>
              </div>
              <div className="telemetry-row">
                <span className={activeSong.has_normalized ? 'te-led green' : 'te-led off'} />
                <span>NORM</span>
                <span className="telemetry-path">{activeSong.normalized_path || 'EMPTY'}</span>
              </div>
            </div>
          </Bay>
        </div>
      </div>
    </div>
  );
}
