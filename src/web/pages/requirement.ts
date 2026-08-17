/**
 * One requirement: what it is, why it is in your feed, why it scored what it did, and how to get
 * it into TechnoMile.
 *
 * This replaces the pursuit screen and keeps everything on it that was about the requirement,
 * because that part was right: acceptance test 7 asks that every score open a rule trace with a
 * source link, and it still does. What went is the working state. There is no owner, no funnel
 * state and no snooze, because none of those belong to a tool that feeds a system of record.
 *
 * What arrived is the hand-off panel, and it is the point of the screen. Three per-person actions
 * along the top, and below them the four shapes of hand-off: a field block to select and copy, a
 * written paragraph, the SAM.gov link, and a spreadsheet export. The panel is not tucked at the
 * bottom: carrying a requirement across is the outcome this tool exists to produce, and the count
 * of times somebody did it is the only measure of whether it earns its place.
 *
 * Three things it still refuses to do, unchanged.
 *
 * **It does not merge the four score outputs.** Strategic fit, evidence confidence, timing urgency
 * and coverage are four different questions (spec 10.1) and folding them into one number is how a
 * figure stops meaning anything.
 *
 * **It does not hide contrary evidence.** Evidence arguing against the score is shown first. A
 * reader who only ever sees supporting evidence stops believing the supporting evidence.
 *
 * **It does not show a score behind a failed gate.** A blocked requirement shows the gate and the
 * reason, and there is no score because the engine did not compute one.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, fields, section, table, tiles } from '../components.js';
import { day, moment, orAbsent, since, truncate, usd, ABSENT } from '../format.js';
import {
  actionState,
  currentAssessment,
  evidenceFor,
  factorResults,
  gateResults,
  handoffRows,
  notesFor,
  othersOn,
  profileMatches,
  pursuitDetail,
  recentActivity,
  whyInFeed,
  type EvidenceRow,
} from '../queries.js';
import { handoffBlock, handoffFields, handoffSummary } from '../handoff.js';
import { flashFrom, positionChip, stageChip } from './feed.js';

function scoreStateChip(state: string): Html {
  if (state === 'scored' || state === 'pass') return chip('pass', state);
  if (state === 'fail') return chip('fail', state);
  if (state === 'review') return chip('blocked', state);
  if (state === 'not_applicable') return chip('neutral', 'not applicable');
  if (state === 'not_evaluated') return chip('blocked', 'not evaluated');
  return chip('sky', state);
}

function evidenceList(rows: readonly EvidenceRow[]): Html {
  if (rows.length === 0) return html`<span class="sub">No evidence recorded.</span>`;
  return html`${rows.map(
    (row) => html`<span class="sub"
      >${row.is_contrary ? chip('fail', 'against') : ''}
      ${row.source_uri
        ? html`<a href="${row.source_uri}" rel="noreferrer">${orAbsent(row.displayed_value ?? row.source_system)}</a>`
        : orAbsent(row.displayed_value ?? row.source_system)}
      <code>${row.source_system}</code></span
    >`,
  )}`;
}

export async function requirement(ctx: Ctx, pursuitId: string): Promise<string | null> {
  const record = await pursuitDetail(pursuitId);
  if (record === null) return null;

  const principal = ctx.user?.principalName ?? '';
  const assessment = await currentAssessment(pursuitId);
  const [factors, gates, evidence, matches, notes, history, mine, others, why, handoff] =
    await Promise.all([
      assessment ? factorResults(assessment.assessment_id) : Promise.resolve([]),
      assessment ? gateResults(assessment.assessment_id) : Promise.resolve([]),
      assessment ? evidenceFor(assessment.assessment_id) : Promise.resolve([]),
      profileMatches(pursuitId),
      notesFor(pursuitId),
      recentActivity(20, pursuitId),
      actionState(pursuitId, principal),
      othersOn(pursuitId, principal),
      principal === '' ? Promise.resolve([]) : whyInFeed(pursuitId, principal),
      handoffRows([pursuitId]),
    ]);

  const signedIn = ctx.user !== null;
  const post = (action: string) => `/requirements/${pursuitId}/${action}`;
  const returnTo = `${ctx.url.pathname}`;
  const handoffRow = handoff[0] ?? null;

  /**
   * The three actions.
   *
   * Every one is a form POST rather than a link, because a link that changes something is a change
   * a browser will make on its own while prefetching, and each of these writes an audit row.
   * Nothing is shown as disabled-but-present when nobody is signed in: the bar is replaced by the
   * reason, so it is obvious why rather than mysteriously inert.
   */
  const actionBar = signedIn
    ? html`${mine.tracked
          ? html`<form method="post" action="${post('clear')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Tracking ✓ — stop</button>
            </form>`
          : html`<form method="post" action="${post('track')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Track</button>
            </form>`}
        ${mine.dismissed
          ? html`<form method="post" action="${post('clear')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Dismissed ✓ — put it back</button>
            </form>`
          : html`<form method="post" action="${post('dismiss')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Dismiss</button>
            </form>`}
        ${mine.sent
          ? html`<form method="post" action="${post('unsent')}">
              <input type="hidden" name="back" value="${returnTo}">
              <span class="chip pass">Sent ${day(mine.sentAt)}</span>
              <button class="danger" type="submit">Undo</button>
            </form>`
          : html`<a class="button" href="#handoff">Hand off to TechnoMile</a>`}`
    : html`<span class="state-pill">Read only · sign in to track or hand off</span>`;

  const summary = fields([
    { label: 'Stage', value: stageChip(record.signal_class) },
    {
      label: 'Our position',
      value:
        record.astrion_position === null
          ? ABSENT
          : html`${positionChip(record.astrion_position)} ${record.astrion_position}`,
    },
    { label: 'Agency', value: orAbsent(record.agency_label ?? record.agency_code) },
    { label: 'Office', value: record.office_code ? html`<code>${record.office_code}</code>` : ABSENT },
    {
      label: 'Solicitation',
      value: record.solicitation_number ? html`<code>${record.solicitation_number}</code>` : ABSENT,
    },
    { label: 'Contract', value: record.related_piid ? html`<code>${record.related_piid}</code>` : ABSENT },
    { label: 'Notice type', value: orAbsent(record.notice_type) },
    { label: 'NAICS', value: record.naics_code ? html`<code>${record.naics_code}</code>` : ABSENT },
    { label: 'PSC', value: record.psc_code ? html`<code>${record.psc_code}</code>` : ABSENT },
    { label: 'Set aside', value: orAbsent(record.set_aside_code) },
    { label: 'Estimated value', value: usd(record.estimated_value) },
    { label: 'Posted', value: day(record.posted_date) },
    { label: 'Responses due', value: day(record.response_date) },
    { label: 'Contract ends', value: day(record.period_end_date) },
    {
      label: 'Incumbent',
      value: record.incumbent_entity_id
        ? html`<a href="/entities/${record.incumbent_entity_id}">${record.incumbent_name}</a>
            ${record.incumbent_confidence ? html` <span class="sub">${record.incumbent_confidence}</span>` : ''}`
        : ABSENT,
    },
    {
      label: 'Source',
      value: record.notice_url
        ? html`<a href="${record.notice_url}" rel="noreferrer">Open the notice on SAM.gov</a>`
        : orAbsent(record.generated_by),
    },
  ]);

  /* ---------------------------------------------------------- hand-off panel */

  const handoffPanel =
    handoffRow === null
      ? html``
      : html`<div class="section" id="handoff">
          <div class="section-head">
            <h2>Hand off to TechnoMile</h2>
            <div class="hint">
              By hand, on purpose. TechnoMile is the system of record and this feeds it
            </div>
          </div>
          <div class="handoff">
            <div class="handoff-block">
              <h3>The fields</h3>
              <p class="sub">
                Click the box to select all of it, or take one line at a time. Codes carry their
                labels, because a record that says <code>6920</code> will say
                <code>6920</code> for ever.
              </p>
              <textarea readonly rows="24" class="copyable" onclick="this.select()"
                aria-label="Field block to copy"
>${handoffBlock(handoffRow)}</textarea
              >
            </div>
            <div class="handoff-block">
              <h3>The written summary</h3>
              <p class="sub">
                For a description field or an email. Assembled from the fields above, so it cannot
                say anything they do not.
              </p>
              <textarea readonly rows="8" class="copyable" onclick="this.select()"
                aria-label="Written summary to copy"
>${handoffSummary(handoffRow)}</textarea
              >
              <h3 style="margin-top:14px">The source</h3>
              ${record.notice_url
                ? html`<p>
                    <a href="${record.notice_url}" rel="noreferrer">${record.notice_url}</a>
                  </p>`
                : html`<p class="sub">
                    No SAM.gov link. This one came from
                    <code>${orAbsent(record.generated_by)}</code> rather than a notice, so there is
                    no public page to point at yet.
                  </p>`}
              <h3 style="margin-top:14px">The spreadsheet</h3>
              <p>
                <a class="button quiet" href="/export.csv?id=${pursuitId}">Download this one as CSV</a>
                <a class="button quiet" href="/feed?view=tracked">Export several from the feed</a>
              </p>
            </div>
          </div>
          ${signedIn
            ? html`<form class="mark-sent" method="post" action="${post('sent')}">
                <input type="hidden" name="back" value="${returnTo}">
                <input
                  type="text"
                  name="note"
                  placeholder="Optional: the TechnoMile record, or a word about what you did"
                  aria-label="Note"
                >
                <button type="submit"${mine.sent ? html` disabled` : ''}>
                  ${mine.sent ? 'Already marked as sent' : 'Mark as sent to TechnoMile'}
                </button>
                <div class="sub">
                  This is the number that answers whether this tool is working. It is not cleared by
                  tracking or dismissing, and undoing it is its own action with its own audit row.
                </div>
              </form>`
            : ''}
        </div>`;

  /* ------------------------------------------------------------------- score */

  const byFactor = new Map<string, EvidenceRow[]>();
  const byGate = new Map<string, EvidenceRow[]>();
  for (const row of evidence) {
    if (row.factor_code) {
      byFactor.set(row.factor_code, [...(byFactor.get(row.factor_code) ?? []), row]);
    } else if (row.gate_code) {
      byGate.set(row.gate_code, [...(byGate.get(row.gate_code) ?? []), row]);
    }
  }

  const scoreTiles = assessment
    ? tiles([
        {
          label: 'Band',
          value:
            assessment.band === 'insufficient_evidence'
              ? 'No rank'
              : (assessment.band ?? ABSENT).replace(/^./, (c) => c.toUpperCase()),
          foot: `Score model v${assessment.score_model_version}, taxonomy v${assessment.taxonomy_version}`,
        },
        {
          label: 'Strategic fit',
          value: assessment.strategic_fit === null ? ABSENT : Number(assessment.strategic_fit).toFixed(1),
          foot: 'Not a probability of win. Spec 10.1',
        },
        {
          label: 'Evidence confidence',
          value:
            assessment.evidence_confidence === null
              ? ABSENT
              : Number(assessment.evidence_confidence).toFixed(0),
          foot: 'How far the sources can be relied on',
        },
        {
          label: 'Timing urgency',
          value: assessment.timing_urgency === null ? ABSENT : Number(assessment.timing_urgency).toFixed(0),
          foot: 'Separate from fit, never folded in',
        },
        {
          label: 'Coverage',
          value:
            assessment.coverage === null ? ABSENT : `${(Number(assessment.coverage) * 100).toFixed(0)}%`,
          foot:
            assessment.known_weight === null
              ? 'Not computed behind a failed gate'
              : `${Number(assessment.known_weight)} of ${Number(assessment.applicable_weight)} applicable weight answered`,
        },
        {
          label: 'Assessed',
          value: moment(assessment.computed_at),
          foot: `Eligibility: ${assessment.eligibility}`,
        },
      ])
    : html``;

  const gateTable = table({
    columns: [
      { header: 'Gate', cell: (r) => orAbsent(r.gate_name ?? r.gate_code) },
      { header: 'State', cell: (r) => scoreStateChip(r.state) },
      {
        header: 'Reason',
        cell: (r) =>
          html`${orAbsent(r.reason)}
            ${byGate.has(r.gate_code) ? evidenceList(byGate.get(r.gate_code)!) : ''}`,
      },
      { header: 'Rule', cell: (r) => html`<code>${r.rule_id}</code>` },
    ],
    rows: gates,
    empty: html`<strong>No gate was evaluated.</strong>`,
  });

  const factorTable = table({
    columns: [
      { header: 'Factor', cell: (r) => orAbsent(r.factor_name ?? r.factor_code) },
      { header: 'State', cell: (r) => scoreStateChip(r.state) },
      { header: 'Score', align: 'num', cell: (r) => (r.score === null ? ABSENT : Number(r.score).toFixed(0)) },
      {
        header: 'Weight',
        align: 'num',
        cell: (r) => (r.weight_applied === null ? ABSENT : Number(r.weight_applied).toFixed(0)),
      },
      {
        header: 'Contribution',
        align: 'num',
        cell: (r) => (r.contribution === null ? ABSENT : Number(r.contribution).toFixed(0)),
      },
      {
        header: 'Why',
        cell: (r) =>
          html`${truncate(r.summary, 150)}
            ${byFactor.has(r.factor_code) ? evidenceList(byFactor.get(r.factor_code)!) : ''}`,
      },
      { header: 'Rule', cell: (r) => html`<code>${r.rule_id}</code>` },
    ],
    rows: factors,
    empty:
      assessment?.band === 'blocked'
        ? html`<strong>No factor was evaluated, because a hard gate failed.</strong><br>
            A failed gate shows no score at all rather than a low one, so there was nothing to
            compute. Spec section 3, acceptance test 5.`
        : html`<strong>No factor result.</strong>`,
  });

  const contrary = evidence.filter((row) => row.is_contrary);

  /* -------------------------------------------------------------- awareness */

  const workCards = cards([
    card({
      title: 'Why this is in your feed',
      hint: why.length === 0 ? 'Not in your patch' : `${why.length} follow(s)`,
      body:
        why.length === 0
          ? html`<div class="empty">
              None of your follows matched this one, so it did not appear in your feed. You either
              found it by searching or somebody sent you the link.
              <a href="/follows">Follow the office or the capability</a> if you want the next one.
            </div>`
          : html`${why.map(
              (row) => html`<div class="feed">
                <div class="top">
                  ${chip('sky', row.follow_type)}
                  <span class="headline">${truncate(row.label ?? row.matched_value, 48)}</span>
                </div>
                <div class="meta">
                  <span>matched on ${row.matched_field}</span>
                  ${row.matched_value ? html`<span><code>${row.matched_value}</code></span>` : ''}
                </div>
              </div>`,
            )}`,
    }),
    card({
      title: 'Who else has looked at this',
      hint: 'Awareness, not ownership',
      body:
        others.length === 0
          ? html`<div class="empty">
              Nobody else has tracked, dismissed or handed this off. That is not a claim on it:
              nothing here is assigned.
            </div>`
          : html`${others.map(
              (row) => html`<div class="feed">
                <div class="top">
                  ${row.action === 'sent'
                    ? chip('pass', 'sent to TechnoMile')
                    : row.action === 'track'
                      ? chip('sky', 'tracking')
                      : chip('neutral', 'dismissed')}
                  <span class="headline">${row.display_name ?? row.principal_name}</span>
                </div>
                <div class="meta"><span>${since(row.acted_at)}</span></div>
              </div>`,
            )}`,
    }),
    card({
      title: 'Notes',
      hint: `${notes.length}`,
      body: html`${signedIn
          ? html`<div class="note">
              <form method="post" action="/requirements/${pursuitId}/note">
                <input type="hidden" name="back" value="${returnTo}">
                <textarea name="body" placeholder="What did you learn? What happens next?" aria-label="Note"></textarea>
                <div class="actions" style="margin-top:8px"><button type="submit">Add note</button></div>
              </form>
            </div>`
          : ''}
        ${notes.length === 0 && !signedIn
          ? html`<div class="empty">No notes yet.</div>`
          : notes.map(
              (note) => html`<div class="note">
                <div class="who">${note.author} · ${since(note.created_at)}</div>
                <div class="body">${note.body}</div>
              </div>`,
            )}`,
    }),
    card({
      title: 'History',
      hint: 'Every change, from the audit log',
      body:
        history.length === 0
          ? html`<div class="empty">
              Nothing has been changed yet. Tracking this, dismissing it or marking it sent writes
              an audit row and it appears here.
            </div>`
          : html`${history.map(
              (row) => html`<div class="feed">
                <div class="top"><span class="headline">${orAbsent(row.reason ?? row.action)}</span></div>
                <div class="meta"><span>${row.actor}</span><span>${since(row.occurred_at)}</span></div>
              </div>`,
            )}`,
    }),
  ]);

  const body = html`
    ${mine.dismissed
      ? html`<div class="notice">
          <h3>You have dismissed this</h3>
          It is out of your feed and reachable from the dismissed view. Nothing was deleted, and
          nobody else's feed was affected.
        </div>`
      : ''}
    ${summary}
    ${handoffPanel}
    ${workCards}
    ${assessment === null
      ? html`<div class="notice">
          <h3>This requirement has not been assessed</h3>
          Scoring is a scheduled job rather than something a page load does. Run
          <code>npm run score</code>.
        </div>`
      : scoreTiles}
    ${assessment && assessment.status === 'insufficient_evidence'
      ? html`<div class="notice">
          <h3>No rank, and that is a statement about the evidence rather than the opportunity</h3>
          Either a mandatory factor could not be answered or coverage fell below the floor. The
          factor table below says which. A rank computed from too little would be a confident number
          resting on nothing.
        </div>`
      : ''}
    ${section('Hard gates', gateTable, 'A gate stops a requirement. A score cannot override one')}
    ${section(
      'Factors',
      factorTable,
      assessment
        ? `Contribution is score times weight. The denominator is the applicable weight, ${
            assessment.applicable_weight === null
              ? 'not computed'
              : Number(assessment.applicable_weight).toFixed(0)
          }, not the known weight`
        : undefined,
    )}
    ${contrary.length > 0
      ? section(
          'Evidence against',
          table({
            columns: [
              { header: 'Against', cell: (r) => orAbsent(r.factor_code ?? r.gate_code) },
              {
                header: 'What it says',
                cell: (r) =>
                  r.source_uri
                    ? html`<a href="${r.source_uri}" rel="noreferrer">${orAbsent(r.displayed_value)}</a>`
                    : orAbsent(r.displayed_value),
              },
              { header: 'Source', cell: (r) => html`<code>${r.source_system}</code>` },
            ],
            rows: contrary,
            empty: html``,
          }),
          'Shown, never hidden. Spec 14.2',
        )
      : ''}
    ${matches.length > 0
      ? section(
          'Why this was pulled from SAM.gov',
          table({
            columns: [
              { header: 'Matched on', cell: (r) => chip('neutral', r.matched_on) },
              { header: 'Code', cell: (r) => html`<code>${r.code_value}</code>` },
              { header: 'Capability', cell: (r) => orAbsent(r.label) },
              { header: 'Origin', cell: (r) => chip('sky', r.origin) },
            ],
            rows: matches,
            empty: html``,
          }),
          'The opportunity profile rows that caused this notice to be fetched at all',
        )
      : ''}
  `;

  return screen(ctx, {
    title: truncate(record.title, 90),
    intro:
      assessment === null
        ? 'Not yet assessed. The hand-off panel works either way.'
        : `Assessed under score model v${assessment.score_model_version}. Every figure opens the rows behind it.`,
    body,
    actions: actionBar,
    suppressEmptyNotice: true,
    flash: flashFrom(ctx),
  });
}

/** The field block as plain text, for a person who wants only that. */
export async function requirementFields(pursuitId: string): Promise<string | null> {
  const rows = await handoffRows([pursuitId]);
  if (rows.length === 0) return null;
  return handoffFields(rows[0]!)
    .map((field) => `${field.label}: ${field.value}`)
    .join('\n');
}
