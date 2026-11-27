import { useEffect, useState } from 'react';

export function TransportKeycaps() {
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const update = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    const reset = () => setShiftHeld(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return (
    <div className="transport-keycaps" aria-label="剪辑快捷键">
      <kbd title="播放或暂停">Space</kbd>
      <kbd title="设置入点">I</kbd>
      <kbd title="设置出点">O</kbd>
      <kbd data-testid="transport-seek-keycap" title="左右定位 0.5 秒，按住 Shift 定位 2 秒">
        <span>← →</span><span>{shiftHeld ? '2 s' : '0.5 s'}</span>
      </kbd>
    </div>
  );
}
