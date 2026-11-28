import { useLayoutEffect, useRef } from 'react';

const storageKey = 'mrv_workstation_size';

export function WorkstationResize() {
  const grip = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const shell = () => grip.current?.closest<HTMLElement>('.shell');
  const resize = (width: number, height: number) => {
    const node = shell();
    if (!node) return;
    const w = Math.max(Math.min(1100, innerWidth - 24), Math.min(width, innerWidth - 24));
    const h = Math.max(Math.min(700, innerHeight - 24), Math.min(height, innerHeight - 24));
    node.style.setProperty('--workstation-width', `${w}px`);
    node.style.setProperty('--workstation-height', `${h}px`);
    localStorage.setItem(storageKey, JSON.stringify([w, h]));
  };

  useLayoutEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (Array.isArray(saved) && saved.length === 2 && saved.every(value => Number.isFinite(value))) {
        shell()?.style.setProperty('--workstation-width', `${saved[0]}px`);
        shell()?.style.setProperty('--workstation-height', `${saved[1]}px`);
      }
    } catch {
      localStorage.removeItem(storageKey);
    }
  }, []);

  return (
    <button ref={grip} type="button" className="workstation-resize" aria-label="Resize workstation"
      title="Drag to resize. Double-click to reset."
      onPointerDown={event => {
        const rect = shell()?.getBoundingClientRect();
        if (!rect || event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        resize(drag.current.width + 2 * (event.clientX - drag.current.x), drag.current.height + 2 * (event.clientY - drag.current.y));
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => {
        shell()?.style.removeProperty('--workstation-width');
        shell()?.style.removeProperty('--workstation-height');
        localStorage.removeItem(storageKey);
      }}
      onKeyDown={event => {
        const rect = shell()?.getBoundingClientRect();
        if (!rect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.stopPropagation();
        event.preventDefault();
        resize(rect.width + (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0),
          rect.height + (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0));
      }}
    />
  );
}
