/** The player page's status strip: the current injury, the team's next games and ESPN's headlines. */
import { day, fmt, lineSource } from '../lib/format';
import type { PlayerFile, Upcoming } from '../lib/player-file';
import { crewText } from '../lib/referees';
import { Badge, Card, Td, Th } from './ui';

/** The team's next games: opponent, the line's implied points, and the second night of a back-to-back. */
export function NextGames({ games, teamId }: { games: Upcoming[]; teamId: string }) {
  const next = games.filter((g) => g.home_team_id === teamId || g.away_team_id === teamId).slice(0, 7);
  if (!next.length) return null;
  return (
    <Card title="Next games" id="next-games">
      <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Next games">
        <table className="w-full text-sm" data-testid="next-games">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Opponent</Th>
              <Th right>Team pts</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {next.map((g) => {
              const home = g.home_team_id === teamId;
              const implied = home ? g.home_implied_points : g.away_implied_points;
              const b2b = home ? g.home_back_to_back : g.away_back_to_back;
              const note = [b2b ? 'Back-to-back' : null, g.game_type !== 'regular' ? g.game_type.replace('_', ' ') : null, crewText(g)]
                .filter(Boolean)
                .join(' · ');
              return (
                <tr key={g.game_id} className="border-t border-line">
                  <Td>{day(g.game_date)}</Td>
                  <Td>{home ? `vs ${g.away_team_tricode}` : `at ${g.home_team_tricode}`}</Td>
                  <Td right>
                    {typeof implied === 'number' ? (
                      <span title={`Points the betting line implies${lineSource(g.line_provider, g.line_as_of) ? ` (${lineSource(g.line_provider, g.line_as_of)})` : ''}`} data-testid="implied">
                        {fmt(implied)}
                      </span>
                    ) : (
                      '–'
                    )}
                  </Td>
                  <Td>{note}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Team pts: the points the betting line implies the team scores, where a line is posted. The referee crew shows once the
        league posts it, on the day; its tendency is context only, not in the value.
      </p>
    </Card>
  );
}

/** What a headline's wording says, and how loudly to show it. */
const NEWS_FLAGS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  out_for_season: { label: 'Out for season', tone: 'bad' },
  surgery: { label: 'Surgery', tone: 'bad' },
  injury: { label: 'Injury', tone: 'warn' },
  minutes_limit: { label: 'Minutes limit', tone: 'warn' },
  return: { label: 'Return', tone: 'good' },
  g_league: { label: 'G League', tone: 'muted' },
  role: { label: 'Role', tone: 'muted' },
};

/** ESPN's headlines about the player, newest first: each links to the story on ESPN. */
export function NewsCard({ news }: { news: NonNullable<PlayerFile['news']> }) {
  return (
    <Card title="In the news" id="news">
      <ul className="grid gap-1.5 text-sm" data-testid="player-news">
        {news.map((n) => {
          const flag = n.news_flag ? NEWS_FLAGS[n.news_flag] : undefined;
          return (
            <li key={n.url} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs text-muted">{day(n.published_date)}</span>
              {flag && <Badge tone={flag.tone}>{flag.label}</Badge>}
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                {n.headline}
              </a>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">Headlines and links from ESPN; the stories are on ESPN.</p>
    </Card>
  );
}

/** The player's current injury: status, since when, expected return, ESPN's news, and how the status got here. */
export function InjuryCard({
  board,
  history,
}: {
  board: NonNullable<PlayerFile['board']>;
  history: NonNullable<PlayerFile['injury_history']>;
}) {
  const tone = board.injury_group === 'out' ? 'bad' : 'warn';
  // ESPN's note is sometimes the status again ("out"); a line that says nothing new is left out (#460).
  const raw = (board.injury_news || board.injury_note || '').trim();
  const note = raw && raw.toLowerCase() !== (board.injury_status ?? '').trim().toLowerCase() ? raw : null;
  return (
    <Card title="Injury" id="injury">
      <div className="grid gap-2 text-sm" data-testid="injury-card">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{board.injury_status ?? 'Injured'}</Badge>
          {board.injury_type && <span>{board.injury_type}</span>}
          {board.injury_since && <span className="text-muted">since {day(board.injury_since)}</span>}
          {board.expected_return && (
            <span className="text-muted" data-testid="expected-return">
              · expected back {board.season_complete ? `next season (${day(board.expected_return)})` : day(board.expected_return)}
            </span>
          )}
        </p>
        {note && <p data-testid="injury-news">{note}</p>}
        {history.length > 1 && (
          <ol className="grid gap-0.5 text-xs text-muted" data-testid="injury-history">
            {history.map((h) => (
              <li key={`${h.injury_id}-${h.status_from}`}>
                {h.status}: {day(h.status_from)}
                {h.status_to !== h.status_from ? ` to ${day(h.status_to)}` : ''}
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted">
          {board.injury_source === 'official' && board.official_game_date
            ? `From the league's official injury report for ${day(board.official_game_date)}; the history is ESPN's daily listing.`
            : "From ESPN's daily injury listing."}
        </p>
      </div>
    </Card>
  );
}
