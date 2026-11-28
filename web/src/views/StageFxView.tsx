import { lazy, Suspense } from 'react';
import { Bay } from '../components/ui/Bay';
import { SafeImage } from '../components/ui/SafeImage';
import { Segmented } from '../components/ui/Segmented';
import { Switch } from '../components/ui/Switch';
import { TactileButton } from '../components/ui/TactileButton';
import { useStudioStore } from '../state/useStudioStore';
import {
  TRANSITION_OPTIONS,
  VISUAL_EFFECT_OPTIONS,
  VISUAL_MODIFIER_OPTIONS,
  type ShadowBoostMode,
} from '../types/studio';
import { coverSrc } from '../utils/time';

const TrackCompositionPreview = lazy(() => import('../components/TrackCompositionPreview'));

export function StageFxView({ embedded = false }: { embedded?: boolean }) {
  const {
    activeIdx,
    activeSong,
    activeClip,
    activeClipIdx,
    activeClips,
    setClipVisualEffect,
    isSaving,
    updateActiveSongField,
    toggleVisualModifier,
    saveMeta,
    deleteSong,
  } = useStudioStore();

  if (!activeSong) return null;

  const clipScoped = activeClips.length > 1;
  const effect = clipScoped ? activeClip?.visual_effect ?? 'inherit' : activeSong.visual_effect || 'auto';
  const mods = (clipScoped ? activeClip?.visual_modifiers : undefined) ?? activeSong.visual_modifiers ?? [];
  const readyAssetCount = [
    activeSong.has_file,
    activeSong.has_normalized,
    activeSong.has_cover,
    activeSong.has_audio,
    activeSong.has_lyrics,
  ].filter(Boolean).length;
  const txActive = (activeSong.transition_style || 'inherit') !== 'inherit';
  const visualActive = effect !== 'auto' && effect !== 'inherit';
  const modsActive = mods.length > 0;
  const hudActive =
    activeSong.lyrics_enabled === false || (activeSong.shadow_boost || 'auto') !== 'auto';

  return (
    <div className="deck-body">
      <div className="meta-grid stage-layout">
        {!embedded && <div className="meta-col">
          <Suspense fallback={<p>正在加载效果预览…</p>}><TrackCompositionPreview /></Suspense>
        </div>}
        <div className="meta-col">
          <Bay
            title="STAGE & FX"
            flush
            right={
              <TactileButton
                variant="accent"
                size="sm"
                disabled={isSaving}
                data-testid="meta-save-btn"
                onClick={() => saveMeta()}
              >
                保存修改
              </TactileButton>
            }
          >
            <div className="fx-bank">
              <div className={txActive ? 'fx-block active' : 'fx-block'}>
                <div className="fx-block-head">
                  <div className="fx-block-title">
                    <span>TRANSITION</span>
                  </div>
                  <span className="te-tag">{txActive ? 'OVERRIDE' : 'INHERIT'}</span>
                </div>
                <select
                  className="te-select"
                  data-testid="fx-transition-select"
                  aria-label="转场"
                  value={activeSong.transition_style || 'inherit'}
                  onChange={(e) => updateActiveSongField('transition_style', e.target.value)}
                >
                  <option value="inherit">跟随全局默认转场 (Inherit)</option>
                  {TRANSITION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={visualActive ? 'fx-block active' : 'fx-block'}>
                <div className="fx-block-head">
                  <div className="fx-block-title">
                    <span>{clipScoped ? `CLIP ${activeClipIdx + 1} FX` : 'VISUAL STAGE'}</span>
                  </div>
                  <span className="te-tag">{visualActive ? 'CUSTOM' : 'AUTO'}</span>
                </div>
                <select
                  className="te-select"
                  data-testid="fx-visual-select"
                  aria-label="舞台效果"
                  value={effect}
                  onChange={(e) => setClipVisualEffect(e.target.value)}
                >
                  {clipScoped && <option value="inherit">Use track effect</option>}
                  {VISUAL_EFFECT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={modsActive ? 'fx-block active' : 'fx-block'}>
                <div className="fx-block-head">
                  <div className="fx-block-title">
                    <span>MODIFIERS</span>
                  </div>
                  <span className="te-tag">{mods.length} ACTIVE</span>
                </div>
                <div className="mod-grid">
                  {VISUAL_MODIFIER_OPTIONS.map((mod) => {
                    const on = mods.includes(mod.id);
                    return (
                      <TactileButton customLayout
                        key={mod.id}
                        type="button"
                        data-testid={`fx-mod-${mod.id}`}
                        aria-pressed={on}
                        className={on ? 'mod-key on' : 'mod-key'}
                        onClick={() => toggleVisualModifier(mod.id)}
                      >
                        <span className="mod-key-lead">
                          <span className={on ? 'te-led accent' : 'te-led off'} aria-hidden="true" />
                          <span>{mod.label}</span>
                        </span>
                        <span className="mod-key-code">{mod.code}</span>
                      </TactileButton>
                    );
                  })}
                </div>
              </div>

              <div className={hudActive ? 'fx-block active' : 'fx-block'}>
                <div className="fx-block-head">
                  <div className="fx-block-title">
                    <span>SUBTITLES &amp; CONTRAST</span>
                  </div>
                  <span className="te-tag">STAGE HUD</span>
                </div>

                <div className="switch-row">
                  <span>显示双语歌词</span>
                  <Switch
                    checked={activeSong.lyrics_enabled !== false}
                    onChange={(next) => updateActiveSongField('lyrics_enabled', next)}
                    label="显示双语歌词"
                    testId="fx-lyrics-switch"
                  />
                </div>

                <div className="switch-row">
                  <span>文字底部压暗</span>
                  <Segmented<ShadowBoostMode>
                    value={activeSong.shadow_boost || 'auto'}
                    onChange={(v) => updateActiveSongField('shadow_boost', v)}
                    options={[
                      { value: 'auto', label: 'AUTO', testId: 'fx-shadow-auto' },
                      { value: 'normal', label: 'NORMAL', testId: 'fx-shadow-normal' },
                      { value: 'strong', label: 'STRONG', testId: 'fx-shadow-strong' },
                    ]}
                  />
                </div>
              </div>
            </div>
          </Bay>
          <Bay
            title="TRACK DETAILS"
            right={
              <>
                <TactileButton
                  variant="danger"
                  size="sm"
                  data-testid="meta-delete-btn"
                  onClick={() => deleteSong(activeIdx)}
                >
                  删除此曲
                </TactileButton>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="cover-row">
                <div className="cover-box">
                  <SafeImage
                    src={coverSrc(activeSong)}
                    alt={activeSong.title}
                    fallback={<span>1:1 COVER</span>}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div className="field">
                    <label className="field-label">TITLE</label>
                    <input
                      type="text"
                      className="te-input"
                      data-testid="meta-title-input"
                      value={activeSong.title || ''}
                      onChange={(e) => updateActiveSongField('title', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">ARTIST</label>
                    <input
                      type="text"
                      className="te-input"
                      data-testid="meta-artist-input"
                      value={activeSong.artist || ''}
                      onChange={(e) => updateActiveSongField('artist', e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="field">
                <label className="field-label">ALBUM</label>
                <input
                  type="text"
                  className="te-input"
                  data-testid="meta-album-input"
                  value={activeSong.album || ''}
                  onChange={(e) => updateActiveSongField('album', e.target.value)}
                />
              </div>

              <div className="field-grid-3">
                <div className="field">
                  <label className="field-label">START</label>
                  <input
                    type="text"
                    className="te-input mono"
                    data-testid="meta-start-input"
                    value={activeSong.start || '0:00'}
                    onChange={(e) => updateActiveSongField('start', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">END</label>
                  <input
                    type="text"
                    className="te-input mono"
                    data-testid="meta-end-input"
                    value={activeSong.end || '0:30'}
                    onChange={(e) => updateActiveSongField('end', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">INDEX</label>
                  <input
                    type="number"
                    className="te-input mono"
                    value={activeSong.display_index ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      updateActiveSongField('display_index', raw ? Number(raw) : null);
                    }}
                    placeholder="AUTO"
                  />
                </div>
              </div>
            </div>
          </Bay>

          <details className="panel-box asset-diagnostics">
            <summary className="panel-head">
              <span>素材检查</span>
              <span className="mono">{readyAssetCount}/5 READY</span>
            </summary>
            <div className="telemetry-list">
              <div className="telemetry-row">
                <span className={activeSong.has_file ? 'te-led green' : 'te-led off'} />
                <span>RAW MV</span>
                <span className="telemetry-path">{activeSong.file_path || 'MISSING'}</span>
              </div>
              <div className="telemetry-row">
                <span className={activeSong.has_normalized ? 'te-led green' : 'te-led off'} />
                <span>-14 LUFS</span>
                <span className="telemetry-path">{activeSong.normalized_path || 'PENDING'}</span>
              </div>
              <div className="telemetry-row">
                <span className={activeSong.has_cover ? 'te-led green' : 'te-led off'} />
                <span>1:1 COVER</span>
                <span className="telemetry-path">{activeSong.cover_path || 'MISSING'}</span>
              </div>
              <div className="telemetry-row">
                <span className={activeSong.has_audio ? 'te-led green' : 'te-led off'} />
                <span>AUDIO</span>
                <span className="telemetry-path">{activeSong.audio_path || 'NONE'}</span>
              </div>
              <div className="telemetry-row">
                <span className={activeSong.has_lyrics ? 'te-led green' : 'te-led off'} />
                <span>LYRICS</span>
                <span className="telemetry-path">{activeSong.lyrics_path || 'NONE'}</span>
              </div>
            </div>
          </details>
        </div>


      </div>
    </div>
  );
}
