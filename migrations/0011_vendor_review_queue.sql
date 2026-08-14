-- 0011_vendor_review_queue.sql
--
-- Spec section 8.2 step 4: 'Produce a candidate for review.' And the line that
-- follows it: 'Never skip to step 4.'
--
-- A vendor name that the resolver cannot place lands here. It does not get a
-- guessed entity, and it does not get silently dropped. A BD Ops user works this
-- queue through the admin screen, which either adds an alias to the authored map
-- or marks the vendor as out of scope.

create table vendor_review_queue (
  queue_id           bigserial primary key,
  vendor_name_raw    text not null,
  vendor_name_normalized text generated always as (cie_normalize_name(vendor_name_raw)) stored,
  uei_observed       text,
  cage_observed      text,
  source_system      text not null,
  -- How far down the match order the resolver got before it gave up, and what it
  -- found there. This is the rule trace for a failed resolution.
  furthest_step      text not null
                       check (furthest_step in ('uei_ambiguous', 'cage_ambiguous', 'no_match')),
  candidate_entity_ids bigint[],
  occurrence_count   integer not null default 1,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  state              text not null default 'open'
                       check (state in ('open', 'resolved', 'out_of_scope')),
  resolved_entity_id bigint references entity (entity_id),
  decided_by         text,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index vendor_review_queue_identity_idx
  on vendor_review_queue (source_system, vendor_name_raw, coalesce(uei_observed, ''), coalesce(cage_observed, ''));
create index vendor_review_queue_open_idx on vendor_review_queue (state, occurrence_count desc)
  where state = 'open';

comment on column vendor_review_queue.occurrence_count is
  'How many source records carry this unresolved name. Work the queue by this number descending.';

select cie_attach_touch('vendor_review_queue');
