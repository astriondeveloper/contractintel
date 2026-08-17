# Decisions

Every place this build departs from `CIE_Build_Spec_v1.0.md`, or resolves something the
spec left open. The spec is the controlling document; each entry says what it says, what was
done instead, and what forced it.

Order is chronological. Nothing here is a preference — every one was forced by the real data
or by a contradiction in the spec, and each names the measurement that forced it.

---

## D1. A UEI does not identify one entity

**Spec 8.2** gives the resolution order as UEI, then CAGE, then a confirmed alias, then a
review candidate. That assumes a UEI identifies one entity.

**It does not.** In `astrion_entity_map_seed.csv`, four UEI values and four CAGE values each
belong to two legacy entities, because registrations carried forward through the rollup:

| Identifier | Legacy entities |
|---|---|
| `ZZ1TESTUEI01` / `ZC001` | Northwind Group, LLC and Beacon Research, Inc. |
| `ZZ2TESTUEI02` / `ZC002` | Cardinal LLC and Quantalytic |
| `ZZ3TESTUEI03` / `ZC003` | Cardinal LLC and Meridian Engineering |
| `ZZ4TESTUEI04` / `ZC004` | Larkspur, Incorporated and Halcyon Systems, LLC |

A unique constraint on the identifier would have rejected the real data.

**Decision.** All eight collisions sit inside one family, so a UEI still identifies the
*family* unambiguously. The resolver treats an ambiguous identifier as a partial result: it
holds the candidate set, continues to the alias step which resolves the legacy entity
precisely, and falls back to the shared parent only if the alias step also fails. The steps
still run in spec order. Reported by the `identifier_collision` view.

**Also worth knowing.** Real award rows carry UEIs that are *not* in the seed map: a legacy
entity turns up under a registration the authored map does not list. Those rows resolve at
the alias step, which is why UEI coverage is well short of the whole corpus. The figures are
in the Phase 1 status document.

---

## D2. An unconfirmed authored alias still resolves

**Spec 8.2 step 3** says to match on a *confirmed* alias. **Spec section 20** ships all 50
seed rows with `confirmed_by_bd_ops = NO`.

Read together, nothing resolves by name until a person has confirmed all 50 rows, and
acceptance test 1 cannot pass on a fresh database.

**Decision.** The authored map is authoritative per spec 8.1 ("load the authored map"), and
confirmation is a quality signal on top of it:

- confirmed alias → confidence `confirmed`
- unconfirmed authored alias → confidence `probable`
- no match → `unresolved`, and the row goes to the review queue

The strict reading is available: `EntityResolver.load(client, { requireConfirmedAlias: true })`.
Both behaviours are tested.

---

## D3. The surrogate transaction number is the default

**Spec 7.2** keys `contract_action` on
`(awarding_agency_code, piid, modification_number, transaction_number)`.

**The export leaves `Transaction #` blank on all 49,013 rows.** FPDS-NG uses that column to
distinguish several transactions recorded against one modification, so the key degenerates to
three components and distinct transactions overwrite each other. Measured:

| | |
|---|---:|
| Modifications carrying more than one distinct transaction | 2,023 |
| Payloads the upsert overwrote | 4,912 |
| Action Obligation absent from `contract_action` | **$1,871,754,225** |

That is 18.6 percent of the $10.08bn corpus total — enough to change any ranking section 10
derives from contract value.

**Decision, taken by Gavin Taylor on 14 August 2026 with those figures in front of him.**
A blank transaction number is replaced by `H:` plus 12 hex characters of a SHA-256 over the
row's mapped payload with `transaction_number` removed. Deterministic, order-independent,
does not include itself, so the loader stays idempotent — verified by loading the corpus
twice, the second pass reporting all 49,013 rows unchanged.

**The cost.** The surrogate is content-derived, so an upstream correction to a mapped field
arrives as an additional action rather than an update. Audit columns are not mapped, so a
re-export that only touches timestamps does not trigger it.

**The handover needs no code change.** A row carrying a real transaction number always uses
it, so when the export is fixed the surrogate stops firing file by file. Populating that
column is an open external action.

`--spec-transaction-key` restores the literal reading and reports what it drops.
`fpds_collapse_summary` quantifies it at any time.

---

## D4. `Contractor: DACIS: Parent Name` is read but never used to resolve

The FPDS export carries Deltek's own view of which parent a contractor rolls up to. **Spec
8.2 does not list it** as a match step.

**Decision.** The loader reads it, archives it in the payload, and reports how many
otherwise-unresolved rows it would have rescued — so adding it to 8.2 can be decided from a
number rather than an opinion. It never affects resolution.

On this corpus the answer is zero, because the authored map resolves everything. The
instrumentation is there for the next corpus, where a spelling outside the 50 will appear.

---

## D5. The subcontract loader stores no direction

**Spec section 20** states 662 rows where Astrion is the sub and 3,381 where it is the prime.
Those are exactly the in-file and out-file row counts.

**Decision.** No direction column. "in" and "out" are relative to whichever company Deltek
was queried about, not properties of the relationship, and every row names its own prime and
sub. The same record appears in both files when both parties are Astrion, so it must land as
one edge. `teaming_direction` derives direction from which side resolves into the family.

Derived from the data: 3,382 prime, 660 sub. The two-row difference from the spec is fully
accounted — one row with no sub name, one intra-family an intra-family edge, and one
a third-party-to-third-party edge with no Astrion party on it at all.

---

## D6. An unresolved subcontract counterparty is not queued for review

**Spec 8.2** sends an unresolvable vendor to `vendor_review_queue`.

**For subcontract counterparties that would mean roughly 900 external companies** — the
graph names 936 distinct sub names against a 45-company watchlist — which would make the
queue useless for the thing it exists for.

**Decision.** An edge with one side resolved is kept, with both raw names and both CAGE
codes, and `teaming_direction` picks it up as soon as the counterparty becomes known. Only an
edge where *neither* side resolves is queued, because only that edge cannot be placed
relative to Astrion at all. On the real corpus that is 1 row out of 4,042.
`subcontract_edge_unplaced` lists them.

---

## D7. The DACIS contract loader must be told Astrion's role

This looks inconsistent with D5 and is the opposite case for a measured reason.

| role | rows | Astrion in `Companies` | in `Other Bidders` | neither |
|---|---:|---:|---:|---:|
| prime | 234 | 234 | 2 | 0 |
| out | 19 | 19 | 0 | 0 |
| sub | 141 | 11 | 2 | 128 |
| loss | 40 | 2 | 8 | 31 |

A prime row always names Astrion, so it is self-describing. A subcontract row usually names
it nowhere — the row describes the prime contract. A loss row names it nowhere on 31 of 40.

**Decision.** The export is the only carrier of the role for two of the four shapes, so the
loader records what it was told. `role_source` says whether a human declared it or the
filename was read. Role lives in `dacis_contract_role`, not on the contract, because 18 of
213 contracts arrive under more than one role.

---

## D8. `Other Bidders` is stored as evidence and nothing scores on it

It is the only place in the corpus naming who else bid, which makes it tempting.

**It is populated on 26 of 434 rows (6 percent), naming 18 distinct companies.**
`Programs-Losses` is populated on **zero** rows.

**Decision.** Store `Other Bidders` in full, in `dacis_contract_company` with
`company_role = 'other_bidder'`, and build no scoring factor on it. At 6 percent coverage a
factor derived from it would rank on whether Deltek happened to record the bidders rather
than on anything about the competition. `dacis_other_bidder` exposes it as evidence on a
specific competition.

---

## D9. Lost-as-prime plus held-as-sub is an outcome, not a conflict

Migration 0017 flagged any contract asserted both as a loss and as won. Five rows, and four
were `loss` + `sub`.

**That combination is coherent and common:** Astrion bid the prime, did not win, and holds a
subcontract on the winning team. It is one of the more actionable facts in the corpus,
because it names competitions where Astrion is already inside the winning team and could bid
the prime at recompete — including a $1.48bn Example SB Pool 6 task order ending 2028-07-17.

**Decision (migration 0018).** Split into two views.
`dacis_contract_lost_prime_won_sub` is a pursuit list and names the winner.
`dacis_contract_role_conflict` is narrowed to `loss` together with `prime` or `out`, which
cannot both be true — one row — and names the disagreeing export files.

A view called "conflict" that is 80 percent legitimate outcomes teaches people to ignore it.

---

## D10. Truncation is measured before de-duplication

The DACIS programs export caps its participant column at 500.

**Testing the de-duplicated count against the cap misses more than half of them.** Ten
programs were emitted at the cap; only four have 500 *distinct* participants, because the
cells repeat names.

**Decision.** `participant_list_truncated` is computed from `rawListLength`, the count of
entries the export emitted, before de-duplication. This was a real bug caught by comparing
the loader's output against an independent measurement of the same files.

---

## D11. No DACIS-derived data in this repository

**Gate A, spec section 6**, asked whether DACIS-derived data may be stored. Answered
**no** on 14 August 2026.

**What was in the repository before the answer arrived.** The three authored seed CSVs, and
test fixtures whose company names, UEIs and CAGE codes were taken from the real entity map —
deliberately, on the argument that a fixture with invented names tests the CSV parser rather
than the resolver. That argument was right about the risk and wrong about the remedy.

**Decision.** The remedy keeps the argument intact. `tests/seed/` holds a synthetic set that
reproduces every structural property the real map has and the tests rely on: four UEIs and
four CAGE codes each shared by two legacy entities, spellings differing only in punctuation,
an authored misspelling, a near neighbour that must stay separate, a near miss that must not
resolve, a parenthetical that is part of a name, and every row unconfirmed.
`tests/seed/README.md` tabulates each property against the test that needs it. So the tests
still exercise resolution rather than parsing, and no real company appears.

Consequences, all of them mechanical once the property table existed:

- `CIE_SEED_DIR` was already the only route to the seed files, so the application needed no
  change. `.gitignore` excludes `data/seed/*`.
- `Dockerfile` stopped copying `data/seed`; the directory is an empty mount point. Baking the
  files in would put them in every image layer and every registry the image reaches.
- Acceptance test 3 hardcoded two real spellings. It now discovers the punctuation-variant
  group from the loaded map and asserts the property spec 8.3 actually states, so it passes
  on the real corpus and on the synthetic one. Better than it was.
- Measured findings about real contracts moved to the Phase 1 status document. Aggregates
  stay here where a decision is unintelligible without them.
- The four earlier commits contained the CSVs and the real identifiers. Untracking does not
  remove them from history, so the history was rewritten to a single initial commit. Nothing
  had been pushed, so this cost nothing.
- CI fails on a tracked file under `data/seed/` and warns on anything shaped like a real UEI.
  A rule with no check is a rule that lapses.

**What remains a judgement call.** Aggregate figures derived from the corpus, and the names
of real competitor companies in analytical prose, are not source data but are arguably
derived from it. This repository keeps aggregates and no company names. If Contracts reads
Gate A more strictly, the aggregates in this file and in the migration headers are the next
thing to move to the status document; if more loosely, company names could come back into
`docs/BACKLOG.md` where they would make two items more concrete.

---

## D12. The repository is public, and the interface may be deployed with public ingress

**Decided by Gavin Taylor, 14 August 2026**, on the ground that everything the system holds
is open-source intelligence: FPDS is a public record, and the DACIS material is a commercial
aggregation of public sources rather than anything Astrion is under an obligation to keep.

`astriondeveloper/contractintel` is public. `docs/GITHUB_SETUP.md` had specified a private
repository in the Astrion organisation, written before this was settled; where the two
disagree, this entry is the later decision and it wins.

**What does not change.** D11 stands in full, and for a different reason than secrecy. The
seed files stay out of the repository, the image still does not bake them in, the fixtures
stay synthetic, and CI still fails on a tracked file under `data/seed/`. Two arguments
survive the OSINT finding intact:

- **A repository is a bad place for data regardless of its sensitivity.** The seed files are
  a snapshot. Committing one means every clone carries a copy that is wrong the moment the
  export is refreshed, and `git` keeps every version of it forever.
- **The authored seed files are Astrion's judgement, not the public record.** The entity map
  and the watchlist encode which spellings are the same company and who is worth watching.
  That is analysis, and it is the part with value in it.

So the rule is unchanged and only its justification is narrower: data does not belong in the
repository because it is data, not because it is secret.

**What does change.** Deployment gets a public option. `docs/DEPLOY.md` previously insisted
on internal ingress; it now offers both and says what each costs. The interface has no
authentication, so public ingress means anyone with the URL reads the corpus. That follows
from the OSINT finding rather than being made safe by it, and two things stay true:

- **Public ingress is a per-deployment choice, not a default.** `scripts/deploy-azure.sh`
  takes `--ingress external` explicitly and defaults to internal.
- **It stops being appropriate the moment the corpus stops being OSINT.** Pipeline
  judgements, capture strategy, and the campaign and pursuit tables are Astrion's own
  thinking. The scoring engine is the phase that starts filling them, and authentication
  belongs to the same phase as the first write screen, since spec section 20's audit trail
  needs an identity to attribute a change to.

---

## D13. A contract is identified by its vehicle and its PIID, not its PIID

**Spec section 9.1** asks for a signal when a contract is inside the recompete window.
`contract_action` holds transactions, so something has to say which transactions are the
same award, and the obvious answer is wrong.

**What forced it.** Agency 9700 PIID `0001` modification `0` carries 58 distinct payloads
on the supplied corpus, and `0002` and `0003` are similar. Those are not 58 modifications
of one contract. A task order PIID is assigned by the ordering office and is unique only
inside the vehicle it was ordered against, so `0001` is the first task order under this
IDV and also the first under every other one.

**Decision.** `contract_group`, in migration 0019, keys on
`(awarding_agency_code, coalesce(idv_piid, ''), piid)`. The awardee is deliberately not in
the key: a novation moves a contract to another company, and keying on the awardee would
split one contract in two and raise two recompete signals for one recompete. The incumbent
is read from the most recently signed action instead.

**The sharper edge, found while writing the tests.** `contract_action`'s own primary key is
spec 7.2's natural key, and the vehicle is not in it either. Two task orders numbered
`0001` under different IDVs collide on the primary key itself, not merely in a `group by`.
The only column separating them is the transaction number, which the export leaves blank
on every row.

That makes **D3 load bearing for recompete detection** rather than merely tidy. The
content-derived surrogate transaction number is what gives those task orders separate rows
at all. Loaded with `--spec-transaction-key`, one overwrites the other and the signal
appears on the wrong contract with nothing on screen to suggest anything is missing. When
the export populates `Transaction #`, the same property holds for a better reason.

**What remains a judgement call.** Where `idv_piid` is blank the key degenerates to
`(agency, piid)`, which is right for a standalone award and is the residual risk.
`contract_group_ambiguous` measures exactly that residue rather than assuming it away, in
the same spirit as `fpds_collapse_summary`. On a corpus where
`likely_unrelated_awards` is large, this decision needs revisiting before the signals are
trusted.

---

## D14. Two assumptions in recompete detection, both recorded rather than buried

Neither is measured. Both are stated here so they can be argued with.

**Twelve months of solicitation lead.** `expected_solicitation_fy` is derived as the fiscal
year twelve months before the contract ends. The figure comes from the window itself: spec
section 9 opens the recompete window at twelve months out, which only makes sense if that
is roughly when the follow-on is expected to appear. It is `SOLICITATION_LEAD_MONTHS` in
`src/signals/recompete.ts`; every generated row is rewritten from source on each run, so
changing it needs no migration. A measured lead time per agency would be better and is not
available from the corpus.

**A subcontract position is matched on PIID alone.** `subcontract_edge` carries a prime
PIID but no awarding agency, so the test that decides whether Astrion subs on a contract
can over-match on a short PIID in the same way the grouping can. It is used only to label
`astrion_position`, never to create a signal that would not otherwise exist, so a false
positive files a row under the wrong play rather than inventing an opportunity. Raising it
to certainty needs the reconciliation in backlog item 8.

---

## D15. The SAM.gov search is targeted by the profile, and refuses to run without one

**The brief**: opportunities that fit the company, looking further out than a solicitation
window. Both halves of that are decisions rather than settings.

**Targeting.** SAM.gov publishes every federal notice, and a feed nobody has curated is a
feed nobody reads. `opportunity_profile` is the curation, and it is built rather than
authored from nothing:

- **The taxonomy side** is `node_crosswalk`, which already carries the PSC, NAICS and agency
  crosswalk of every capability node from `capability_taxonomy_seed.csv`. That is BD's own
  statement of what the company does, expressed in exactly the codes SAM.gov filters on. It
  includes work the company wants and does not yet hold.
- **The corpus side** is the NAICS and PSC codes on Astrion's own contract actions and the
  agencies that awarded them, scoped through the entity rollup. It is evidence rather than
  intent, and it catches work the taxonomy has not caught up with.

A code that appears in both is a stronger statement than a code in either, so both rows are
kept and `opportunity_profile_effective` collapses them for the search. Five actions is the
floor on the observed side: below that a code is as likely to be a mis-coded transaction as
a line of business.

**The loader refuses to run when the profile is empty** rather than falling back to
searching for everything. A quiet fallback to the firehose is the failure mode this feature
exists to prevent, and it would be discovered only by the person reading the resulting list.

**Looking further out.** Restricting to notices closing in the next six months finds only
work that is already too late to shape. The notice type is the field that carries how early
a thing is, so it is kept raw and it sets the signal class: sources sought, special notice
and intent to bundle become `shaping_target`; presolicitation, solicitation and combined
synopsis become `active_solicitation`; award notices become `market_movement` and are
opt-in, being the highest-volume type and about work that is finished. An unrecognised type
is counted and skipped rather than guessed at.

**What remains a judgement call.** The profile searches on NAICS and PSC only, because
those are the codes the v2 endpoint filters on (`ncode`, `ccode`). Agency and set-aside are
collected for the score model's gates instead. One request per code per run means the
profile's size is the API bill: 25 codes is 25 requests, and a public key's daily quota is
finite. `--max-requests` caps it and the run says when it stopped early, because a
silently incomplete pipeline is worse than a short one.

---

## D16. What the scoring engine refuses to guess

Spec section 10 describes the model. Building it turned four things into decisions, and
each one is a decision to say "not known" where guessing would have been easier.

**Three gates cannot be evaluated and say so.** There is no facility clearance data in the
corpus, on the requirement or on Astrion, and no conflict-of-interest register. The vehicle
a solicitation will be ordered under is rarely stated. Those return `not_evaluated` with a
reason naming what is missing. **`not_evaluated` is not `pass`**, and the interface shows the
difference: a gate reported as cleared is a gate nobody checks again.

**The set-aside gate never fails.** The only evidence available is which set-asides Astrion
has previously been awarded under. Having won under a category is good evidence of holding
it; never having won under one is not evidence of not holding it, because the company may
hold a status it has not used or gained one since the export. Failing a pursuit on that
inference would drop real opportunities silently, and a thing that vanishes leaves no trace
to notice. So an unrecognised set-aside is `review`: a person checks the status.

**Zero and unknown are kept apart everywhere.** A pursuit whose codes are known and match
nothing on the profile scores capability zero, because the question was asked and answered.
A pursuit with no codes at all is `unknown`, keeps its weight in the denominator, and costs
coverage. The distinction is enforced by the database as well as the code: `factor_result`
has a check constraint that a score exists only in the `scored` state.

**The rank is the strategic fit and nothing else.** Spec 10.1 gives four outputs and says
not to merge them, so timing urgency and evidence confidence sit beside the fit on the
screen and are never folded into it. Ordering by a blend would produce a number that moves
for reasons nobody can name.

**What this costs, and it is worth stating plainly.** On a corpus where BD Ops has not
filled in `growth_priority` and the taxonomy carries no technology nodes, two factors worth
17 of the 100 weight are unanswerable. Coverage is therefore rarely near 100 percent, and
the floor at 0.60 is doing real work rather than sitting unused. The number goes up when BD
fills the columns in, which is the intended incentive.

---

## Open questions

**Gate B — is the GovWin API available?** Owner: Gavin.

**Gate C — does the Salesforce Opportunity hold a government key?** Owner: BD Ops.

**Short PIIDs are not unique.** Agency 9700 PIID `0001` modification `0` carries 58 distinct
payloads; `0002` and `0003` are similar. Anything that groups contract actions by PIID —
recompete detection especially — has to handle it. Not yet investigated.

**Populate `Transaction #` in the DACIS/FPDS export.** See D3. No code change follows.
