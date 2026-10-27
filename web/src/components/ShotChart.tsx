/**
 * A half court in the league API's coordinates: tenths of a foot, the basket at (0, 0), x
 * across the court (-250 to 250), y from the baseline (-50) up the floor. Makes are filled,
 * misses hollow; threes carry an outline.
 */
interface Props {
  shots: [number, number, number, number][]; // [x, y, made, three]
  league: 'wnba' | 'nba';
  title: string;
}

export default function ShotChart({ shots, league, title }: Props) {
  const arc = league === 'nba' ? 237.5 : 221.5; // three-point radius in tenths of feet
  const cornerX = league === 'nba' ? 220 : 220;
  const cornerY = Math.sqrt(arc * arc - cornerX * cornerX); // where the straight corner meets the arc
  const made = shots.filter((s) => s[2] === 1).length;
  return (
    <figure>
      <svg
        viewBox="-260 -60 520 480"
        role="img"
        aria-label={`${title}: ${shots.length} shots, ${made} made`}
        className="mx-auto w-full max-w-md"
        data-testid="shot-chart"
      >
        <g fill="none" stroke="currentColor" strokeWidth="2" className="text-line" opacity="0.9">
          <rect x="-250" y="-50" width="500" height="470" />
          <rect x="-80" y="-50" width="160" height="190" />
          <circle cx="0" cy="140" r="60" />
          <circle cx="0" cy="0" r="7.5" />
          <line x1="-30" y1="-10" x2="30" y2="-10" />
          <path d={`M -40 -10 A 40 40 0 0 0 40 -10`} />
          <line x1={-cornerX} y1="-50" x2={-cornerX} y2={cornerY} />
          <line x1={cornerX} y1="-50" x2={cornerX} y2={cornerY} />
          <path d={`M ${-cornerX} ${cornerY} A ${arc} ${arc} 0 0 0 ${cornerX} ${cornerY}`} />
        </g>
        <g>
          {shots.map(([x, y, m, three], i) => (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={5}
              fill={m ? 'var(--accent)' : 'none'}
              stroke={three ? 'var(--fg)' : 'var(--accent)'}
              strokeWidth={three ? 2 : 1.5}
              opacity={0.85}
            />
          ))}
        </g>
      </svg>
      <figcaption className="mt-1 text-center text-xs text-muted">
        {shots.length} shots, {made} made. Filled: made. Dark outline: three.
      </figcaption>
    </figure>
  );
}
