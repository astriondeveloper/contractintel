/**
 * Campaign definition and sizing. Spec section 11.
 *
 *   npm run campaign                                          list them
 *   npm run campaign -- --create "Flight test" --nodes CAP-01,CAP-03 \
 *                       --offices 9700/FA8601 --actor gavin.taylor@astrion.us
 *   npm run campaign -- --id 1 --add-offices 5700/ZOFF02 --actor <you>
 *   npm run campaign -- --id 1 --assign --actor <you>          claim matching requirements
 *   npm run campaign -- --gap                                  the gap report
 *   npm run size                                               size every active campaign
 *   npm run size -- --fy-from 2020 --fy-to 2024
 *
 * A CLI rather than a screen, and that is a decision rather than a shortcut. `signal_class_threshold`
 * and `opportunity_profile` are both BD Ops data managed this way already, and a campaign definition
 * belongs with them: it is the shape of the market rather than a thing anybody works day to day. The
 * interface reads campaigns and never writes them, which keeps the write surface at the three
 * endpoints the router allows.
 *
 * `--actor` is required for anything that writes. Spec section 20 wants an actor on every change and
 * there is no signed-in user at a command line, so it is asked for rather than invented. An audit
 * trail full of "system" is worse than none, because it looks like one.
 */
import { withTransaction, closePool, query } from '../db/index.js';
import {
  DEFAULT_WINDOW_YEARS,
  assignMatching,
  createCampaign,
  defaultWindow,
  sizeAll,
  sizeCampaign,
  type SizingWindow,
} from './sizing.js';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

function list(value: string | null): string[] {
  if (value === null) return [];
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function requireActor(argv: readonly string[]): string {
  const actor = flag(argv, '--actor');
  if (actor === null || actor.trim() === '') {
    throw new Error(
      'Anything that writes needs --actor <your principal name>. Spec section 20 wants a real ' +
        'actor on every change, and there is no signed-in user at a command line.',
    );
  }
  return actor.trim();
}

function usd(value: string | null): string {
  if (value === null) return 'not computed';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not computed';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function usage(): void {
  console.log(`
Campaigns. Spec section 11.

  npm run campaign                        List every campaign with its sizing.
  npm run campaign -- --gap               The gap report: requirements no campaign claims.

  npm run campaign -- --create "<name>" --actor <you> [options]
      --nodes CAP-01,CAP-03               Capability node keys. These supply the NAICS and PSC
                                          codes the sizing runs against, so a campaign with none
                                          has nothing to size.
      --offices 9700/FA8601,5700/ZOFF02   Where it competes. Without these there is no served
                                          market and SAM comes back null rather than falling
                                          back to TAM.
      --owner <name>  --unit <name>

  npm run campaign -- --id <n> --add-offices 9700/FA8601 --actor <you>
  npm run campaign -- --id <n> --add-nodes CAP-04 --actor <you>
  npm run campaign -- --id <n> --assign --actor <you>
      Claim every unclaimed requirement whose codes match this campaign. Never reassigns one
      that is already in a campaign: a person's choice beats a code match.

  npm run size -- [--fy-from <y> --fy-to <y>] [--id <n>] --actor <you>
      Default window is the last ${DEFAULT_WINDOW_YEARS} complete fiscal years. The current one is
      excluded, because a partial year in the denominator moves the capture rate for reasons
      that are about the calendar.

TAM here is a floor, not a total addressable market. This corpus is Astrion's history plus the
watchlist competitors, not every federal dollar under these codes. Every campaign carries that
caveat as evidence and the screen shows it first.
`);
}

async function showList(): Promise<void> {
  const rows = await query<{
    campaign_id: string;
    campaign_name: string;
    state: string;
    tam_usd: string | null;
    sam_usd: string | null;
    som_usd: string | null;
    capture_rate: string | null;
    capture_rate_sample_size: number | null;
    capture_rate_standing: string;
    sizing_fy_from: number | null;
    sizing_fy_to: number | null;
    nodes: string;
    offices: string;
    codes: string;
    requirements: string;
    caveats: string;
  }>('select * from campaign_summary order by campaign_id');

  if (rows.length === 0) {
    console.log('');
    console.log('No campaign is defined. One is a set of capability areas plus the offices that buy');
    console.log('them, and it is what turns a pile of requirements into a market you can size.');
    console.log('');
    console.log('  npm run campaign -- --create "Flight test and evaluation" \\');
    console.log('      --nodes CAP-01,CAP-03 --offices 9700/FA8601 --actor <you>');
    return;
  }

  for (const row of rows) {
    console.log('');
    console.log(`${row.campaign_id}. ${row.campaign_name}  [${row.state}]`);
    console.log(
      `    scope        ${row.nodes} node(s) → ${row.codes} code(s), ${row.offices} office(s), ` +
        `${row.requirements} requirement(s)`,
    );
    if (row.sizing_fy_from === null) {
      console.log('    sizing       not computed. Run npm run size.');
    } else {
      console.log(`    window       FY${row.sizing_fy_from} to FY${row.sizing_fy_to}`);
      console.log(`    TAM          ${usd(row.tam_usd)}   (a floor: the market this corpus can see)`);
      console.log(`    SAM          ${usd(row.sam_usd)}`);
      console.log(`    SOM          ${usd(row.som_usd)}`);
      // The rate and its sample size on one line, never apart. Acceptance test 9.
      console.log(
        `    capture      ${
          row.capture_rate === null ? 'not measurable' : `${(Number(row.capture_rate) * 100).toFixed(1)}%`
        } over ${row.capture_rate_sample_size ?? 0} award(s) — ${row.capture_rate_standing}`,
      );
    }
    if (Number(row.caveats) > 0) {
      console.log(`    caveats      ${row.caveats}. Read them on /campaigns/${row.campaign_id}.`);
    }
  }
}

async function showGap(): Promise<void> {
  const rows = await query<{
    pursuit_id: string;
    title: string;
    signal_class: string;
    would_match: string | null;
    uncodeable: boolean;
    estimated_value: string | null;
  }>(
    `select pursuit_id::text, title, signal_class, would_match, uncodeable, estimated_value::text
       from campaign_gap order by estimated_value desc nulls last, pursuit_id limit 40`,
  );

  const [totals] = await query<{ total: string; matchable: string; uncodeable: string }>(
    `select count(*)::text as total,
            count(*) filter (where would_match is not null)::text as matchable,
            count(*) filter (where uncodeable)::text as uncodeable
       from campaign_gap`,
  );

  console.log('');
  console.log(`Gap report: ${totals!.total} requirement(s) in no campaign.`);
  console.log(`  ${totals!.matchable} match the codes of a campaign that exists and could be claimed.`);
  console.log(`  ${totals!.uncodeable} carry neither a NAICS nor a PSC, so no campaign could claim them on codes.`);
  console.log('');

  for (const row of rows) {
    const title = row.title.length > 62 ? `${row.title.slice(0, 61)}…` : row.title;
    console.log(`  ${row.pursuit_id.padStart(6)}  ${title}`);
    console.log(
      `          ${row.signal_class}  ${usd(row.estimated_value)}  ` +
        (row.would_match === null
          ? row.uncodeable
            ? 'no codes to match on'
            : 'matches no campaign'
          : `would match: ${row.would_match}`),
    );
  }

  if (Number(totals!.matchable) > 0) {
    console.log('');
    console.log('  Claim them: npm run campaign -- --id <n> --assign --actor <you>');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  // npm run size lands here too, with --size injected by package.json.
  const sizing = argv.includes('--size');

  if (argv.includes('--gap')) {
    await showGap();
    return;
  }

  const name = flag(argv, '--create');
  if (name !== null) {
    const actor = requireActor(argv);
    const result = await withTransaction((client) =>
      createCampaign(client, {
        name,
        nodeKeys: list(flag(argv, '--nodes')),
        offices: list(flag(argv, '--offices')),
        owner: flag(argv, '--owner'),
        businessUnit: flag(argv, '--unit'),
        actor,
      }),
    );

    console.log('');
    console.log(`Created campaign ${result.campaignId}: ${name}`);
    console.log(`  ${result.nodesAttached} node(s), ${result.officesAttached} office(s).`);
    if (result.unknownNodes.length > 0) {
      console.log('');
      console.log(`  These node keys did not resolve and were not attached: ${result.unknownNodes.join(', ')}`);
      console.log('  A campaign quietly missing half its capability areas sizes small for the wrong');
      console.log('  reason, so they are named rather than skipped. npm run web → Capabilities lists them.');
    }
    if (result.officesAttached === 0) {
      console.log('');
      console.log('  No offices named, so this campaign has no served market and SAM will come back');
      console.log('  null rather than falling back to TAM. Add them with --add-offices.');
    }
    console.log('');
    console.log('  Now size it: npm run size');
    return;
  }

  const id = flag(argv, '--id');

  const addOffices = list(flag(argv, '--add-offices'));
  const addNodes = list(flag(argv, '--add-nodes'));
  if (addOffices.length > 0 || addNodes.length > 0) {
    if (id === null) throw new Error('--add-offices and --add-nodes need --id <campaign id>.');
    const actor = requireActor(argv);
    await withTransaction(async (client) => {
      for (const pair of addOffices) {
        const match = /^([^/\s]+)\s*\/\s*([^/\s]+)$/.exec(pair);
        if (match === null) throw new Error(`"${pair}" is not an office. Write one as agency/office.`);
        await client.query(
          `insert into campaign_office (campaign_id, agency_code, office_code)
           values ($1::bigint, $2, $3) on conflict do nothing`,
          [id, match[1]!.toUpperCase(), match[2]!.toUpperCase()],
        );
      }
      for (const key of addNodes) {
        await client.query(
          `insert into campaign_node (campaign_id, node_id)
           select $1::bigint, node_id from taxonomy_node where node_key = $2 and active
            order by version desc limit 1
           on conflict do nothing`,
          [id, key],
        );
      }
      await client.query(
        `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
         values ($1, 'update', 'campaign', $2, $3::jsonb, $4)`,
        [
          actor,
          id,
          JSON.stringify({ added_offices: addOffices, added_nodes: addNodes }),
          `Campaign scope widened: ${addNodes.length} node(s), ${addOffices.length} office(s)`,
        ],
      );
    });
    console.log(`\nScope widened. Re-size it: npm run size -- --id ${id}`);
    return;
  }

  if (argv.includes('--assign')) {
    if (id === null) throw new Error('--assign needs --id <campaign id>.');
    const actor = requireActor(argv);
    const result = await withTransaction((client) => assignMatching(client, id, actor));
    console.log('');
    console.log(`${result.assigned} requirement(s) claimed by ${result.campaignName}.`);
    if (result.assigned === 0) {
      console.log('Nothing unclaimed matched its codes. npm run campaign -- --gap shows what is left.');
    }
    return;
  }

  if (sizing) {
    const actor = requireActor(argv);
    const fromFlag = flag(argv, '--fy-from');
    const toFlag = flag(argv, '--fy-to');

    const window: SizingWindow = await withTransaction(async (client) => {
      const fallback = await defaultWindow(client);
      const from = fromFlag === null ? fallback.fyFrom : Number(fromFlag);
      const to = toFlag === null ? fallback.fyTo : Number(toFlag);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
        throw new Error('--fy-from and --fy-to take whole fiscal years, from no later than to.');
      }
      return { fyFrom: from, fyTo: to };
    });

    const results = await withTransaction((client) =>
      id === null ? sizeAll(client, window, actor) : sizeCampaign(client, id, window, actor).then((r) => [r]),
    );

    if (results.length === 0) {
      console.log('');
      console.log('No active campaign to size. Create one:');
      console.log('  npm run campaign -- --create "<name>" --nodes CAP-01 --offices 9700/FA8601 --actor <you>');
      return;
    }

    console.log('');
    console.log(`Sized over FY${window.fyFrom} to FY${window.fyTo}.`);
    for (const result of results) {
      console.log('');
      console.log(`${result.campaignId}. ${result.campaignName}`);
      console.log(`    TAM      ${usd(result.tamUsd)} over ${result.tamAwards} award(s)  (a floor)`);
      console.log(`    SAM      ${usd(result.samUsd)} over ${result.samAwards} award(s)`);
      console.log(`    SOM      ${usd(result.somUsd)}`);
      console.log(
        `    capture  ${
          result.captureRate === null ? 'not measurable' : `${(result.captureRate * 100).toFixed(1)}%`
        } over ${result.captureRateSampleSize ?? 0} award(s)`,
      );
      for (const caveat of result.caveats) {
        console.log(`    caveat   ${caveat}`);
      }
    }
    console.log('');
    console.log('Written. /campaigns shows the same figures with their evidence.');
    return;
  }

  await showList();
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
