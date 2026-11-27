import type { ReactNode } from 'react';

export interface BadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'default' | 'accent' | 'green' | 'red';
  dot?: boolean;
  led?: 'green' | 'amber' | 'red' | 'accent' | 'off';
  testId?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  led,
  testId,
}: BadgeProps) {
  const cls = tone === 'neutral' || tone === 'default' ? 'te-badge' : `te-badge ${tone}`;
  const ledTone = led || (tone === 'neutral' || tone === 'default' ? 'off' : tone);
  return (
    <span className={cls} data-testid={testId}>
      {dot || led ? <span className={`te-led ${ledTone}`} /> : null}
      {children}
    </span>
  );
}

export interface TagProps {
  children: ReactNode;
  swatchColor?: string;
}

export function Tag({ children, swatchColor }: TagProps) {
  return (
    <span className="te-tag">
      {swatchColor ? (
        <span className="te-tag-swatch" style={{ background: swatchColor }} />
      ) : null}
      {children}
    </span>
  );
}
