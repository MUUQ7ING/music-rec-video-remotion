import { useState, type ReactNode } from 'react';

export interface SafeImageProps {
  src?: string;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}

export function SafeImage({
  src,
  alt = '',
  className,
  fallback = null,
}: SafeImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
    />
  );
}
