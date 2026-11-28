declare module '@andeus/ui' {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ink' | 'ghost';
    size?: 's' | 'm' | 'l';
  }

  export function Button(props: ButtonProps): ReactElement;

  export function Segmented<T extends string>(props: {
    options: { value: T; label: ReactNode }[];
    value: T;
    onChange: (value: T) => void;
    size?: 's' | 'm';
  }): ReactElement;
}
