/**
 * Follows. What one person has said their patch is.
 *
 * The four kinds are the four ways BD actually describes a patch, and three of them cost nothing
 * to match because the corpus already resolved them:
 *
 *   A capability area   `node_crosswalk` already carries the NAICS, PSC and keyword crosswalks BD
 *                       authored against each taxonomy node, so following a capability follows a
 *                       set of codes somebody has already thought about rather than a guess.
 *   An agency or office The codes are on every requirement already.
 *   A company           `entity` and `entity_alias` already collapse the 40-odd legal names in a
 *                       corporate family onto one row, which is what acceptance test 1 is about.
 *                       Following a company follows the family, not one spelling of it.
 *   A raw code or word  The escape hatch, for work whose shape has no crosswalk yet.
 *
 * Two things this screen does that a settings page usually does not.
 *
 * **It shows what each follow is currently bringing in.** A follow matching nothing is either a
 * code nobody buys under or a typo, and from the feed those two look identical to a quiet week.
 * The count next to the follow is what makes a dead follow visible as a dead follow.
 *
 * **It shows what is available, ordered by how much is there.** A person cannot follow an agency
 * that has never appeared in the corpus, and the busiest offices are listed first, because a
 * picker sorted alphabetically buries the useful choices.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, table } from '../components.js';
import { count, since, truncate } from '../format.js';
import { text } from '../params.js';
import {
  followableAgencies,
  followableCapabilities,
  followableCompanies,
  followableOffices,
  followsFor,
  watermarkFor,
} from '../queries.js';
import { flashFrom } from './feed.js';

function typeChip(followType: string): Html {
  if (followType === 'capability') return chip('sky', 'capability');
  if (followType === 'company') return chip('pass', 'company');
  if (followType === 'agency' || followType === 'office') return chip('blocked', followType);
  return chip('neutral', followType);
}

export async function follows(ctx: Ctx): Promise<string> {
  if (ctx.user === null) {
    return screen(ctx, {
      title: 'Follows',
      body: html`<div class="notice">
        <h3>Not signed in</h3>
        A follow belongs to a person, so this deployment cannot show you yours or let you add one.
        Everything else is readable. <code>docs/DEPLOY.md</code> covers turning on Microsoft Entra
        sign-in.
      </div>`,
      suppressEmptyNotice: true,
    });
  }

  const principal = ctx.user.principalName;
  const mark = await watermarkFor(principal);
  const [mine, capabilities, agencies, offices, companies] = await Promise.all([
    followsFor(principal, mark.seen_through),
    followableCapabilities(),
    followableAgencies(),
    followableOffices(),
    followableCompanies(),
  ]);

  const returnTo = `${ctx.url.pathname}${ctx.url.search}`;
  const openTab = text(ctx.url, 'add') || 'capability';

  /** One "follow this" form. A POST, because it writes a row and an audit row. */
  const addForm = (followType: string, field: Html, hint: string): Html => html`<form
    class="add-follow"
    method="post"
    action="/follows/follow"
  >
    <input type="hidden" name="follow_type" value="${followType}">
    <input type="hidden" name="back" value="${returnTo}">
    ${field}
    <button type="submit">Follow</button>
    <div class="sub">${hint}</div>
  </form>`;

  const followedTargets = new Set(mine.map((f) => `${f.follow_type}|${f.target}`));
  const already = (followType: string, target: string) =>
    followedTargets.has(`${followType}|${target}`);

  const capabilityPicker = addForm(
    'capability',
    html`<select name="target" aria-label="Capability area">
      ${capabilities.map(
        (node) =>
          html`<option value="${node.node_key}"${already('capability', node.node_key) ? html` disabled` : ''}>
            ${node.node_key} · ${truncate(node.node_name, 60)}
            ${node.crosswalks === 0 ? ' (no codes crosswalked yet)' : ` (${node.crosswalks} codes)`}
            ${already('capability', node.node_key) ? ' — already followed' : ''}
          </option>`,
      )}
    </select>`,
    'A capability follows the NAICS, PSC and keyword crosswalks BD authored against it. ' +
      'A node with no codes crosswalked yet will match nothing until somebody fills them in.',
  );

  const agencyPicker = addForm(
    'agency',
    html`<select name="target" aria-label="Agency">
      ${agencies.length === 0
        ? html`<option value="">No agency appears in the corpus yet</option>`
        : agencies.map(
            (a) =>
              html`<option value="${a.agency_code}"${already('agency', a.agency_code) ? html` disabled` : ''}>
                ${a.label ?? a.agency_code} (${count(a.requirements)})
                ${already('agency', a.agency_code) ? ' — already followed' : ''}
              </option>`,
          )}
    </select>`,
    'Ordered by how many requirements each agency currently carries.',
  );

  const officePicker = addForm(
    'office',
    html`<select name="target" aria-label="Office">
      ${offices.length === 0
        ? html`<option value="">No office appears in the corpus yet</option>`
        : offices.map((o) => {
            const target = `${o.agency_code}/${o.office_code}`;
            return html`<option value="${target}"${already('office', target) ? html` disabled` : ''}>
              ${o.label ?? o.office_code} · ${o.agency_code}/${o.office_code} (${count(o.requirements)})
              ${already('office', target) ? ' — already followed' : ''}
            </option>`;
          })}
    </select>`,
    'An office is narrower than its agency and is usually the right size of patch.',
  );

  const companyPicker = addForm(
    'company',
    html`<select name="target" aria-label="Company">
      ${companies.length === 0
        ? html`<option value="">No company is loaded yet</option>`
        : companies.map(
            (c) =>
              html`<option value="${c.entity_id}"${already('company', c.entity_id) ? html` disabled` : ''}>
                ${truncate(c.canonical_name, 52)}${c.entity_type ? ` · ${c.entity_type}` : ''}
                (${count(c.requirements)})
                ${already('company', c.entity_id) ? ' — already followed' : ''}
              </option>`,
          )}
    </select>`,
    'Follows the corporate family, not one legal name. Catches the company as incumbent, ' +
      'partner or competitor on a requirement.',
  );

  const codePicker = (followType: 'naics' | 'psc') =>
    addForm(
      followType,
      html`<input
        type="text"
        name="target"
        placeholder="${followType === 'naics' ? '541330, or 5413 for the group' : 'R425, or R4 for the group'}"
        aria-label="${followType.toUpperCase()} code"
      >`,
      'Matched as a prefix, so a shorter code follows the whole group beneath it.',
    );

  const keywordPicker = addForm(
    'keyword',
    html`<input type="text" name="target" placeholder="hypersonic, digital engineering, T&amp;E" aria-label="Keyword">`,
    'Matched against the title. Three characters minimum, because a two-letter keyword ' +
      'matches most of the corpus.',
  );

  const tab = (value: string, label: string) => {
    const url = new URL(ctx.url);
    url.searchParams.set('add', value);
    return html`<a class="button quiet${openTab === value ? ' on' : ''}"
      href="${url.pathname}${url.search}"
      >${label}</a
    >`;
  };

  const addPanel = card({
    title: 'Add a follow',
    hint: 'Your feed is the union of these',
    plain: true,
    body: html`<div class="search">
        ${tab('capability', 'Capability area')}
        ${tab('agency', 'Agency')}
        ${tab('office', 'Office')}
        ${tab('company', 'Company')}
        ${tab('naics', 'NAICS')}
        ${tab('psc', 'PSC')}
        ${tab('keyword', 'Keyword')}
      </div>
      ${openTab === 'capability'
        ? capabilityPicker
        : openTab === 'agency'
          ? agencyPicker
          : openTab === 'office'
            ? officePicker
            : openTab === 'company'
              ? companyPicker
              : openTab === 'naics'
                ? codePicker('naics')
                : openTab === 'psc'
                  ? codePicker('psc')
                  : keywordPicker}`,
  });

  const dead = mine.filter((f) => f.matches === 0);

  const mineTable = table({
    columns: [
      { header: 'Kind', cell: (f) => typeChip(f.follow_type) },
      {
        header: 'Following',
        cell: (f) =>
          html`${truncate(f.label ?? f.target, 64)}<span class="sub"><code>${f.target}</code></span>`,
      },
      {
        header: 'In the feed',
        align: 'num',
        cell: (f) =>
          f.matches === 0
            ? html`<span class="absent">0</span>`
            : html`<a href="/feed?view=patch&q=${encodeURIComponent(f.target)}">${count(f.matches)}</a>`,
      },
      { header: 'New', align: 'num', cell: (f) => count(f.new_matches) },
      {
        header: 'In the forecast',
        align: 'num',
        cell: (f) =>
          f.forecast_matches === 0 ? html`<span class="absent">0</span>` : count(f.forecast_matches),
      },
      { header: 'Since', cell: (f) => since(f.created_at) },
      {
        header: '',
        cell: (f) => html`<form method="post" action="/follows/unfollow">
          <input type="hidden" name="follow_id" value="${f.follow_id}">
          <input type="hidden" name="back" value="${returnTo}">
          <button class="danger" type="submit">Unfollow</button>
        </form>`,
      },
    ],
    rows: mine,
    empty: html`<strong>You are not following anything yet.</strong><br>
      Start with the capability areas closest to your work, then add the offices that buy it.`,
  });

  const body = html`
    ${dead.length > 0
      ? html`<div class="notice">
          <h3>
            ${count(dead.length)} of your follow(s) currently match nothing
          </h3>
          Either the corpus holds no requirement under
          ${dead.map((f) => html`<code>${f.target}</code> `)}
          yet, or the code is wrong. A follow that matches nothing looks exactly like a quiet week
          from the feed, which is why it is called out here rather than left to be inferred.
        </div>`
      : ''}
    ${cards([addPanel])}
    <div class="section">
      <div class="section-head">
        <h2>Your follows</h2>
        <div class="hint">${count(mine.length)} follow(s). A feed is the union of them</div>
      </div>
      ${mineTable}
    </div>
  `;

  return screen(ctx, {
    title: 'Follows',
    intro:
      'Your patch, in your words. Capability areas, agencies and offices, companies, and raw ' +
      'NAICS, PSC or keywords. Nobody else sees or edits these, and nothing here is assigned.',
    body,
    actions: html`<a class="button quiet" href="/feed">Back to the feed</a>`,
    suppressEmptyNotice: true,
    flash: flashFrom(ctx),
  });
}
