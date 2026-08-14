/**
 * The competitor watchlist, with what the corpus observed set beside what the seed
 * file stated.
 *
 * The two disagree, and the disagreement is the useful part. The watchlist was authored
 * one spelling at a time, so a company appearing under several spellings can carry
 * several stated directions; rolling those spellings up onto one entity can change the
 * answer. `direction_changed_by_rollup` marks exactly the rows where it did.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, section, table, tiles } from '../components.js';
import { count, orAbsent, ABSENT } from '../format.js';
import { watchlist as watchlistRows } from '../queries.js';

function direction(value: string | null): ReturnType<typeof chip> | string {
  if (!value) return ABSENT;
  if (value === 'both') return chip('sky', 'both');
  if (value === 'we_sub_to_them') return chip('blocked', 'we sub to them');
  if (value === 'they_sub_to_us') return chip('pass', 'they sub to us');
  return chip('neutral', value);
}

export async function watchlist(ctx: Ctx): Promise<string> {
  const rows = await watchlistRows();
  const changed = rows.filter((r) => r.direction_changed_by_rollup).length;
  const multiSpelling = rows.filter((r) => Number(r.spelling_count ?? 0) > 1).length;

  const body = html`
    ${tiles([
      { label: 'Companies on the watchlist', value: count(rows.length) },
      {
        label: 'Under more than one spelling',
        value: count(multiSpelling),
        foot: 'Rolled up onto one entity',
      },
      {
        label: 'Direction changed by the rollup',
        value: count(changed),
        foot: changed === 0 ? 'Stated and observed agree everywhere' : 'Stated direction was incomplete',
      },
    ])}
    ${changed > 0
      ? html`<div class="notice">
          <h3>${count(changed)} row(s) read differently once the spellings were rolled up</h3>
          The watchlist was authored one spelling at a time. Where a company appears under several
          spellings, each carried its own stated direction, and the union of them is not always what
          any single row said. The observed column is computed from
          <code>subcontract_edge</code>; the stated column is what the seed file asserted.
        </div>`
      : ''}
    ${section(
      'Companies',
      table({
        columns: [
          {
            header: 'Company',
            cell: (r) =>
              r.entity_id
                ? html`<a href="/entities/${r.entity_id}">${r.canonical_name}</a>`
                : orAbsent(r.canonical_name),
          },
          { header: 'Spellings', align: 'num', cell: (r) => count(r.spelling_count) },
          { header: 'Astrion subbed to them', align: 'num', cell: (r) => count(r.times_astrion_subbed_to_them) },
          { header: 'They subbed to Astrion', align: 'num', cell: (r) => count(r.times_they_subbed_to_astrion) },
          { header: 'Observed', cell: (r) => direction(r.observed_relationship) },
          {
            header: 'Stated in the seed',
            cell: (r) =>
              r.stated_directions && r.stated_directions.length > 0
                ? html`${r.stated_directions.filter(Boolean).map((d) => html`${direction(d)} `)}`
                : ABSENT,
          },
          {
            header: 'Rollup',
            cell: (r) => (r.direction_changed_by_rollup ? chip('blocked', 'Changed') : chip('neutral', 'Agrees')),
          },
        ],
        rows,
        empty: emptyBecauseNoData('watchlist rows', 'npm run seed'),
      }),
      'Most-observed relationships first',
    )}
  `;

  return screen(ctx, {
    title: 'Competitor watchlist',
    intro:
      'Observed is computed from the subcontract corpus. Stated is what the authored seed file said. ' +
      'Where they disagree, the observed column is the one with evidence behind it.',
    body,
  });
}
