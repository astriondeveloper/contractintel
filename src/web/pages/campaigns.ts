/**
 * Campaigns: how big the market is, and what nobody is claiming.
 *
 * Spec section 11, and the two acceptance tests that were blocked on it. Test 9 wants TAM, SAM and
 * SOM with the sample size beside the capture rate; test 10 wants a gap report listing at least one
 * opportunity in no campaign.
 *
 * Three things this screen does that a market-sizing screen usually does not.
 *
 * **It shows the caveat before the figure.** TAM here is a floor: this corpus is Astrion's history
 * plus the watchlist competitors, not every federal dollar under these codes. That is the single most
 * quotable wrong number the system could produce, so it is stated above the number rather than in a
 * footnote, and it cannot be dismissed.
 *
 * **The capture rate never appears without its sample size.** They come from one view for that
 * reason. A rate over four awards and a rate over four hundred are different claims and a reader
 * given only the percentage cannot tell which they have.
 *
 * **A missing figure is missing, not zero.** A campaign that has named no offices has no served
 * market, so SAM and SOM read as not computed with a caveat naming what is absent. Falling back to
 * TAM would report an addressable figure under a served label, which is the kind of quiet
 * substitution nobody catches in a review.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, pager, table, tiles } from '../components.js';
import { ABSENT, count, day, moment, truncate, usd, usdCompact } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber } from '../params.js';
import {
  campaign as campaignById,
  campaignEvidence,
  campaignGap,
  campaignScope,
  campaigns as allCampaigns,
  gapSummary,
} from '../queries.js';
import { stageChip } from './feed.js';

function standingChip(standing: string): Html {
  if (standing === 'reasonable') return chip('pass', standing);
  if (standing === 'thin') return chip('blocked', standing);
  if (standing === 'not computed') return chip('neutral', standing);
  return chip('fail', standing);
}

/** A capture rate and its sample size, together and never apart. Acceptance test 9. */
function captureRate(
  rate: string | null,
  sample: number | null,
  standing: string,
): Html {
  if (rate === null) {
    return html`<span class="absent">not measurable</span>
      <span class="sub">${standing}</span>`;
  }
  return html`${(Number(rate) * 100).toFixed(1)}%
    <span class="sub">over ${count(sample ?? 0)} award(s) · ${standing}</span>`;
}

export async function campaignsScreen(ctx: Ctx): Promise<string> {
  const [rows, gap, gapPage] = await Promise.all([
    allCampaigns(),
    gapSummary(),
    campaignGap(PAGE_SIZE, offset(ctx.url)),
  ]);

  const sized = rows.filter((r) => r.sizing_computed_at !== null);
  const totalSam = sized.reduce((sum, r) => sum + Number(r.sam_usd ?? 0), 0);
  const totalSom = sized.reduce((sum, r) => sum + Number(r.som_usd ?? 0), 0);

  const headline = tiles([
    {
      label: 'Campaigns',
      value: count(rows.length),
      foot: `${count(sized.length)} sized`,
    },
    {
      label: 'Served market',
      value: totalSam === 0 ? ABSENT : usdCompact(totalSam),
      foot: 'SAM across every sized campaign. A floor, bounded by the corpus',
    },
    {
      label: 'At the observed capture rate',
      value: totalSom === 0 ? ABSENT : usdCompact(totalSom),
      foot: 'SOM. What the same performance against the same buyers is worth',
    },
    {
      label: 'Claimed by nobody',
      value: count(gap.total),
      foot: `${count(gap.matchable)} match a campaign that already exists`,
    },
    {
      label: 'Value in the gap',
      value: gap.value_usd === null ? ABSENT : usdCompact(gap.value_usd),
      foot:
        gap.without_value === 0
          ? 'Every unclaimed requirement carries a figure'
          : `A floor: ${count(gap.without_value)} carry no recorded value`,
    },
  ]);

  const sizingTable = table({
    columns: [
      {
        header: 'Campaign',
        cell: (r) =>
          html`<a href="/campaigns/${r.campaign_id}">${truncate(r.campaign_name, 46)}</a>
            <span class="sub"
              >${r.owner ? `${r.owner} · ` : ''}${count(r.codes)} code(s), ${count(r.offices)}
              office(s), ${count(r.requirements)} requirement(s)</span
            >`,
      },
      {
        header: 'Window',
        cell: (r) =>
          r.sizing_fy_from === null
            ? html`<span class="absent">not sized</span>`
            : html`FY${r.sizing_fy_from}–FY${r.sizing_fy_to}
                <span class="sub">${moment(r.sizing_computed_at)}</span>`,
      },
      { header: 'TAM', align: 'num', cell: (r) => usd(r.tam_usd) },
      { header: 'SAM', align: 'num', cell: (r) => usd(r.sam_usd) },
      { header: 'SOM', align: 'num', cell: (r) => usd(r.som_usd) },
      {
        header: 'Capture rate',
        cell: (r) => captureRate(r.capture_rate, r.capture_rate_sample_size, r.capture_rate_standing),
      },
      { header: 'Sample', cell: (r) => standingChip(r.capture_rate_standing) },
      {
        header: 'Caveats',
        align: 'num',
        cell: (r) =>
          Number(r.caveats) === 0
            ? html`<span class="sub">none</span>`
            : html`<a href="/campaigns/${r.campaign_id}">${count(r.caveats)}</a>`,
      },
    ],
    rows,
    empty: html`<strong>No campaign is defined.</strong><br>
      A campaign is a set of capability areas plus the offices that buy them, and it is what turns a
      pile of requirements into a market you can size. BD Ops defines one:<br>
      <code
        >npm run campaign -- --create "Flight test" --nodes CAP-01 --offices 9700/FA8601 --actor
        &lt;you&gt;</code
      >`,
  });

  const gapTable = table({
    columns: [
      { header: 'Stage', cell: (r) => stageChip(r.signal_class) },
      {
        header: 'Requirement',
        cell: (r) =>
          html`<a href="/requirements/${r.pursuit_id}">${truncate(r.title, 58)}</a>
            <span class="sub"
              >${r.agency_label ?? r.agency_code ?? 'agency unrecorded'}
              ${r.naics_code ? html` · NAICS ${r.naics_code}` : ''}
              ${r.psc_code ? html` · PSC ${r.psc_code}` : ''}</span
            >`,
      },
      { header: 'Value', align: 'num', cell: (r) => usd(r.estimated_value) },
      {
        header: 'Due',
        cell: (r) =>
          r.response_date !== null
            ? html`${day(r.response_date)}<span class="sub">responses due</span>`
            : r.period_end_date !== null
              ? html`${day(r.period_end_date)}<span class="sub">contract ends</span>`
              : ABSENT,
      },
      {
        header: 'Would fit',
        cell: (r) =>
          r.would_match !== null
            ? html`${truncate(r.would_match, 44)}
                <span class="sub">on a code match, nobody has claimed it</span>`
            : r.uncodeable
              ? html`<span class="absent">no codes</span>
                  <span class="sub">no campaign could claim it on codes alone</span>`
              : html`<span class="absent">no campaign</span>
                  <span class="sub">its codes match nothing defined</span>`,
      },
    ],
    rows: gapPage.rows,
    empty: html`<strong>Every requirement is in a campaign.</strong><br>
      Worth checking rather than celebrating: it also happens when only one campaign exists and it
      claims everything.`,
  });

  const body = html`
    ${headline}
    <div class="notice">
      <h3>TAM here is a floor, not a total addressable market</h3>
      This corpus holds Astrion's own history and the watchlist competitors, not every dollar every
      agency spent under these codes, and the difference is not derivable from what is here. Read TAM
      as "the market this corpus can see". SAM is the sounder figure, because a campaign that names
      its offices has said where it competes.
    </div>
    <div class="section">
      <div class="section-head">
        <h2>Sizing</h2>
        <div class="hint">
          The capture rate is measured, not assumed, and its sample size is beside it. Spec 11.2
        </div>
      </div>
      ${sizingTable}
    </div>
    <div class="section">
      <div class="section-head">
        <h2>The gap report</h2>
        <div class="hint">
          ${count(gap.total)} requirement(s) no campaign claims, largest first
        </div>
      </div>
      ${gapTable}
      ${pager({
        page: pageNumber(ctx.url),
        pageSize: PAGE_SIZE,
        total: gapPage.total,
        baseQuery: baseQuery(ctx.url),
      })}
    </div>
  `;

  return screen(ctx, {
    title: 'Campaigns',
    intro:
      'How big the market is in each area Astrion competes in, and which requirements no campaign ' +
      'has claimed. Every figure is derived from the corpus and carries what it is not.',
    body,
    suppressEmptyNotice: true,
  });
}

/** One campaign, its scope, and the reasoning behind each figure. */
export async function campaignDetail(ctx: Ctx, campaignId: string): Promise<string | null> {
  const record = await campaignById(campaignId);
  if (record === null) return null;

  const [evidence, scope] = await Promise.all([
    campaignEvidence(campaignId),
    campaignScope(campaignId),
  ]);

  const caveats = evidence.filter((e) => !e.supports);
  const supporting = evidence.filter((e) => e.supports);

  const figures = tiles([
    {
      label: 'TAM',
      value: usd(record.tam_usd),
      foot: 'A floor: the market this corpus can see, not the federal total',
    },
    {
      label: 'SAM',
      value: usd(record.sam_usd),
      foot:
        record.sam_usd === null
          ? 'No offices named, so there is no served market'
          : `Restricted to ${count(record.offices)} office(s)`,
    },
    {
      label: 'SOM',
      value: usd(record.som_usd),
      foot: 'SAM at the observed capture rate. Not a target',
    },
    {
      label: 'Capture rate',
      value:
        record.capture_rate === null
          ? ABSENT
          : `${(Number(record.capture_rate) * 100).toFixed(1)}%`,
      // Spec 11.2: the sample size sits with the rate wherever the rate appears.
      foot: `Over ${count(record.capture_rate_sample_size ?? 0)} award(s) · ${record.capture_rate_standing}`,
    },
    {
      label: 'Window',
      value: record.sizing_fy_from === null ? ABSENT : `FY${record.sizing_fy_from}–FY${record.sizing_fy_to}`,
      foot:
        record.sizing_computed_at === null
          ? 'Never sized. Run npm run size'
          : `Computed ${moment(record.sizing_computed_at)}`,
    },
    {
      label: 'Requirements',
      value: count(record.requirements),
      foot: 'Claimed by this campaign',
      href: `/feed?view=everything`,
    },
  ]);

  const evidenceTable = (rows: typeof evidence, empty: string) =>
    table({
      columns: [
        { header: 'Figure', cell: (r) => chip('neutral', r.figure) },
        { header: 'Rule', cell: (r) => html`<code>${r.rule_id}</code>` },
        { header: 'What it says', cell: (r) => r.detail },
      ],
      rows,
      empty: html`<strong>${empty}</strong>`,
    });

  const scopeCards = cards([
    card({
      title: 'Capability areas',
      hint: `${scope.nodes.length}`,
      body:
        scope.nodes.length === 0
          ? html`<div class="empty">
              No capability node, so no codes, so nothing to size against. Attach one with
              <code>npm run campaign -- --id ${campaignId} --add-nodes CAP-01 --actor &lt;you&gt;</code>.
            </div>`
          : html`${scope.nodes.map(
              (node) => html`<div class="feed">
                <div class="top">
                  ${chip('sky', node.node_key)}
                  <span class="headline">${truncate(node.node_name, 52)}</span>
                </div>
              </div>`,
            )}`,
    }),
    card({
      title: 'Where it competes',
      hint: `${scope.offices.length} office(s)`,
      body:
        scope.offices.length === 0
          ? html`<div class="empty">
              No offices named. Without them this campaign has no served market, which is why SAM and
              SOM read as not computed rather than falling back to TAM.
            </div>`
          : html`${scope.offices.map(
              (office) => html`<div class="feed">
                <div class="top">
                  <span class="headline"
                    >${truncate(office.office_label ?? office.office_code, 44)}</span
                  >
                </div>
                <div class="meta">
                  <span>${office.agency_label ?? office.agency_code}</span>
                  <span><code>${office.agency_code}/${office.office_code}</code></span>
                </div>
              </div>`,
            )}`,
    }),
    card({
      title: 'Codes it sizes against',
      hint: `${scope.codes.length}`,
      body:
        scope.codes.length === 0
          ? html`<div class="empty">
              Its capability nodes carry no NAICS or PSC crosswalks, so there is nothing to size
              against. Fill them in on the capability, not here.
            </div>`
          : html`${scope.codes.map(
              (code) => html`<div class="feed">
                <div class="top">
                  ${chip('neutral', code.code_type)}
                  <span class="headline"><code>${code.code_value}</code></span>
                </div>
                ${code.label ? html`<div class="meta"><span>${code.label}</span></div>` : ''}
              </div>`,
            )}`,
    }),
  ]);

  const body = html`
    ${figures}
    <div class="section">
      <div class="section-head">
        <h2>What these figures are not</h2>
        <div class="hint">Caveats first, and none of them can be turned off</div>
      </div>
      ${evidenceTable(caveats, 'Nothing is caveated, which on a market figure is worth double-checking.')}
    </div>
    ${scopeCards}
    <div class="section">
      <div class="section-head">
        <h2>How each figure was computed</h2>
      </div>
      ${evidenceTable(supporting, 'No sizing has been computed. Run npm run size.')}
    </div>
  `;

  return screen(ctx, {
    title: truncate(record.campaign_name, 80),
    intro:
      record.sizing_computed_at === null
        ? 'Never sized. Run npm run size, and every figure below fills in with the reasoning behind it.'
        : `Sized over FY${record.sizing_fy_from} to FY${record.sizing_fy_to} from ${count(record.codes)} code(s) ` +
          `across ${count(record.offices)} office(s). Every figure opens the arithmetic behind it.`,
    body,
    actions: html`<a class="button quiet" href="/campaigns">Back to campaigns</a>`,
    suppressEmptyNotice: true,
  });
}

/** The same figures as JSON, for a status check or a note to leadership. */
export async function campaignsJson(): Promise<unknown> {
  const [rows, gap] = await Promise.all([allCampaigns(), gapSummary()]);
  return {
    // Named so a reader of the JSON cannot miss what a reader of the screen is told.
    tam_is_a_floor:
      'TAM is bounded by what this corpus contains, which is Astrion history plus watchlist ' +
      'competitors rather than the whole federal market.',
    campaigns: rows,
    gap,
  };
}
