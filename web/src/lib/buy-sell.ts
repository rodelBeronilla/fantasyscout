/**
 * Buy low, sell high (#739): the players whose recent form has drifted far from their projection,
 * where the league's managers, who mostly see the recent box scores, price them wrong. A player of
 * yours running well above the projection sells high; a healthy player elsewhere slumping below a
 * projection good enough to start for you buys low. Values are per game above replacement under
 * the league's scoring: the projection against the last ten games' form, both on the same scale.
 */
import { PARAMS } from '../generated/parameters';
export interface FormSwing {
  id: string;
  /** The team that has the player, by index. */
  team: number;
  /** Value per game, projected. */
  projected: number;
  /** Value per game over the last ten games. */
  recent: number;
  /** Recent minus projected: positive is a hot run, negative a slump. */
  form: number;
}

export interface BuySellInput {
  mine: number;
  /** Which team holds each rostered player. */
  owner: Map<string, number>;
  projected: (id: string) => number;
  recent: (id: string) => number;
  /** Not listed out or doubtful: an injury explains a slump, and is no discount. */
  healthy: (id: string) => boolean;
  /** The projected value per game a player needs to start for the manager (their median starter's). */
  startLine: number;
  /** The least swing, in value per game, that counts. */
  minSwing?: number;
  limit?: number;
}

const SHOWN = 6; // display: rows each list shows

export function buySell({ mine, owner, projected, recent, healthy, startLine, minSwing = PARAMS['buysell.min_swing'], limit = SHOWN }: BuySellInput): {
  buyLow: FormSwing[];
  sellHigh: FormSwing[];
} {
  const swings = [...owner].map(([id, team]) => {
    const p = projected(id);
    const r = recent(id);
    return { id, team, projected: p, recent: r, form: r - p };
  });
  const sellHigh = swings
    .filter((s) => s.team === mine && s.form >= minSwing)
    .sort((a, b) => b.form - a.form)
    .slice(0, limit);
  const buyLow = swings
    .filter((s) => s.team !== mine && s.form <= -minSwing && s.projected >= startLine && healthy(s.id))
    // the best projection first: the slump is the discount, the projection the reason to buy
    .sort((a, b) => b.projected - a.projected)
    .slice(0, limit);
  return { buyLow, sellHigh };
}
