const glyphs = {
  play: 'M3 1h2v2h2v2h2v2h2v2H9v2H7v2H5v2H3z',
  pause: 'M3 2h3v12H3zM10 2h3v12h-3z',
  export: 'M7 1h2v6h3v2h-2v2H6V9H4V7h3zM2 10h2v3h8v-3h2v5H2z',
  sun: 'M7 0h2v3H7zM7 13h2v3H7zM0 7h3v2H0zM13 7h3v2h-3zM2 2h2v2H2zM12 2h2v2h-2zM2 12h2v2H2zM12 12h2v2h-2zM5 5h6v6H5z',
  moon: 'M6 1h5v2H8v2H7v4h2v2h2v1h3v2h-3v1H6v-1H4v-2H2V5h2V3h2z',
};

export function PixelIcon({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg className="pixel-icon" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d={glyphs[name]} />
    </svg>
  );
}
