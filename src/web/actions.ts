/**
 * Everything a person can do, and the record of them doing it.
 *
 * Spec section 20 requires an audit row on every change, so every write in this file follows
 * the same shape and it is not negotiable:
 *
 *   1. There is a signed-in user, or the action is refused. No anonymous writes.
 *   2. The state is read before it is changed, so `before_value` is real rather than assumed.
 *   3. The change and its audit row are written in one transaction. A change without its audit
 *      row is the failure the whole arrangement exists to prevent, so they succeed together or
 *      neither does.
 *   4. The response is a redirect, so a refresh does not repeat the action.
 *
 * What changed from the pipeline this replaces, and why.
 *
 * **claim, release, assign, set-state, snooze are gone.** They were the verbs of a system of
 * record, and TechnoMile is the system of record. Assignment in particular was the wrong shape:
 * with 20-odd people checking occasionally, an owner column produces a list of things nobody
 * has picked up rather than a list of things anybody has read.
 *
 * **track, dismiss and sent are per person.** Two people can reach opposite conclusions about
 * the same requirement, and both are true statements about who thought what. A shared verdict
 * would make one of them the owner again.
 *
 * **sent is never cleared by track or dismiss.** It is the count that answers whether this tool
 * fed anything into TechnoMile, and a metric a later click can silently erase is not a metric.
 * Undoing a send is its own action, so the correction is a deliberate act with an audit row on
 * it rather than a side effect of tidying a feed.
 */
import type { IncomingMessage } from 'node:http';
import { withTransaction } from '../db/index.js';
import type { User } from './auth.js';

/**
 * What a person can do to one requirement. Anything not here is not an action.
 *
 * `note` is the one that is not per-person: a note is visible to everybody and append-only, which
 * is right for intel ("called the office, the RFP has slipped to Q3") and is why it survived the
 * move away from the pipeline model. It is not a shaping record and is not meant to grow into one:
 * contacts, meetings and capture plans are explicitly not this tool's job.
 */
export type PursuitActionName = 'track' | 'dismiss' | 'clear' | 'sent' | 'unsent' | 'note';

const PURSUIT_ACTIONS: readonly PursuitActionName[] = [
  'track',
  'dismiss',
  'clear',
  'sent',
  'unsent',
  'note',
];

/** What a person can do to their own follows and their own read mark. */
export type FollowActionName = 'follow' | 'unfollow' | 'mark-read';

const FOLLOW_ACTIONS: readonly FollowActionName[] = ['follow', 'unfollow', 'mark-read'];

/** The follow types, from the check constraint on `follow.follow_type`. */
export const FOLLOW_TYPES = [
  'capability',
  'agency',
  'office',
  'company',
  'naics',
  'psc',
  'keyword',
] as const;

export type FollowType = (typeof FOLLOW_TYPES)[number];

/** A form body big enough for a long note and small enough not to be a way in. */
const MAX_BODY_BYTES = 64 * 1024;

export interface ActionResult {
  readonly ok: boolean;
  /** Where to send the browser afterwards. */
  readonly redirectTo: string;
  /** Shown to the person when something was refused. */
  readonly message?: string;
}

export function isPursuitAction(name: string): name is PursuitActionName {
  return (PURSUIT_ACTIONS as readonly string[]).includes(name);
}

export function isFollowAction(name: string): name is FollowActionName {
  return (FOLLOW_ACTIONS as readonly string[]).includes(name);
}

/**
 * Read a form body.
 *
 * Capped, because an uncapped read on an endpoint anyone can reach is a way to exhaust a
 * container's memory with one request.
 */
export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('The submitted form is too large.');
    chunks.push(buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Record that this principal exists.
 *
 * Called on every authenticated request rather than maintained by hand, so the list cannot
 * drift from who actually has access. `follow`, `feed_watermark` and `pursuit_action` all carry
 * a foreign key to it, which is why this runs before a write and not only on a page view: a
 * person's first action in the system would otherwise fail on the key.
 */
export async function touchUser(user: User): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `insert into app_user (principal_name, display_name, email)
       values ($1, $2, $3)
       on conflict (principal_name) do update set
         display_name = coalesce(excluded.display_name, app_user.display_name),
         email        = coalesce(excluded.email, app_user.email),
         last_seen_at = now()`,
      [user.principalName, user.displayName, user.email],
    );
  });
}

/* ------------------------------------------------------------ pursuit actions */

interface ActionStateBefore {
  readonly tracked: boolean;
  readonly dismissed: boolean;
  readonly sent: boolean;
}

async function readState(
  client: import('pg').PoolClient,
  pursuitId: string,
  principal: string,
): Promise<ActionStateBefore> {
  const { rows } = await client.query<{ action: string }>(
    `select action from pursuit_action
      where pursuit_id = $1::bigint and principal_name = $2`,
    [pursuitId, principal],
  );
  const held = new Set(rows.map((r) => r.action));
  return { tracked: held.has('track'), dismissed: held.has('dismiss'), sent: held.has('sent') };
}

/**
 * Apply one per-person action and record it, in one transaction.
 *
 * The row is locked for the length of the transaction, so two clicks arriving at once cannot
 * produce an audit row describing a change that did not happen in that order.
 */
async function changeAction(
  action: PursuitActionName,
  pursuitId: string,
  form: URLSearchParams,
  user: User,
): Promise<ActionResult> {
  const back = form.get('back');
  const redirectTo = safeReturnTo(back) ?? `/requirements/${pursuitId}`;

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ title: string }>(
      'select title from pursuit where pursuit_id = $1::bigint for update',
      [pursuitId],
    );
    if (rows[0] === undefined) {
      return { ok: false, redirectTo: '/feed', message: 'That requirement no longer exists.' };
    }

    const before = await readState(client, pursuitId, user.principalName);
    const note = (form.get('note') ?? '').trim() || null;

    switch (action) {
      case 'track':
        await set(client, pursuitId, user.principalName, 'track', note);
        await unset(client, pursuitId, user.principalName, 'dismiss');
        break;
      case 'dismiss':
        await set(client, pursuitId, user.principalName, 'dismiss', note);
        await unset(client, pursuitId, user.principalName, 'track');
        break;
      case 'clear':
        await unset(client, pursuitId, user.principalName, 'track');
        await unset(client, pursuitId, user.principalName, 'dismiss');
        break;
      case 'sent':
        await set(client, pursuitId, user.principalName, 'sent', note);
        break;
      case 'unsent':
        await unset(client, pursuitId, user.principalName, 'sent');
        break;
      case 'note':
        // Handled before the lock is taken. Kept in the union so the router's whitelist is the
        // one list of actions rather than two that can drift apart.
        break;
    }

    const after = await readState(client, pursuitId, user.principalName);

    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, before_value, after_value, reason)
       values ($1, $2, 'pursuit_action', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        user.principalName,
        action === 'clear' || action === 'unsent' ? 'delete' : 'insert',
        pursuitId,
        JSON.stringify(before),
        JSON.stringify(after),
        reasonFor(action, rows[0].title),
      ],
    );

    return { ok: true, redirectTo };
  });
}

function reasonFor(action: PursuitActionName, title: string): string {
  const subject = title.length > 80 ? `${title.slice(0, 79)}…` : title;
  switch (action) {
    case 'track':
      return `Tracking: ${subject}`;
    case 'dismiss':
      return `Dismissed: ${subject}`;
    case 'clear':
      return `Cleared track and dismiss: ${subject}`;
    case 'sent':
      return `Sent to TechnoMile: ${subject}`;
    case 'unsent':
      return `Un-marked as sent to TechnoMile: ${subject}`;
    case 'note':
      return `Note added: ${subject}`;
  }
}

/**
 * Add a note.
 *
 * Append only from the interface, and that is deliberate: a note that can be edited away is a note
 * nobody trusts. The audit row records the body as well, so the trail carries what was written
 * even though nothing can remove it from `pursuit_note`.
 */
async function addNote(
  pursuitId: string,
  form: URLSearchParams,
  user: User,
): Promise<ActionResult> {
  const redirectTo = safeReturnTo(form.get('back')) ?? `/requirements/${pursuitId}`;
  const body = (form.get('body') ?? '').trim();
  if (body === '') {
    return { ok: false, redirectTo, message: 'A note needs some words in it.' };
  }

  return withTransaction(async (client) => {
    const { rows: exists } = await client.query<{ title: string }>(
      'select title from pursuit where pursuit_id = $1::bigint',
      [pursuitId],
    );
    if (exists[0] === undefined) {
      return { ok: false, redirectTo: '/feed', message: 'That requirement no longer exists.' };
    }

    await client.query(
      `insert into pursuit_note (pursuit_id, author, body) values ($1::bigint, $2, $3)`,
      [pursuitId, user.principalName, body],
    );
    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
       values ($1, 'insert', 'pursuit_note', $2, $3::jsonb, $4)`,
      [
        user.principalName,
        pursuitId,
        JSON.stringify({ pursuit_id: pursuitId, body }),
        reasonFor('note', exists[0].title),
      ],
    );

    return { ok: true, redirectTo };
  });
}

async function set(
  client: import('pg').PoolClient,
  pursuitId: string,
  principal: string,
  action: 'track' | 'dismiss' | 'sent',
  note: string | null,
): Promise<void> {
  await client.query(
    `insert into pursuit_action (pursuit_id, principal_name, action, note)
     values ($1::bigint, $2, $3, $4)
     on conflict (pursuit_id, principal_name, action) do update set
       note = coalesce(excluded.note, pursuit_action.note)`,
    [pursuitId, principal, action, note],
  );
}

async function unset(
  client: import('pg').PoolClient,
  pursuitId: string,
  principal: string,
  action: 'track' | 'dismiss' | 'sent',
): Promise<void> {
  await client.query(
    'delete from pursuit_action where pursuit_id = $1::bigint and principal_name = $2 and action = $3',
    [pursuitId, principal, action],
  );
}

/* ------------------------------------------------------------- follow actions */

/**
 * The canonical target for each follow type, and the typed columns beside it.
 *
 * Everything a form supplies is validated into this shape before it reaches SQL. A follow whose
 * target does not resolve is refused rather than stored: a follow that matches nothing looks
 * identical to a patch with nothing happening in it, and the person would have no way to tell
 * which they were looking at.
 */
interface FollowShape {
  readonly follow_type: FollowType;
  readonly target: string;
  readonly node_id: string | null;
  readonly entity_id: string | null;
  readonly agency_code: string | null;
  readonly office_code: string | null;
  readonly label: string;
}

async function resolveFollow(
  client: import('pg').PoolClient,
  followType: FollowType,
  raw: string,
): Promise<FollowShape | { error: string }> {
  const value = raw.trim();
  if (value === '') return { error: 'Pick something to follow.' };

  switch (followType) {
    case 'capability': {
      // Keyed on `node_key` rather than `node_id` so a follow survives a taxonomy re-version,
      // which mints new ids for the same capability.
      const { rows } = await client.query<{ node_id: string; node_key: string; node_name: string }>(
        `select node_id::text, node_key, node_name
           from taxonomy_node
          where node_key = $1 and active
          order by version desc limit 1`,
        [value],
      );
      if (rows[0] === undefined) return { error: `No active capability has the key ${value}.` };
      return {
        follow_type: followType,
        target: rows[0].node_key,
        node_id: rows[0].node_id,
        entity_id: null,
        agency_code: null,
        office_code: null,
        label: rows[0].node_name,
      };
    }

    case 'company': {
      if (!/^\d{1,19}$/.test(value)) return { error: 'Pick a company from the list.' };
      const { rows } = await client.query<{ entity_id: string; canonical_name: string }>(
        'select entity_id::text, canonical_name from entity where entity_id = $1::bigint',
        [value],
      );
      if (rows[0] === undefined) return { error: `No company has the id ${value}.` };
      return {
        follow_type: followType,
        target: rows[0].entity_id,
        node_id: null,
        entity_id: rows[0].entity_id,
        agency_code: null,
        office_code: null,
        label: rows[0].canonical_name,
      };
    }

    case 'agency': {
      const code = value.toUpperCase();
      const { rows } = await client.query<{ label: string | null }>(
        `select label from code_label_current where code_type = 'agency' and code_value = $1`,
        [code],
      );
      return {
        follow_type: followType,
        target: code,
        node_id: null,
        entity_id: null,
        agency_code: code,
        office_code: null,
        label: rows[0]?.label ?? `Agency ${code}`,
      };
    }

    case 'office': {
      // 'agency/office', which is how the feed rows link to it.
      const match = /^([^/\s]+)\s*\/\s*([^/\s]+)$/.exec(value);
      if (match === null) {
        return { error: 'An office is written as agency/office, for example 9700/FA8601.' };
      }
      const agency = match[1]!.toUpperCase();
      const office = match[2]!.toUpperCase();
      const { rows } = await client.query<{ label: string | null }>(
        `select label from code_label_current where code_type = 'office' and code_value = $1`,
        [office],
      );
      return {
        follow_type: followType,
        target: `${agency}/${office}`,
        node_id: null,
        entity_id: null,
        agency_code: agency,
        office_code: office,
        label: rows[0]?.label ?? `Office ${office}`,
      };
    }

    case 'naics':
    case 'psc': {
      const code = value.toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(code)) {
        return { error: `${followType.toUpperCase()} codes are letters and digits only.` };
      }
      const { rows } = await client.query<{ label: string | null }>(
        'select label from code_label_current where code_type = $1 and code_value = $2',
        [followType, code],
      );
      return {
        follow_type: followType,
        target: code,
        node_id: null,
        entity_id: null,
        agency_code: null,
        office_code: null,
        label: rows[0]?.label ?? `${followType.toUpperCase()} ${code}`,
      };
    }

    case 'keyword': {
      // Lowercased for the unique index, so the same phrase cannot be followed twice under two
      // capitalisations. Short phrases are refused: a two-letter keyword matches most of the
      // corpus and would drown the person's own feed.
      const phrase = value.toLowerCase().replace(/\s+/g, ' ');
      if (phrase.length < 3) {
        return { error: 'A keyword needs at least three characters, or it matches everything.' };
      }
      if (phrase.length > 80) return { error: 'That keyword is too long to be a keyword.' };
      return {
        follow_type: followType,
        target: phrase,
        node_id: null,
        entity_id: null,
        agency_code: null,
        office_code: null,
        label: value.trim(),
      };
    }
  }
}

async function addFollow(form: URLSearchParams, user: User): Promise<ActionResult> {
  const rawType = (form.get('follow_type') ?? '').trim();
  const back = safeReturnTo(form.get('back')) ?? '/follows';

  if (!(FOLLOW_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, redirectTo: back, message: `"${rawType}" is not something you can follow.` };
  }

  return withTransaction(async (client) => {
    const resolved = await resolveFollow(client, rawType as FollowType, form.get('target') ?? '');
    if ('error' in resolved) return { ok: false, redirectTo: back, message: resolved.error };

    const { rows } = await client.query<{ follow_id: string; inserted: boolean }>(
      `insert into follow (principal_name, follow_type, target, node_id, entity_id,
                           agency_code, office_code, label)
       values ($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8)
       on conflict (principal_name, follow_type, target) do update set label = excluded.label
       returning follow_id::text, (xmax = 0) as inserted`,
      [
        user.principalName,
        resolved.follow_type,
        resolved.target,
        resolved.node_id,
        resolved.entity_id,
        resolved.agency_code,
        resolved.office_code,
        resolved.label,
      ],
    );

    // An audit row only for a follow that did not already exist. Re-submitting a form should
    // not fill the trail with rows describing nothing happening.
    if (rows[0]!.inserted) {
      await client.query(
        `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
         values ($1, 'insert', 'follow', $2, $3::jsonb, $4)`,
        [
          user.principalName,
          rows[0]!.follow_id,
          JSON.stringify({
            follow_type: resolved.follow_type,
            target: resolved.target,
            label: resolved.label,
          }),
          `Followed ${resolved.follow_type}: ${resolved.label}`,
        ],
      );
    }

    return { ok: true, redirectTo: back };
  });
}

async function removeFollow(form: URLSearchParams, user: User): Promise<ActionResult> {
  const back = safeReturnTo(form.get('back')) ?? '/follows';
  const followId = (form.get('follow_id') ?? '').trim();
  if (!/^\d{1,19}$/.test(followId)) {
    return { ok: false, redirectTo: back, message: 'That is not a follow.' };
  }

  return withTransaction(async (client) => {
    // Scoped to the signed-in principal in the statement itself rather than checked first. A
    // follow is one person's, and an id from a form is input: the only safe place to enforce
    // whose it is, is the where clause.
    const { rows } = await client.query<{ follow_type: string; target: string; label: string | null }>(
      `delete from follow
        where follow_id = $1::bigint and principal_name = $2
        returning follow_type, target, label`,
      [followId, user.principalName],
    );

    if (rows[0] === undefined) {
      return { ok: false, redirectTo: back, message: 'That follow is not yours, or is already gone.' };
    }

    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, before_value, reason)
       values ($1, 'delete', 'follow', $2, $3::jsonb, $4)`,
      [
        user.principalName,
        followId,
        JSON.stringify(rows[0]),
        `Unfollowed ${rows[0].follow_type}: ${rows[0].label ?? rows[0].target}`,
      ],
    );

    return { ok: true, redirectTo: back };
  });
}

/**
 * Move the read mark.
 *
 * Deliberately an action rather than something a page load does. A mark that advances on
 * render loses the item somebody was halfway through reading when they hit refresh, and a GET
 * that writes is a GET that has to be trusted not to.
 */
async function markRead(form: URLSearchParams, user: User): Promise<ActionResult> {
  const back = safeReturnTo(form.get('back')) ?? '/feed';

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ seen_through: Date; previous_seen_through: Date | null }>(
      `insert into feed_watermark (principal_name, seen_through)
       values ($1, now())
       on conflict (principal_name) do update set
         previous_seen_through = feed_watermark.seen_through,
         seen_through          = now()
       returning seen_through, previous_seen_through`,
      [user.principalName],
    );

    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, before_value, after_value, reason)
       values ($1, 'update', 'feed_watermark', $2, $3::jsonb, $4::jsonb, 'Marked the feed as read')`,
      [
        user.principalName,
        user.principalName,
        JSON.stringify({ seen_through: rows[0]!.previous_seen_through }),
        JSON.stringify({ seen_through: rows[0]!.seen_through }),
      ],
    );

    return { ok: true, redirectTo: back };
  });
}

/* --------------------------------------------------------------------- return */

/**
 * Where to send the browser afterwards.
 *
 * A form carries where it was submitted from, so tracking something from the feed returns to
 * the feed rather than to the record. The value is input, so only a same-site path is accepted:
 * an absolute URL here would turn every action button into an open redirect. A leading `//`
 * is rejected as well, because a browser reads `//elsewhere.example` as a host.
 */
export function safeReturnTo(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || !trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (trimmed.includes('\\') || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

/* ------------------------------------------------------------------ dispatch */

export function performPursuitAction(
  action: PursuitActionName,
  pursuitId: string,
  form: URLSearchParams,
  user: User,
): Promise<ActionResult> {
  if (action === 'note') return addNote(pursuitId, form, user);
  return changeAction(action, pursuitId, form, user);
}

export function performFollowAction(
  action: FollowActionName,
  form: URLSearchParams,
  user: User,
): Promise<ActionResult> {
  switch (action) {
    case 'follow':
      return addFollow(form, user);
    case 'unfollow':
      return removeFollow(form, user);
    case 'mark-read':
      return markRead(form, user);
  }
}
