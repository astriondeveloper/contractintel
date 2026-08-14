-- 0009_score_model_v1.sql
-- The starting weights from spec section 10.2, and the hard gates.
-- These are DATA, not code. A change here creates version 2. Spec 13, D2.

insert into taxonomy_version (version, created_by, notes, is_current)
values (1, 'CIE_Build_Spec_v1.0', 'Seed taxonomy from capability_taxonomy_seed.csv. 14 draft capability nodes.', true);

insert into score_model (score_model_version, created_by, notes, is_current)
values (1, 'CIE_Build_Spec_v1.0', 'Starting weights from spec section 10.2.', true);

-- Weights sum to 100. capability and past_performance are mandatory. Decision D3:
-- a pursuit gets no rank without both.
insert into score_model_factor
  (score_model_version, factor_code, factor_name, weight, is_mandatory, display_order) values
  (1, 'capability',           'Capability alignment',                    25, true,  1),
  (1, 'past_performance',     'Relevant past performance',               15, true,  2),
  (1, 'target_customer',      'Target customer alignment',               15, false, 3),
  (1, 'vehicle',              'Vehicle position or access',              15, false, 4),
  (1, 'technology',           'Technology alignment',                    10, false, 5),
  (1, 'competitive_position', 'Incumbent and competitive position',       8, false, 6),
  (1, 'growth_priority',      'Growth priority alignment',                7, false, 7),
  (1, 'value_timing',         'Value and timing fit',                     5, false, 8);

insert into score_model_gate
  (score_model_version, gate_code, gate_name, description, display_order) values
  (1, 'set_aside',   'Set-aside eligibility',
      'The solicitation is reserved for a socio-economic category that Astrion does not hold.', 1),
  (1, 'vehicle_access', 'Vehicle access',
      'The work must be ordered under a vehicle on which Astrion holds no position and no teaming path.', 2),
  (1, 'clearance',   'Facility clearance',
      'The work requires a facility clearance level that Astrion does not hold.', 3),
  (1, 'oci',         'Organisational conflict of interest',
      'An existing Astrion contract creates a disqualifying conflict.', 4),
  (1, 'response_window', 'Response window',
      'The response date has passed, or the remaining time is below the minimum to bid.', 5);

-- Guard: the sum of weights in a model must be greater than zero, and mandatory
-- factors must exist. Checked here so a bad admin edit fails loudly.
do $$
declare
  w numeric;
  m integer;
begin
  select sum(weight), count(*) filter (where is_mandatory)
    into w, m
  from score_model_factor where score_model_version = 1;

  if w is null or w <= 0 then
    raise exception 'score model 1 has no positive weight total';
  end if;
  if m < 2 then
    raise exception 'score model 1 must carry both mandatory factors. Decision D3.';
  end if;
end $$;
