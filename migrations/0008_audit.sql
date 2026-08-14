-- 0008_audit.sql
-- Spec section 13: BD Ops maintains this system and does not write code.
-- Every change writes an audit row.

create table audit_log (
  audit_id     bigserial primary key,
  actor        text not null,
  action       text not null
                 check (action in ('insert', 'update', 'delete', 'confirm', 'reject', 'recompute')),
  object_type  text not null,
  object_key   text not null,
  before_value jsonb,
  after_value  jsonb,
  reason       text,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index audit_log_object_idx   on audit_log (object_type, object_key, occurred_at desc);
create index audit_log_actor_idx    on audit_log (actor, occurred_at desc);
create index audit_log_occurred_idx on audit_log (occurred_at desc);

select cie_attach_touch('audit_log');
