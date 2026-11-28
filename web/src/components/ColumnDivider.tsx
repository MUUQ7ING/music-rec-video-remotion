import { useLayoutEffect, useRef } from 'react';

const columns = {
  rack: { container: '.workspace', panel: '.rack', label: '调整曲目栏宽度' },
  editor: { container: '.trim-grid', panel: '.side-stack', label: '调整歌词文案栏宽度' },
  sequence: { container: '.full-edit', panel: '.full-inspector', label: '调整全片编辑右栏宽度' },
};

export function ColumnDivider({ side }: { side: keyof typeof columns }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const key = `mrv_column_${side}`;
  const variable = `--${side}-width`;
  const column = columns[side];
  const container = () => ref.current?.closest<HTMLElement>(column.container);
  const panelWidth = () => container()?.querySelector(column.panel)?.getBoundingClientRect().width ?? 0;
  const direction = side === 'rack' ? 1 : -1;

  useLayoutEffect(() => {
    const panel = ref.current?.closest<HTMLElement>(column.container);
    const saved = Number(localStorage.getItem(key));
    if (saved > 0) panel?.style.setProperty(variable, `${saved}px`);
  }, [key, column, variable]);

  const resize = (width: number) => {
    const parent = container();
    if (!parent) return;
    const maximum = parent.clientWidth - (side === 'rack' ? 600 : 350);
    const next = Math.round(Math.max(side === 'rack' ? 200 : 310, Math.min(maximum, width)));
    parent.style.setProperty(variable, `${next}px`);
    localStorage.setItem(key, String(next));
  };

  return (
    <div
      ref={ref}
      className={`column-divider column-divider-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={column.label}
      title="拖动或用方向键调整宽度，双击恢复"
      tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, width: panelWidth() };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (drag.current) resize(drag.current.width + (event.clientX - drag.current.x) * direction);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => {
        container()?.style.removeProperty(variable);
        localStorage.removeItem(key);
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.stopPropagation();
        event.preventDefault();
        resize(panelWidth() + (event.key === 'ArrowRight' ? 16 : -16) * direction);
      }}
    />
  );
}
