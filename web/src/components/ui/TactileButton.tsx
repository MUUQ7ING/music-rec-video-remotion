import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface TactileButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'accent' | 'dark' | 'danger';
  size?: 'md' | 'sm' | 'xs' | 'icon';
  led?: 'green' | 'amber' | 'red' | 'accent' | 'off';
  ledPulse?: boolean;
  active?: boolean;
  children?: ReactNode;
}

export function TactileButton({
  variant = 'default',
  size = 'md',
  led,
  ledPulse = false,
  active = false,
  type = 'button',
  className = '',
  children,
  ...rest
}: TactileButtonProps) {
  const classes = ['te-btn'];
  if (variant !== 'default') classes.push(`te-btn-${variant}`);
  if (size === 'sm') classes.push('te-btn-sm');
  else if (size === 'xs') classes.push('te-btn-xs');
  else if (size === 'icon') classes.push('te-icon-btn');
  if (active) classes.push('is-pressed');
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {led ? (
        <span className={`te-led ${led}${ledPulse ? ' pulse' : ''}`} />
      ) : null}
      {children}
    </button>
  );
}
