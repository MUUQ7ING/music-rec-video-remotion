import { TactileButton } from './ui/TactileButton';
import { useStudioStore } from '../state/useStudioStore';

export function ConsoleDrawer() {
  const { status, showLogs, setShowLogs, clearLogs } = useStudioStore();

  const busy = Boolean(status.is_downloading || status.is_rendering);
  const logs = status.logs || [];
  const latest = logs.length > 0 ? logs[logs.length - 1] : '';
  const stateLabel = status.is_rendering
    ? 'RENDER'
    : status.is_downloading
      ? 'QUEUE'
      : 'IDLE';

  return (
    <footer className="console-wrap">
      {showLogs ? (
        <div className="console-drawer" data-testid="console-drawer">
          {logs.length === 0 ? (
            <div>NO LOGS YET</div>
          ) : (
            logs.map((line, i) => <div key={`${i}-${line.slice(0, 16)}`}>{line}</div>)
          )}
        </div>
      ) : null}

      <div className="console-bar" data-testid="console-bar">
        <div className="console-left">
          <span className={busy ? 'te-led accent pulse' : 'te-led green'} />
          <span>{stateLabel}</span>
          {status.queue_count > 0 ? <span>[Q:{status.queue_count}]</span> : null}
          {busy ? (
            <div className="prog-track">
              <div
                className="prog-fill"
                style={{ width: `${Math.max(4, Math.min(100, status.progress_percent || 0))}%` }}
              />
            </div>
          ) : null}
          {status.current_song ? (
            <span className="console-song" title={status.current_song}>
              {status.current_song}
            </span>
          ) : null}
          <span className="console-msg" data-testid="console-latest-msg">
            {latest || 'READY · REMOTION ENGINE STANDBY'}
          </span>
        </div>

        <div className="console-right">
          {showLogs && logs.length > 0 ? (
            <TactileButton customLayout
              type="button"
              className="console-btn"
              data-testid="console-clear-btn"
              onClick={() => clearLogs()}
            >
              CLEAR
            </TactileButton>
          ) : null}
          <TactileButton customLayout
            type="button"
            className="console-btn"
            data-testid="console-toggle-btn"
            onClick={() => setShowLogs((prev) => !prev)}
          >
            LOGS ({logs.length}) {showLogs ? '▼' : '▲'}
          </TactileButton>
        </div>
      </div>
    </footer>
  );
}
