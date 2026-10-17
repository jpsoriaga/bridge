import { LOGO_MARK } from '@bridge/shared';

/** The Bridge mark. Inverts with the theme: ink tile on light, paper tile on dark. */
export function Logo({ size = 24 }: { size?: number }) {
  const { size: grid, radius, strokeWidth, paths } = LOGO_MARK;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${grid} ${grid}`} aria-hidden="true">
      <rect width={grid} height={grid} rx={radius} fill="var(--inverse-bg)" />
      <g
        fill="none"
        stroke="var(--inverse-fg)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
