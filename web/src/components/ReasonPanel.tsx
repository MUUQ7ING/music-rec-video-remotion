import { useStudioStore } from '../state/useStudioStore';
import { splitReasonParagraphs } from '../utils/time';
import { Segmented } from './ui/Segmented';
import { TactileButton } from './ui/TactileButton';

export function ReasonPanel({ onStamp }: { onStamp?: (index: number) => void } = {}) {
  const {
    activeClipIdx,
    activeClip,
    isSaving,
    setClipReason,
    setClipReasonMode,
    setClipReasonTiming,
    stampClipReasonTiming,
    applyTrimAndSave,
  } = useStudioStore();

  const reason = activeClip?.reason || '';
  const reasonMode = activeClip?.reason_mode === 'manual' ? 'manual' : 'auto';
  const timings = Array.isArray(activeClip?.reason_timings) ? activeClip.reason_timings : [];
  const paragraphs = splitReasonParagraphs(reason);

  return (
    <section className="panel-box reason-col" data-testid="reason-panel">
      <div className="panel-head">
        <span>CLIP {activeClipIdx + 1} REASON</span>
        <Segmented
          value={reasonMode}
          onChange={setClipReasonMode}
          options={[
            { value: 'auto', label: 'AUTO', testId: 'reason-mode-auto' },
            { value: 'manual', label: 'MANUAL', testId: 'reason-mode-manual' },
          ]}
        />
      </div>

      <div className="reason-body">
        <textarea
          className="te-textarea reason-textarea"
          data-testid="reason-textarea"
          value={reason}
          onChange={(e) => setClipReason(e.target.value)}
          placeholder="输入推荐文案，支持用空行分隔多段..."
        />

        {reasonMode === 'manual' && paragraphs.length > 1 ? (
          <div className="timing-list">
            {paragraphs.map((p, pIdx) => (
              <div
                key={pIdx}
                className="timing-row"
                data-testid={`timing-row-${pIdx}`}
              >
                <span className="mono">P{pIdx + 1}</span>
                <span className="timing-snippet">{p}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  className="te-input mono"
                  value={timings[pIdx] ?? 0}
                  onChange={(e) =>
                    setClipReasonTiming(pIdx, parseFloat(e.target.value) || 0)
                  }
                />
                <TactileButton
                  size="xs"
                  onClick={() => (onStamp ?? stampClipReasonTiming)(pIdx)}
                >
                  打点
                </TactileButton>
              </div>
            ))}
          </div>
        ) : null}

        <div className="reason-footer">
          <span className="transport-hint">CMD+S QUICK SAVE</span>
          <TactileButton
            variant="accent"
            disabled={isSaving}
            data-testid="apply-trim-save-btn"
            onClick={() => applyTrimAndSave()}
          >
            应用并保存定剪与文案
          </TactileButton>
        </div>
      </div>
    </section>
  );
}
