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

## D17. A subscription, not an assignment

**The spec section 9 pipeline states and `pursuit.owner` describe a system of record.** One owner
per opportunity, a funnel state, a snooze, an assignment list. That is the right shape for the
system that holds the truth about a pursuit, and TechnoMile is that system.

**It is the wrong shape for this one.** Twenty-odd BD people who check occasionally, reading
mostly. An owner column across that population produces a list of things nobody has picked up,
which reads as a backlog and gets avoided; and it forces a decision about who owns a requirement at
the exact moment nobody yet knows enough to own it.

**Decision.** The interface moved from assignment to subscription.

- A **follow** is per person: a capability node, an agency, an office, a company, or a raw NAICS,
  PSC or keyword. `follow_pursuit` matches them against requirements and says which follow matched,
  so the feed can answer "why is this in front of me".
- A **feed** is the union of one person's follows, ordered by when things landed. There is no
  bottom to it and no "done", only "seen", so nothing accumulates as a debt.
- **track, dismiss and sent** are per person. Two people can reach opposite conclusions about the
  same requirement and both are true statements about who thought what. A shared verdict would
  make one of them the owner again.

**What was kept.** `pursuit.owner`, `pursuit.state` and `pursuit.snoozed_until` are still on the
table with whatever rows were written to them, and `pipeline_item` still exists. Migrations here
are forward only, and a column the interface stopped reading costs nothing next to a column that
has to be restored when somebody asks what happened to the funnel. What changed is which screens
exist. `/pipeline`, `/my-work` and `/upcoming` redirect to the feed rather than 404ing a bookmark.

**Two judgement calls inside it.**

A **capability follow matches on what the work is, not on who buys it.** A taxonomy node crosswalks
to NAICS, PSC, keywords *and* agencies. Matching on the agency crosswalk would mean following one
capability quietly subscribed you to every notice that agency posts, which is the firehose D15
exists to avoid, in a different costume. Following a buyer is a separate, explicit choice.

A **company follow matches through the entity rollup.** Following the top of a corporate family
catches the family; following one subsidiary catches that subsidiary and not its sister companies.
It also matches a company in any role on a requirement, not only as incumbent, because decision D5
is that partner and competitor are per-pursuit roles and "what is happening around this company" is
the question a company follow is asked.

**The read mark moves only when a person moves it.** Advancing it on page load is the obvious
implementation and it loses the item somebody was halfway through reading when they hit refresh.
It is also a GET that writes, which is exactly what the router refuses to have. So it is a button,
and with no mark set the feed shows a fourteen-day window and says so rather than declaring the
whole corpus new on a first visit.

---

## D18. `sent` is the only measure of whether this tool works, so nothing can erase it

**The count of requirements a person carried from here into TechnoMile by hand.** Not sign-ins, not
rows loaded, not notices matched, not the size of the feed. Every one of those can look healthy
while this stays at zero, and if it does stay at zero the honest conclusion is that the tool is not
earning its place.

**Decision.** `pursuit_action` holds a set of rows per person rather than one state column, and
`sent` is not the opposite of `track` or `dismiss`. Tracking clears a dismiss and dismissing clears
a track, because those two are genuinely opposites. Neither touches `sent`. A person who hands a
requirement to TechnoMile and then dismisses it from their own feed has still handed it over, and
held as a single state column that fact would be gone.

Undoing a send is its own action with its own audit row, so the number cannot drift downwards as a
side effect of tidying a feed.

**The second number, and it matters as much.** `technomile_handoff.days_before_response_due` is how
far ahead of the deadline each hand-off happened. Being early is the entire proposition: a healthy
count with a median of four days would mean the tool is technically working and practically
pointless. Both figures are on `/handoffs`, which is deliberately plain, because it is the screen
somebody puts in front of leadership and a screen built to persuade is a screen nobody believes
twice.

---

## D19. What the forecast projects, and what it refuses to claim

**The forecast is the highest-value screen here and the only one that can be quietly wrong for two
years.** Every other screen shows something the corpus already contains. This one makes a claim
about 2029.

**The projection is one line of arithmetic**, stated on the screen rather than hidden:

    projected solicitation date  =  period end date  −  lead time

**Two things end and therefore project.** A contract ending has to be re-competed or let go. A
vehicle ending has to be replaced, and the replacement is competed on-ramp by on-ramp, which is
usually a larger and earlier opportunity than any of the task orders under it. Treating a vehicle
as another contract would file the biggest opportunities in the corpus under the smallest heading,
so it is a separate basis with its own evidence.

**The lead time comes from one of three places and every row says which.**

| Source | What it is | Bar it has to clear |
|---|---|---|
| `observed_notice_lag` | The office's own measured days from posting a notice to signing the award, from solicitation numbers that appear in both SAM.gov and FPDS | 3 matched notices |
| `office_cadence` | Inferred from how often the office re-lets the same PSC, plus how far before the previous end date it awards the follow-on | 3 observed chains, and a median interval between 1 and 10 years |
| `default` | 365 days, decision D13's assumption | none, and it is labelled an assumption |

**A cadence is inferred from adjacency, because FPDS carries nothing better.** A recompete arrives
as a new PIID with no pointer back to what it replaced. What FPDS does say is when each award
started and ended, in which office, for what product or service code. So a follow-on is inferred
from the same office buying the same PSC again around the time the previous award ends: six months
early through twelve months late, asymmetric because an office awarding before the incumbent's
period runs out is a well-run recompete and one awarding a year late is a bridge or a protest. One
successor per award, the earliest qualifying one, or an office with twenty awards under one PSC
produces a few hundred pairs and the median measures how busy the office is rather than the rhythm
of anything in it.

**An award with no PSC contributes nothing.** A cadence is a claim about a *kind of work*
recurring, and an award with no product or service code says nothing about what kind of work it
was. Grouping the code-less awards together would invent a category called "unclassified work in
this office" and then measure its rhythm. `award_shape_excluded` counts what that leaves out.

**What it refuses to do.**

- **It never writes a `pursuit`.** A forecast says a requirement is likely; the feed says one
  exists, and the feed's whole claim is that everything in it is real. Where a requirement for a
  forecast contract has already been detected, the forecast row points at it and says so rather
  than counting it twice in the same quarter.
- **It shows its low-confidence rows.** A quarter with four weak projections and a quarter with
  nothing in it are different facts, and hiding the weak ones makes them look the same.
- **It caps confidence when the contract identity is not certain.** `contract_group_ambiguous` from
  D13 reaches the confidence band rather than sitting in a diagnostic view: if a PIID might be two
  unrelated awards, the end date might belong to the other one, and nothing downstream recovers
  from that.
- **It treats no recorded value as no recorded value.** A contract with no ceiling reaches the
  volume of its quarter and not its value, and each quarter reports how many of its rows did that.
  The total is labelled a floor.
- **Stale rows are pruned.** A `pursuit` is a real thing and survives a re-detection. A forecast is
  wholly derived, so a projection whose contract has been extended past the horizon is deleted:
  a derived table that keeps rows nobody would derive again slowly stops being true.
- **A vehicle is never high confidence** unless the office has a measured notice lag. The lead time
  a vehicle gets is the contract lead time, which is very probably too short, and nothing in this
  corpus measures how much too short. Rather than inventing a multiplier the projection records the
  shortfall as evidence against itself.

---

## D20. The forecast is scored backwards, and the leak that would have made the score meaningless

**Accuracy cannot be checked forwards without waiting two years.** So `npm run forecast:backtest`
recomputes the projection as it would have stood on a past date and checks it against what the
corpus says happened next.

**The claim being scored is "this contract will be re-competed", not "a contract ending in March
ends in March".** Plenty of contracts end and are never re-let: the work stops, gets absorbed into
a bigger vehicle, or the office extends the incumbent for years. A projection hits when the corpus
shows a follow-on award succeeding the same contract, awarded after the as-of date, landing within
the tolerance of the projected period end. The tolerance is generous about timing and strict about
subject, and it is recorded on every run: a hit rate without its tolerance is not a number.

**The leak.** Filtering out awards signed after the as-of date is the obvious half. The half that
bites is the **modification**: a contract whose end date was extended by a modification signed in
2025 shows a 2029 end date today, and a 2023 projection using it would be projecting from a fact
that did not exist yet. It would score well and mean nothing.

So the end date is aggregated *inside* an as-of filter rather than the view being filtered
afterwards. That is why `cie_award_shape_asof(date)` is a function and not a view, and why
`cie_followon_chain_asof(date)` is too: a rhythm learned from the award being predicted is the same
leak wearing a different hat. Without both, `src/forecast/backtest.ts` would produce a reassuring
number and nothing else.

**What the hit rate does not measure.** Recall over every recompete in the window, because the
forecast projects every contract ending in its horizon and would score close to one by
construction. `unforecast` measures the useful version instead: recompetes that happened in the
window whose contract the forecast had no candidate for, because its end date fell outside the
horizon or the contract carried no office or PSC. That is a statement about coverage, and it is the
number that says what the forecast is blind to.

**The bands make a falsifiable claim about themselves.** High confidence should beat low. If a
sweep of as-of dates shows them level, the banding is decoration, and the honest response is to say
so on the screen rather than keep three colours of chip. `npm run forecast:backtest` prints that
comparison, and `/forecast` shows the latest run's rates side by side.

---

## D21. The hand-off is four things, because the four are not substitutes

**No TechnoMile integration**, and that is the decision rather than a gap. What it leaves is a
copy-and-paste problem, and a copy-and-paste problem done badly is how a tool gets abandoned:
somebody who has to re-type nine fields will do it twice and then stop using the thing that made
them.

**Decision.** All four shapes, on the requirement screen, above the score rather than below it.

- **The field block.** Label and value, one per line, in a box that selects on click. Codes carry
  their labels, because nobody pasting into TechnoMile will look up what `6920` means and the
  record would carry the number for ever.
- **The written summary.** A paragraph for a description field or an email, assembled from the same
  fields so the two cannot disagree about a date. Nothing in it is inferred, and where the record is
  silent the sentence is left out rather than hedged: "the value is unknown" reads as a finding when
  it is an absence.
- **The SAM.gov link.** For the person who wants to read the notice rather than a summary of it.
- **The spreadsheet.** A multi-select CSV export from the feed, for the hand-off that is thirty
  rows rather than one.

**Blank is handled differently in the block and in the CSV, on purpose.** In the block a missing
value reads `not recorded`, because a gap in a pasted block reads as something the sender forgot to
fill in. In the CSV the same value is an empty cell, because a spreadsheet sums a column and
`not recorded` is not a number. Neither is ever a zero.

**A CSV cell beginning `=`, `+`, `-` or `@` is executed as a formula when Excel opens the file.**
Federal notice titles begin with all four and a set-aside code of `-` is not unusual, so every cell
is prefixed with a single quote when it starts with one of them. The file carries a UTF-8 byte order
mark and CRLF line endings, because it is opened in Excel on Windows and without the mark a vendor
name carrying an accent arrives as mojibake.

---

## D22. TAM from this corpus is a floor, and saying so is the whole decision

**Spec section 11** asks for TAM, SAM and SOM per campaign. TAM is the total addressable market:
every dollar every agency spent on this kind of work.

**That is not in this corpus and is not derivable from it.** What is loaded is Astrion's own history
plus the competitors on the watchlist, which is a targeted extract rather than the federal market.
Summing obligations under a campaign's codes and labelling the result TAM would produce a number
that is wrong by an unknown multiple, looks entirely plausible, and would be quoted in a review
within a week. It is the single most damaging figure this system could emit.

**Decision.** Compute it, label it a floor, and make the label impossible to lose.

- Every sized campaign carries a `corpus_is_not_the_market` row in `campaign_sizing_evidence` with
  `supports = false`. It is written on every run and cannot be turned off.
- `/campaigns` states it above the figures rather than in a footnote, and the campaign detail screen
  shows caveats before it shows arithmetic.
- `npm run size` prints it under every campaign, and `/api/campaigns` carries it as a named field so
  a reader of the JSON cannot miss what a reader of the screen is told.

**SAM is the sounder figure and the screens say that too.** A campaign that names its offices has
stated where it competes, so restricting the same obligations to those offices is a claim the corpus
can actually support. **A campaign that names no offices gets no SAM at all** — null, with a caveat
naming what is missing — rather than falling back to TAM. Falling back would report an addressable
figure under a served label, which is the kind of substitution nobody catches.

**The capture rate is measured, and it never travels without its sample size.** Astrion's share of
the served market's obligations, with the count of awards behind it, and a standing in words rather
than a threshold: *too few awards to be a rate* below ten, *thin* below forty. Spec 11.2 asks for the
sample size beside the rate and acceptance test 9 now asserts it against `campaign_summary`, which is
the view both the screen and the CLI read — asserting it against the table would pass on a build
whose screen had quietly dropped it.

**One arithmetic trap worth recording.** An award matching several of a campaign's codes must count
once. Joining `campaign_code` rather than testing it with an `exists` multiplies the obligation by
the number of matching codes, and the result stays a plausible-looking number. `cie_campaign_market`
uses `exists`, and a test asserts the exact figure rather than that it is greater than zero.

**Campaigns are defined at a command line, not in the interface.** `signal_class_threshold` and
`opportunity_profile` are both BD Ops data managed that way already, and a campaign definition
belongs with them: it is the shape of the market rather than something anybody works day to day.
It also keeps the write surface at the three endpoints the router allows. `--actor` is required on
anything that writes, because there is no signed-in user at a command line and an audit trail full
of "system" is worse than none.

---

## D23. The digest is rendered and not sent, and the read mark is why

**The spec put email and Teams out of scope, and in-app first was right.** A notification nobody
asked for trains people to ignore notifications.

**But nothing here reaches anybody until they sign in.** With 20-odd people checking occasionally
that is the main risk to the whole system being used, and it is a risk no amount of work on the feed
addresses. The feed can be perfect and unread.

**Decision.** Build the part that is hard and stop at the part that is easy. `npm run digest`
renders per person, in text and HTML, and sends nothing. What is left is a transport against
`subject`, `text` and `html`, which is a dozen lines for whoever owns the relay, written against a
shape they can already read rather than one they have to guess at.

Four rules, each from a way a digest fails, and each now a test:

**It is per person.** `/api/feed` is scoped to nobody deliberately, because an unauthenticated
endpoint returning one person's patch would be an authorisation bug. The digest reads each
principal's own follows, so what somebody receives is what their own feed would show them.

**Nothing goes out when there is nothing.** Most weeks in most patches are quiet. `render` returns
null rather than a cheerful nothing, and `renderAll` omits those people entirely, so an empty result
means send no mail rather than send empty mail.

**The subject line carries the content.** "3 new in your patch: 2 recompetes and 1 sources sought at
EXAMPLE RANGE OPERATIONS" is read; "Your weekly digest" is not. It is assembled from what is
actually in the digest, names one office where one dominates and counts them where the work is
spread, and reports the true total rather than the length of the list it was handed.

**It never moves the read mark.** This is the one that would do real damage. A digest is a copy of
the feed, not a visit to it, and advancing `feed_watermark` because an email was generated would
empty the screen the person opened the email to read.

**A fifth rule turned up while building it.** Somebody who follows nothing gets no digest at all.
There is nothing personal to send them, and the right nudge for that person is a colleague rather
than mail from a system they have not finished setting up.

**The HTML is inline-styled on a light ground**, which is not a preference. A mail client is not a
browser: it strips a stylesheet and ignores a class. And a dark email in a light inbox reads as a
phishing attempt, so the interface's dark ground does not follow it out of the building.

---

## D24. The stub is committed, because the HTTP path was the one thing nothing exercised

`CONTRIBUTING.md` had always said to point `SAM_API_BASE` at a local stub, and left the stub as an
exercise. That instruction was worse than useless: the tests inject `fetchPage`, so `httpFetch` —
the one function that actually talks to SAM.gov — was the one function nothing ran.

**Decision.** `npm run sam:stub` is committed and serves the v2 endpoint's shape, including the
parts a lenient stub would hide:

- 401 without an `api_key`, as api.data.gov answers
- 400 without `postedFrom`/`postedTo`, which the v2 definition requires whenever `limit` is given,
  and 400 on a date that is not `mm/dd/yyyy`
- real pagination, so `offset` and `totalRecords` are exercised rather than assumed

Its notices are deliberately awkward: one title begins with `=`, which Excel executes as a formula
on CSV export; one carries no response deadline, as a sources sought often does not; one is a notice
type the loader does not recognise, so the skip-and-count path runs. Every identifier is
`ZSTUB`-prefixed so none can be mistaken for a real solicitation.

Running the real loader against it confirmed the whole chain end to end — parameters, pagination,
classification, idempotence on a second run, and that the API key never reaches an archived payload.
The only untested thing left is a real key.

---

## Open questions

**Gate B — is the GovWin API available?** Owner: Gavin.

**Gate C — does the Salesforce Opportunity hold a government key?** Owner: BD Ops.

**Short PIIDs are not unique.** Agency 9700 PIID `0001` modification `0` carries 58 distinct
payloads; `0002` and `0003` are similar. Anything that groups contract actions by PIID —
recompete detection especially — has to handle it. Not yet investigated.

**Populate `Transaction #` in the DACIS/FPDS export.** See D3. No code change follows.
