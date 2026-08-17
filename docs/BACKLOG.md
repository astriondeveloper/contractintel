# Backlog

The remaining phases in dependency order. Each entry is written to be filed as a GitHub
issue more or less verbatim, using `.github/ISSUE_TEMPLATE/build-task.md`.

Sizes are relative to what has been built, not absolute. For calibration: the FPDS loader
plus the header mapping and two defect fixes was a **medium**; the three DACIS loaders plus
the router was a **medium**; the subcontract loader was a **small**.

The schema is largely already in place — spec section 7 is fully migrated — so most of these
are logic and interface rather than tables.

---

## 1. Populate `Transaction #` in the DACIS/FPDS export — small, external

**Not a code task.** The export supplies the column and leaves it blank on every row. See
`docs/DECISIONS.md` D3: keying as spec 7.2 describes drops $1.87bn of obligated dollars, and
the surrogate that avoids it is content-derived, so a corrected transaction re-arrives as a
new action rather than an update.

Ask whoever runs the export to include the transaction number. The loader needs no change:
a row carrying a real number always uses it, so the surrogate stops firing file by file as
corrected exports arrive. `fpds_collapse_summary` reads zero when it is done.

**Verified by** `select * from fpds_collapse_summary;` returning zeros on a fresh load.

---

## 2. Scoring engine — spec section 10 — large — **built**

**Acceptance tests 4, 5, 6 and 7 pass.** `src/scoring/`, `npm run score`, and the
`/pursuits/<id>` screen, which is the rule trace test 7 asks for.

Every trap below was real and each is now pinned by a test. The denominator one is asserted
directly *and* asserted not to equal the wrong answer, because both denominators produce a
plausible number and only one of them is right. `docs/DECISIONS.md` **D16** records what the
engine refuses to guess.

Still open from this item: `value_is_shared` is honoured only in that a shared-value DACIS
contract carries no estimated value into the signal, so no factor derives from a figure
covering several awardees. Apportioning them properly needs the reconciliation in item 8.

The original entry follows, because the traps it names are still the traps.

---

Already in place: `score_model`, `score_model_factor`, `score_model_gate`,
`signal_class_threshold`, `assessment`, `factor_result`, `gate_result`, `evidence_ref`, and
one seeded model version with starting weights.

To build: the evaluator that turns a pursuit into an `assessment`, one `factor_result` per
factor, one `gate_result` per gate, and an `evidence_ref` per claim.

**Watch out for:**

- **Divide by applicable weight, not known weight.** Spec 10.3. This was defect 2 in the
  Codex baseline and it is the single easiest thing to get wrong here. A factor that does not
  apply must leave the denominator, not score zero.
- **A failed gate shows no score at all**, not a low score. Acceptance test 5.
- **Every score opens a rule trace with a source link.** Acceptance test 7. `evidence_ref`
  exists for this; a score without one should not be storable.
- **Weights are rows, not code.** Every `assessment` pins the `score_model_version` and
  `taxonomy_version` it was computed under, so changing a weight cannot alter a past score.
  Acceptance test 6 checks this.
- **`value_is_shared`** on `dacis_contract` means the value covers several awardees. Any
  factor derived from contract value must exclude or apportion those ten contracts.
- **Blank is not zero** anywhere in the money columns.

**Verified by** acceptance tests 4 through 7, plus a factor-level unit test per factor that
fails if the denominator is wrong.

---

## 3. Recompete detection — spec section 9.1 — medium — **built**

**Acceptance test 8 passes.** `migrations/0019_signal_generation.sql`,
`src/signals/recompete.ts`, `npm run signals`, and the `/upcoming` screen.

The short-PIID trap below turned out to be sharper than it reads: the collision is on
`contract_action`'s primary key, not only in a `group by`, so decision **D3** is what makes
detection correct at all. `contract_group` keys on the vehicle as well as the PIID, and
`contract_group_ambiguous` measures what is left. `docs/DECISIONS.md` **D13** and **D14**
record the identity decision and the two assumptions.

Still open from this item: the reconciliation in item 8 would let a subcontract position be
matched on more than a PIID.

The original entry follows, because the traps it names are still the traps.

---

The candidate set already exists: 636 contract actions fall in the 12-to-36-month window, and
`dacis_contract.end_date` adds the DACIS side. `dacis_contract_lost_prime_won_sub` is the
highest-value input — four contracts Astrion lost as prime and holds a subcontract on,
including a $1.48bn Example SB Pool 6 task order ending 2028-07-17 and two CQ Venture task orders
ending 2026-09-30.

**Watch out for:**

- **Short PIIDs are not unique.** Agency 9700 PIID `0001` modification `0` carries 58 distinct
  payloads; `0002` and `0003` are similar. Grouping actions by PIID to find a contract's end
  date will merge unrelated contracts. This is unresolved and this task is where it bites.
  Investigate before writing the grouping.
- A recompete signal on a contract Astrion already subs on is a different play from one on a
  contract it has no position on. The distinction is available and worth carrying.

**Verified by** acceptance test 8, and a spot check that the two CQ Venture task orders appear.

---

## 4. Campaign sizing and the gap report — spec section 11 — medium

**Unblocks acceptance tests 9 and 10.**

`campaign`, `campaign_node`, `campaign_office` and `pursuit` exist, including
`capture_rate_sample_size`, which acceptance test 9 requires to be displayed beside the
capture rate.

New inputs now available: `program` with 74 programs and their participant lists, and
`program_competitive_overlap`, which gives per-program counts of Astrion, watchlist and
unknown participants — a reasonable basis for SAM. The two `pre_rfp` programs are the only
pipeline source in the corpus that predates a solicitation.

**Watch out for:**

- **`participant_list_truncated`.** Ten of 74 programs were emitted at the export's 500 cap,
  so their participant counts are floors. A SAM computed from a truncated list must say so.
- Acceptance test 9 is about *showing the sample size beside the capture rate*, not about the
  rate being good. A capture rate from three pursuits is not a capture rate.

---

## 5. Interface — spec sections 14 and 15 — large

**Unblocks acceptance tests 11 and 12.**

**Watch out for:**

- **No text smaller than 12 pixels.** Acceptance test 11, enforced by a stylesheet check
  rather than a database query.
- **Archivo, not a fallback face.** Acceptance test 12.
- **The evidence rail.** Section 15. Every figure traces to a source record.
  `source_version` holds every payload ever loaded, keyed by hash, so the rail can show the
  actual source row rather than a restatement.
- Customer names are now available. `customer_org` has 854 rows with acronyms and addresses,
  and `code_label` carries agency and office names, so the interface can show
  `EXAMPLE AVIATION ADMINISTRATION` rather than `6920` without another data source.

---

## 6. DACIS company profile loader — small

The two `BSC-*` exports are the only shape `npm run load` recognises but cannot load. 16
columns of company profile: code, name, city, state, country, address, URL, previous names,
parent, ownership, organisation, chronology.

`Previous Names` and `Parent` are the interesting columns — they are an independent source
for the rollup relationships the authored entity map asserts, so loading this is a way to
check the map against Deltek rather than trusting it.

**Watch out for:** the header `DACIS Link` appears **twice** in these files.
`buildSubcontractColumnMap` already takes the first occurrence; a new mapping must do the
same or the parser will mis-align.

---

## 7. Watchlist expansion from the observed graph — small

Not in the spec, but the data is sitting there and it answers a question section 20 asks.

`subcontract_counterparty_offwatchlist` names 918 counterparties outside the authored map,
five of which team with Astrion in **both** directions and are absent from the 45-company
watchlist: Summitline International (14 edges), Granitehawk Aerosystems (6), Confluence Innovation (4), Westford Services (2), Granitehawk Systems (2). By value the largest
absences are Peakstone, LLC at $453m across 8 edges and Upland Mission Technologies at $329m
across 11.

The task is a review screen that proposes additions and lets BD Ops confirm them, writing
confirmed rows into `entity` and `entity_alias`. The observed graph already found two
competimates the seed file hid; this makes that repeatable.

---

## 8. Reconcile the DACIS and FPDS views of the same contract — medium, speculative

`dacis_contract.contract_number` and `contract_action.piid` describe the same awards from two
sources with different grain: 213 DACIS contracts against 22,624 FPDS transactions. DACIS
carries the narrative — title, brief, competitors, programs, customers. FPDS carries the
money and the modification history.

Joining them would let the interface show a contract's story next to its obligations. Nothing
in the spec asks for it, and `contract_number` holds semicolon-separated lists on some rows
(`ZIDV0001: ZT8721-24-F-B004; ...`), so the join is not clean. Worth a spike before it
is worth a plan.

---

## Not planned

**A scoring factor from `Other Bidders`.** 6 percent coverage. See `docs/DECISIONS.md` D8.

**Anything from `Programs-Losses`.** The column is populated on zero of 434 rows.

**Demo data.** Spec section 16: none, build against the real corpus. Defect 7 in the Codex
baseline was 38 KB of fake opportunities. Test fixtures are generated at run time and are not
demo data — see `tests/fixtures/README.md`.
