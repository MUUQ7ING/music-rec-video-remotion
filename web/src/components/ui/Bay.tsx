import type { ReactNode } from 'react';

export interface BayProps {
  title: string;
  aux?: ReactNode;
  right?: ReactNode;
  className?: string;
  flush?: boolean;
  testId?: string;
  children: ReactNode;
}

export function Bay({
  title,
  aux,
  right,
  className = '',
  flush = false,
  testId,
  children,
}: BayProps) {
  return (
    <section
      className={className ? `panel-box ${className}` : 'panel-box'}
      data-testid={testId}
    >
      <div className="panel-head">
        <div className="panel-head-group">
          <span>{title}</span>
          {aux}
        </div>
        {right ? <div className="panel-head-group">{right}</div> : null}
      </div>
      {flush ? children : <div className="panel-content">{children}</div>}
    </section>
  );
}
