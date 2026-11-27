import { RotaryKnob } from '../components/ui/RotaryKnob';
import { Bay } from '../components/ui/Bay';
import { Segmented } from '../components/ui/Segmented';
import { Switch } from '../components/ui/Switch';
import { TactileButton } from '../components/ui/TactileButton';
import { useStudioStore } from '../state/useStudioStore';
import { TRANSITION_OPTIONS, type IntroBgMode } from '../types/studio';

export function IntroGlobalView() {
  const {
    playlist,
    introPageCount,
    totalDurationStr,
    isSaving,
    updateIntroField,
    setIntroBgMode,
    updateGlobalTransition,
    saveIntroConfig,
  } = useStudioStore();

  const intro = playlist.intro;
  const transition = playlist.transition;
  const resW = playlist.resolution?.width || 1920;
  const resH = playlist.resolution?.height || 1080;
  const fps = playlist.fps || 60;
  const trackCount = (playlist.songs || []).length;

  return (
    <>
      <div className="deck-bar">
        <div className="deck-bar-left">
          <div className="deck-id">
            <span className="deck-index">00</span>
            <div className="deck-title-wrap">
              <div className="deck-title" data-testid="deck-title">
                INTRO &amp; GLOBAL TRANSITION
              </div>
              <div className="deck-sub">序列开场白与默认转场引擎</div>
            </div>
          </div>
        </div>
        <div className="deck-bar-right">
          <TactileButton
            variant="accent"
            disabled={isSaving}
            data-testid="intro-save-btn"
            onClick={() => saveIntroConfig()}
          >
            保存全局配置
          </TactileButton>
        </div>
      </div>

      <div className="deck-body">
        <div className="meta-grid intro-grid">
          <Bay
            title="INTRO MODULE"
            right={
              <span className="mono" data-testid="intro-page-badge">
                {intro.enabled
                  ? `${introPageCount} PAGE · ${intro.duration}S`
                  : `${introPageCount} PAGE · BYPASSED`}
              </span>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="switch-row">
                <span>启用片头开场白</span>
                <Switch
                  checked={Boolean(intro.enabled)}
                  onChange={(next) => updateIntroField({ enabled: next })}
                  label="启用片头开场白"
                  testId="intro-enabled-switch"
                />
              </div>

              <div className="switch-row">
                <span>自动计算开场白时长</span>
                <Switch
                  checked={intro.auto_duration !== false}
                  onChange={(next) =>
                    updateIntroField({ auto_duration: next }, { recalc: next })
                  }
                  label="自动计算开场白时长"
                  testId="intro-auto-dur-switch"
                />
              </div>

              <div className="field-grid-2 intro-dur-bg-grid">
                <div className="field">
                  <label className="field-label">DURATION (SEC)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="2"
                    className="te-input mono"
                    disabled={intro.auto_duration !== false}
                    value={intro.duration ?? 8}
                    onChange={(e) =>
                      updateIntroField({ duration: parseFloat(e.target.value) || 8 })
                    }
                  />
                </div>
                <div className="field">
                  <label className="field-label">BACKGROUND MODE</label>
                  <Segmented<IntroBgMode>
                    value={intro.bg_mode || 'blur_first_song'}
                    onChange={setIntroBgMode}
                    options={[
                      { value: 'blur_first_song', label: 'BLUR TRK 01' },
                      { value: 'black', label: 'BLACK' },
                      { value: 'image', label: 'IMAGE' },
                    ]}
                  />
                </div>
              </div>

              {intro.bg_mode === 'image' ? (
                <div className="field">
                  <label className="field-label">BG IMAGE PATH</label>
                  <input
                    type="text"
                    className="te-input mono"
                    value={intro.bg_image || ''}
                    onChange={(e) => updateIntroField({ bg_image: e.target.value })}
                    placeholder="covers/intro_bg.jpg"
                  />
                </div>
              ) : null}

              <div className="field">
                <label className="field-label">INTRO MONOLOGUE (空行分段分页)</label>
                <textarea
                  rows={6}
                  className="te-textarea"
                  data-testid="intro-text-input"
                  value={intro.text || ''}
                  onChange={(e) =>
                    updateIntroField({ text: e.target.value }, { recalc: true })
                  }
                  placeholder="输入开场白内容，使用空行分隔多页..."
                />
              </div>
            </div>
          </Bay>

          <div className="meta-col">
            <Bay title="DEFAULT TRANSITION ENGINE">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="field">
                  <label className="field-label">GLOBAL VIDEO TRANSITION</label>
                  <select
                    className="te-select"
                    data-testid="global-transition-select"
                    value={transition.video_style || 'cross_dissolve'}
                    onChange={(e) =>
                      updateGlobalTransition({ video_style: e.target.value })
                    }
                  >
                    {TRANSITION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-grid-2 transition-knobs">
                  <RotaryKnob
                    label="Video duration"
                    tone="orange"
                    min={0}
                    max={Math.max(3, Math.ceil(transition.video_duration ?? 0.6))}
                    exactMax={Infinity}
                    step={0.1}
                    unit="s"
                    value={transition.video_duration ?? 0.6}
                    defaultValue={0.6}
                    onChange={video_duration => updateGlobalTransition({ video_duration })}
                  />
                  <RotaryKnob
                    label="Audio crossfade"
                    tone="ivory"
                    min={0}
                    max={Math.max(3, Math.ceil(transition.audio_duration ?? 0.8))}
                    exactMax={Infinity}
                    step={0.1}
                    unit="s"
                    value={transition.audio_duration ?? 0.8}
                    defaultValue={0.8}
                    onChange={audio_duration => updateGlobalTransition({ audio_duration })}
                  />
                </div>
              </div>
            </Bay>

            <Bay title="SEQUENCE OUTPUT SPEC">
              <div className="telemetry-list">
                <div className="telemetry-row">
                  <span className="te-led green" />
                  <span>CANVAS</span>
                  <span className="telemetry-path">
                    {resW}×{resH} · {fps} FPS
                  </span>
                </div>
                <div className="telemetry-row">
                  <span className={trackCount > 0 ? 'te-led green' : 'te-led off'} />
                  <span>TRACKS</span>
                  <span className="telemetry-path">
                    {trackCount} TRACKS · {totalDurationStr} TOTAL
                  </span>
                </div>
              </div>
            </Bay>
          </div>
        </div>
      </div>
    </>
  );
}
