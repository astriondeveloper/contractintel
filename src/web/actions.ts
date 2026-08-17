/**
 * The things business development can do to a pursuit.
 *
 * This is the first part of the build that writes to the corpus, and it is late on purpose.
 * Spec section 20 requires an audit trail on every change, so a write screen without one
 * would have made the corpus quietly untrustworthy. `audit_log` has existed since migration
 * 0008 waiting for this.
 *
 * Every action here follows the same shape and it is not negotiable:
 *
 *   1. There is a signed-in user, or the action is refused. No anonymous writes.
 *   2. The row is read before it is changed, so `before_value` is real rather than assumed.
 *   3. The change and the audit row are written in one transaction. A change without its
 *      audit row is the failure the whole arrangement exists to prevent, so they succeed
 *      together or neither does.
 *   4. The response is a redirect, so a refresh does not repeat the action.
 *
 * Detection runs never touch these fields. `state`, `owner` and `campaign_id` are absent
 * from every generated upsert precisely so a monthly re-detection cannot undo a person's
 * afternoon.
 */
import type { IncomingMessage } from 'node:http';
import { withTransaction } from '../db/index.js';
import type { User } from './auth.js';

/** Everything a form can ask for. Anything not here is not an action. */
export type ActionName = 'claim' | 'release' | 'assign' | 'set-state' | 'note' | 'snooze' | 'unsnooze';

const ACTIONS: readonly ActionName[] = ['claim', 'release', 'assign', 'set-state', 'note', 'snooze', 'unsnooze'];

/** The pipeline states, from the check constraint on `pursuit.state`. */
const STATES = ['open', 'qualifying', 'pursuing', 'submitted', 'won', 'lost', 'dropped'];

/** A form body big enough for a long note and small enough not to be a way in. */
const MAX_BODY_BYTES = 64 * 1024;

export interface ActionResult {
  readonly ok: boolean;
  /** Where to send the browser afterwards. */
  readonly redirectTo: string;
  /** Shown to the person when something was refused. */
  readonly message?: string;
}

export function isAction(name: string): name is ActionName {
  return (ACTIONS as readonly string[]).includes(name);
}

/**
 * Read a form body.
 *
 * Capped, because an uncapped read on an unauthenticated endpoint is a way to exhaust a
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
 * Record that this principal exists, so a pursuit can be assigned to somebody who is not
 * currently looking at the screen. Called on each authenticated request rather than
 * maintained by hand, so the list cannot drift from who actually has access.
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

interface PursuitBefore {
  readonly pursuit_id: string;
  readonly state: string;
  readonly owner: string | null;
  readonly snoozed_until: Date | null;
  readonly title: string;
}

/**
 * Apply a change to a pursuit and record it, in one transaction.
 *
 * `mutate` returns the SQL fragment and parameters for the update. It never writes the
 * audit row itself, because an audit row that a caller can forget is an audit row that will
 * be forgotten.
 */
async function changePursuit(
  pursuitId: string,
  user: User,
  action: 'update',
  reason: string,
  mutate: (before: PursuitBefore) => { sql: string; params: unknown[] } | null,
): Promise<ActionResult> {
  return withTransaction(async (client) => {
    // Locked for the length of the transaction, so two people clicking at once cannot
    // produce an audit row describing a change that did not happen in that order.
    const { rows } = await client.query<PursuitBefore>(
      `select pursuit_id::text, state, owner, snoozed_until, title
         from pursuit where pursuit_id = $1::bigint for update`,
      [pursuitId],
    );
    const before = rows[0];
    if (before === undefined) {
      return { ok: false, redirectTo: '/pipeline', message: 'That pursuit no longer exists.' };
    }

    const change = mutate(before);
    if (change === null) {
      return { ok: true, redirectTo: `/pursuits/${pursuitId}` };
    }

    const { rows: after } = await client.query<PursuitBefore>(
      `update pursuit set ${change.sql} where pursuit_id = $1::bigint
       returning pursuit_id::text, state, owner, snoozed_until, title`,
      [pursuitId, ...change.params],
    );

    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, before_value, after_value, reason)
       values ($1, $2, 'pursuit', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        user.principalName,
        action,
        pursuitId,
        JSON.stringify({ state: before.state, owner: before.owner, snoozed_until: before.snoozed_until }),
        JSON.stringify({
          state: after[0]!.state,
          owner: after[0]!.owner,
          snoozed_until: after[0]!.snoozed_until,
        }),
        reason,
      ],
    );

    return { ok: true, redirectTo: `/pursuits/${pursuitId}` };
  });
}

export async function performAction(
  action: ActionName,
  pursuitId: string,
  form: URLSearchParams,
  user: User,
): Promise<ActionResult> {
  switch (action) {
    case 'claim':
      return changePursuit(pursuitId, user, 'update', 'Claimed', (before) =>
        before.owner === user.principalName
          ? null
          : {
              sql: `owner = $2, state = case when state = 'open' then 'qualifying' else state end,
                    state_changed_at = now(), state_changed_by = $3`,
              params: [user.principalName, user.principalName],
            },
      );

    case 'release':
      return changePursuit(pursuitId, user, 'update', 'Released', (before) =>
        before.owner === null ? null : { sql: 'owner = null', params: [] },
      );

    case 'assign': {
      const to = (form.get('owner') ?? '').trim();
      if (to === '') {
        return { ok: false, redirectTo: `/pursuits/${pursuitId}`, message: 'Pick somebody to assign it to.' };
      }
      return changePursuit(pursuitId, user, 'update', `Assigned to ${to}`, () => ({
        sql: 'owner = $2',
        params: [to],
      }));
    }

    case 'set-state': {
      const state = (form.get('state') ?? '').trim();
      if (!STATES.includes(state)) {
        return {
          ok: false,
          redirectTo: `/pursuits/${pursuitId}`,
          message: `"${state}" is not a pipeline state.`,
        };
      }
      return changePursuit(pursuitId, user, 'update', `State set to ${state}`, (before) =>
        before.state === state
          ? null
          : {
              sql: 'state = $2, state_changed_at = now(), state_changed_by = $3',
              params: [state, user.principalName],
            },
      );
    }

    case 'snooze': {
      const until = (form.get('until') ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return { ok: false, redirectTo: `/pursuits/${pursuitId}`, message: 'Pick a date to snooze until.' };
      }
      return changePursuit(pursuitId, user, 'update', `Snoozed until ${until}`, () => ({
        sql: 'snoozed_until = $2::date',
        params: [until],
      }));
    }

    case 'unsnooze':
      return changePursuit(pursuitId, user, 'update', 'Un-snoozed', (before) =>
        before.snoozed_until === null ? null : { sql: 'snoozed_until = null', params: [] },
      );

    case 'note': {
      const body = (form.get('body') ?? '').trim();
      if (body === '') {
        return { ok: false, redirectTo: `/pursuits/${pursuitId}`, message: 'A note needs some words in it.' };
      }
      return withTransaction(async (client) => {
        const { rows } = await client.query<{ note_id: string }>(
          `insert into pursuit_note (pursuit_id, author, body)
           values ($1::bigint, $2, $3) returning note_id`,
          [pursuitId, user.principalName, body],
        );
        await client.query(
          `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
           values ($1, 'insert', 'pursuit_note', $2, $3::jsonb, 'Note added')`,
          [user.principalName, rows[0]!.note_id, JSON.stringify({ pursuit_id: pursuitId, body })],
        );
        return { ok: true, redirectTo: `/pursuits/${pursuitId}` };
      });
    }
  }
}
