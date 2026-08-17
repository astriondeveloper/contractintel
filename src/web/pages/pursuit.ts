/**
 * One pursuit, and the reasoning behind its score.
 *
 * This screen is what acceptance test 7 is actually about. A score nobody can open is a
 * number to be argued with rather than used, so every factor shows its state, the rule that
 * produced it, what it contributed, and the source rows behind it. Spec section 15.
 *
 * Three things it refuses to do.
 *
 * **It does not merge the four outputs.** Strategic fit, evidence confidence, timing urgency
 * and coverage are shown separately, because spec 10.1 says they are four different
 * questions and folding them into one number is how a figure stops meaning anything.
 *
 * **It does not hide contrary evidence.** Evidence arguing against the score is shown first
 * and in Twilight T&E. A reader who only ever sees supporting evidence stops believing the
 * supporting evidence. Spec 14.2.
 *
 * **It does not show a score behind a failed gate.** A blocked pursuit shows the gate and
 * the reason, and there is no score to show because the engine did not compute one.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, fields, section, table, tiles } from '../components.js';
import { day, moment, orAbsent, truncate, usd, ABSENT } from '../format.js';
import {
  assignableUsers,
  currentAssessment,
  evidenceFor,
  factorResults,
  gateResults,
  notesFor,
  profileMatches,
  pursuitDetail,
  recentActivity,
  type EvidenceRow,
} from '../queries.js';
import { card, cards } from '../components.js';
import { since } from '../format.js';
import { text } from '../params.js';

const STATES = ['open', 'qualifying', 'pursuing', 'submitted', 'won', 'lost', 'dropped'];

function bandChip(band: string | null) {
  if (band === 'pursue') return chip('pass', 'Pursue');
  if (band === 'review') return chip('blocked', 'Review');
  if (band === 'pass') return chip('neutral', 'Pass');
  if (band === 'blocked') return chip('fail', 'Blocked');
  if (band === 'insufficient_evidence') return chip('sky', 'No rank');
  return ABSENT;
}

function stateChip(state: string) {
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

export async function pursuit(ctx: Ctx, pursuitId: string): Promise<string | null> {
  const record = await pursuitDetail(pursuitId);
  if (record === null) return null;

  const assessment = await currentAssessment(pursuitId);
  const [factors, gates, evidence, matches, notes, history, people] = await Promise.all([
    assessment ? factorResults(assessment.assessment_id) : Promise.resolve([]),
    assessment ? gateResults(assessment.assessment_id) : Promise.resolve([]),
    assessment ? evidenceFor(assessment.assessment_id) : Promise.resolve([]),
    profileMatches(pursuitId),
    notesFor(pursuitId),
    recentActivity(20, pursuitId),
    assignableUsers(),
  ]);

  const signedIn = ctx.user !== null;
  const mine = signedIn && record.owner === ctx.user!.principalName;
  const post = (action: string) => `/pursuits/${pursuitId}/${action}`;

  /**
   * The action bar.
   *
   * Every button is a form POST rather than a link, because a link that changes something
   * is a change a browser will make on its own while prefetching. Nothing is shown as
   * disabled-but-present when there is no signed-in user: the bar is replaced by the reason,
   * so it is obvious why rather than mysteriously inert.
   */
  const actionBar = signedIn
    ? html`${mine
          ? html`<form method="post" action="${post('release')}">
              <button class="quiet" type="submit">Release</button>
            </form>`
          : html`<form method="post" action="${post('claim')}">
              <button type="submit">${record.owner ? 'Take over' : 'Claim'}</button>
            </form>`}
        <form method="post" action="${post('set-state')}">
          <select name="state" aria-label="Pipeline state">
            ${STATES.map(
              (state) =>
                html`<option value="${state}"${record.state === state ? html` selected` : ''}>${state}</option>`,
            )}
          </select>
          <button class="quiet" type="submit">Set state</button>
        </form>
        ${record.snoozed_until
          ? html`<form method="post" action="${post('unsnooze')}">
              <button class="quiet" type="submit">Un-snooze</button>
            </form>`
          : html`<form method="post" action="${post('snooze')}">
              <input type="date" name="until" aria-label="Snooze until">
              <button class="quiet" type="submit">Snooze</button>
            </form>`}`
    : html`<span class="state-pill">Read only · sign in to work this pursuit</span>`;

  const problem = text(ctx.url, 'problem');

  const byFactor = new Map<string, EvidenceRow[]>();
  const byGate = new Map<string, EvidenceRow[]>();
  for (const row of evidence) {
    if (row.factor_code) {
      byFactor.set(row.factor_code, [...(byFactor.get(row.factor_code) ?? []), row]);
    } else if (row.gate_code) {
      byGate.set(row.gate_code, [...(byGate.get(row.gate_code) ?? []), row]);
    }
  }

  const summary = fields([
    { label: 'Stage', value: record.signal_class },
    { label: 'State', value: chip('neutral', record.state) },
    { label: 'Owner', value: record.owner ? record.owner : html`<span class="sub">unclaimed</span>` },
    {
      label: 'Snoozed until',
      value: record.snoozed_until ? day(record.snoozed_until) : ABSENT,
    },
    {
      label: 'Agency',
      value: orAbsent(record.agency_label ?? record.agency_code),
    },
    { label: 'Solicitation', value: record.solicitation_number ? html`<code>${record.solicitation_number}</code>` : ABSENT },
    { label: 'Contract', value: record.related_piid ? html`<code>${record.related_piid}</code>` : ABSENT },
    { label: 'NAICS', value: record.naics_code ? html`<code>${record.naics_code}</code>` : ABSENT },
    { label: 'PSC', value: record.psc_code ? html`<code>${record.psc_code}</code>` : ABSENT },
    { label: 'Set aside', value: orAbsent(record.set_aside_code) },
    { label: 'Estimated value', value: usd(record.estimated_value) },
    { label: 'Responses due', value: day(record.response_date) },
    { label: 'Contract ends', value: day(record.period_end_date) },
    {
      label: 'Incumbent',
      value: record.incumbent_entity_id
        ? html`<a href="/entities/${record.incumbent_entity_id}">${record.incumbent_name}</a>`
        : ABSENT,
    },
    {
      label: 'Source',
      value: record.notice_url
        ? html`<a href="${record.notice_url}" rel="noreferrer">Open the notice</a>`
        : orAbsent(record.generated_by),
    },
  ]);

  const noAssessment = html`<div class="notice">
    <h3>This pursuit has not been assessed</h3>
    Scoring is a scheduled job rather than something a page load does. Run
    <code>npm run score</code>.
  </div>`;

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
            assessment.coverage === null
              ? ABSENT
              : `${(Number(assessment.coverage) * 100).toFixed(0)}%`,
          foot:
            assessment.known_weight === null
              ? 'Not computed behind a failed gate'
              : `${Number(assessment.known_weight)} of ${Number(assessment.applicable_weight)} applicable weight answered`,
        },
        { label: 'Assessed', value: moment(assessment.computed_at), foot: `Eligibility: ${assessment.eligibility}` },
      ])
    : html``;

  const gateTable = table({
    columns: [
      { header: 'Gate', cell: (r) => orAbsent(r.gate_name ?? r.gate_code) },
      { header: 'State', cell: (r) => stateChip(r.state) },
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
      { header: 'State', cell: (r) => stateChip(r.state) },
      {
        header: 'Score',
        align: 'num',
        cell: (r) => (r.score === null ? ABSENT : Number(r.score).toFixed(0)),
      },
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
            A failed gate shows no score at all rather than a low one, so there was nothing
            to compute. Spec section 3, acceptance test 5.`
        : html`<strong>No factor result.</strong>`,
  });

  const contrary = evidence.filter((row) => row.is_contrary);

  const workCards = cards([
    card({
      title: 'Notes',
      hint: `${notes.length}`,
      plain: false,
      body: html`${signedIn
          ? html`<div class="note">
              <form method="post" action="${post('note')}">
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
              Nothing has been changed yet. Claiming this, setting a state or adding a note
              writes an audit row and it appears here.
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
    ${problem ? html`<div class="notice alert"><h3>That did not work</h3>${problem}</div>` : ''}
    ${summary}
    ${signedIn && people.length > 1
      ? html`<div class="search" style="margin-top:12px">
          <form method="post" action="${post('assign')}" class="actions">
            <select name="owner" aria-label="Assign to">
              ${people.map(
                (person) =>
                  html`<option value="${person.principal_name}"${
                    record.owner === person.principal_name ? html` selected` : ''
                  }>${person.display_name ?? person.principal_name}</option>`,
              )}
            </select>
            <button class="quiet" type="submit">Assign</button>
          </form>
        </div>`
      : ''}
    ${workCards}
    ${assessment === null ? noAssessment : scoreTiles}
    ${assessment && assessment.status === 'insufficient_evidence'
      ? html`<div class="notice">
          <h3>No rank, and that is a statement about the evidence rather than the opportunity</h3>
          Either a mandatory factor could not be answered or coverage fell below the floor.
          The factor table below says which. A rank computed from too little would be a
          confident number resting on nothing.
        </div>`
      : ''}
    ${section('Hard gates', gateTable, 'A gate stops a pursuit. A score cannot override one')}
    ${section(
      'Factors',
      factorTable,
      assessment
        ? `Contribution is score times weight. The denominator is the applicable weight, ${
            assessment.applicable_weight === null ? 'not computed' : Number(assessment.applicable_weight).toFixed(0)
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
          'Why this is in the pipeline',
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
          'The profile rows that caused this notice to be fetched at all',
        )
      : ''}
  `;

  return screen(ctx, {
    title: truncate(record.title, 90),
    intro:
      assessment === null
        ? 'Not yet assessed.'
        : `Assessed under score model v${assessment.score_model_version}. Every figure opens the rows behind it.`,
    body,
    actions: actionBar,
    suppressEmptyNotice: true,
  });
}
