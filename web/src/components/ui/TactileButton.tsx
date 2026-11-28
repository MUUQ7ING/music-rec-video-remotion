import { Button, type ButtonProps } from '@andeus/ui';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface TactileButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'accent' | 'dark' | 'danger';
  size?: 'md' | 'sm' | 'xs' | 'icon';
  led?: 'green' | 'amber' | 'red' | 'accent' | 'off';
  ledPulse?: boolean;
  'data-testid'?: string;
  active?: boolean;
  customLayout?: boolean;
  children?: ReactNode;
}

export function TactileButton({
  variant = 'default',
  size = 'md',
  led,
  ledPulse = false,
  active = false,
  customLayout = false,
  type = 'button',
  className = '',
  children,
  style,
  ...rest
}: TactileButtonProps) {
  const classes = [customLayout ? 'andeus-custom-key' : 'te-btn', 'andeus-key'];
  let buttonVariant: ButtonProps['variant'] = 'secondary';
  if (variant === 'ghost') buttonVariant = 'ghost';
  if (variant === 'dark') buttonVariant = 'ink';
  if (rest['data-testid'] === 'export-btn') buttonVariant = 'primary';
  if (variant !== 'default') classes.push(`te-btn-${variant}`);
  if (size === 'sm') classes.push('te-btn-sm');
  else if (size === 'xs') classes.push('te-btn-xs');
  else if (size === 'icon') classes.push('te-icon-btn');
  if (active) classes.push('is-pressed');
  if (className) classes.push(className);

  return (
    <Button
      {...rest}
      type={type}
      variant={buttonVariant}
      className={classes.join(' ')}
      style={{
        height: undefined,
        padding: undefined,
        font: undefined,
        ...(customLayout ? {
          display: undefined,
          alignItems: undefined,
          justifyContent: undefined,
          gap: undefined,
          whiteSpace: undefined,
        } : {}),
        ...(active && !rest.disabled ? { background: 'var(--bg-well)', boxShadow: 'var(--key-depressed)' } : {}),
        ...(variant === 'danger' && !rest.disabled ? { color: 'var(--led-red)', borderColor: 'var(--led-red)' } : {}),
        ...style,
      }}
    >
      {led ? (
        <span className={`te-led ${led}${ledPulse ? ' pulse' : ''}`} />
      ) : null}
      {children}
    </Button>
  );
}
