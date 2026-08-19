# Contract Intelligence + Integration Engine

**Created by Gavin Taylor.**

Phase 1 implementation of `CIE_Build_Spec_v1.0.md`. The specification is the controlling
document; where this build departs from it, `docs/DECISIONS.md` says so and why.

TypeScript on Node 22, PostgreSQL 16, forward-only SQL migrations, no ORM, no mocks in the
tests. One container, deployable to Azure Container Apps by changing two environment
variables.

## What this is for

Catching federal requirements early, in the areas Astrion competes in, and handing them to
TechnoMile before anyone else has noticed them.

**It feeds TechnoMile and never replaces it.** Ownership, funnel states, capacity and win
probability live there. What lives here is the part TechnoMile cannot do: watching the federal
market for work in your patch, and being early. Nothing on any screen reads as a system of record,
and the one number that says whether this tool is doing anything is the count of requirements
somebody carried across by hand.

The working loop is four screens. **Follows** is your patch in your own words. **Feed** is what is
new in it since you last looked. **Forecast** is what is coming, by quarter. **Hand-offs** is what
reached TechnoMile.

## State

The data foundation is built and verified against the real corpus, requirements are detected from
it and from SAM.gov, every requirement is scored against a versioned model, a per-office forecast
projects what is coming, and the interface is a personal feed over all of it.

| | |
|---|---|
| Schema | 52 tables, 36 views, 24 migrations |
| Follows | Capability areas, agencies and offices, companies, and raw NAICS, PSC or keyword |
| Scoring | 8 weighted factors, 5 hard gates, an evidence row per claim |
| Forecast | Contract ends and vehicle expiries, per-office lead times, an evidence row per fact, backtestable |
| Loaders | FPDS transactions, FPDS subcontract edges, DACIS customers, programs, contracts, SAM.gov notices |
| Loaded | 22,624 contract actions, 4,042 subcontract edges, 854 customers, 74 programs, 213 DACIS contracts |
| Entity resolution | 100 percent of the FPDS corpus resolved; review queue empty |
| Interface | Nineteen screens, server rendered, no client bundle, three write endpoints |
| Tests | 557, against a real PostgreSQL 16 |
| Market sizing | TAM, SAM and SOM per campaign, with an observed capture rate and its sample size |
| Acceptance tests | **12 of 12 pass**, 0 fail, 0 blocked |

`npm run accept` prints the current state of all twelve. **Blocked** means a test names its
dependency; a **FAIL** is a real problem and CI treats it as one.

Eight of the twelve read the corpus or need a campaign, so on a fresh clone they report blocked
rather than passing and the count is 4 of 12. That is the honest reading of an empty database and
not a regression: load a corpus, define a campaign, run the jobs, and all twelve run.
`npm run readiness` says which of those is missing.

## Start here

```bash
cp .env.example .env
docker compose up            # PostgreSQL 16, migrations, seeds, and the interface
```

Then open **http://localhost:3000**.

Or without Docker, against any PostgreSQL 16 you can reach:

```bash
npm install && npm run migrate && npm run seed
npm run web                  # http://localhost:3000
npm test
```

The interface renders against an empty database on purpose: no data is in this repository, so
a fresh clone has none, and every screen says what would fill it rather than showing a blank
panel. Full setup is in **`CONTRIBUTING.md`**.

To put it on Azure Container Apps, from nothing, in one command:

```bash
az login
./scripts/deploy-azure.sh --resource-group cie --location eastus
```

That creates the registry, database, environment, migration job and app, and prints the URL.
It is also the redeploy command. **`docs/DEPLOY.md`** covers the rest, including public
ingress and the fact that the interface has no authentication.

## The interface

| Screen | What it answers |
|---|---|
| Dashboard | What is new in your patch, what is coming, and whether any of it reached TechnoMile |
| Feed | What is new on your follows since you last looked. Track, dismiss or hand off, per person |
| Follows | Your patch: capability areas, agencies and offices, companies, raw NAICS, PSC or keyword |
| Early requirements | What GovWin is tracking before it is advertised. An estimated date is a month and says whose estimate |
| Forecast | What will solicit and roughly when, by fiscal quarter, with the contracts behind each bar |
| Hand-offs | Every requirement somebody carried into TechnoMile, and how far ahead of the deadline |
| Requirement | One requirement, its hand-off panel, and the rule trace behind every figure of its score |
| Entities | One row per resolved company; the detail screen lists every spelling it answers to |
| Contract actions | The FPDS corpus, with the vendor string as filed beside the entity it resolved to |
| Teaming | Prime-to-sub edges, and which side Astrion is on |
| Customers, Programs, DACIS contracts | The DACIS reference exports |
| Capabilities | The capability tree and its crosswalks |
| Watchlist | Observed teaming direction against what the seed file stated |
| Review queue | Everything the resolver refused to decide alone |
| Data quality | The seven views that keep known source defects visible |
| Acceptance | The twelve tests from spec section 18, run live |
| Campaigns | TAM, SAM and SOM per capability area, and the gap report of what no campaign claims |
| Overview | What is loaded, how it resolved, when each source last landed. Unlisted in the rail |

### Writing

**Writing is answered on three shapes of path and nowhere else**, and every one refuses without a
signed-in principal. Spec section 20 requires an audit row on every change, and a narrow set of
write endpoints is what makes "the audit trail cannot be bypassed" a property of the router rather
than a habit of whoever wrote the last handler.

```
POST /requirements/<id>/<action>   track, dismiss, clear, sent, unsent, note
POST /follows/<action>             follow, unfollow
POST /feed/mark-read               move your read mark
```

Everything else is `GET` or `HEAD`. `/export.csv?id=…` is a GET because it writes nothing: it is a
different rendering of rows the requester can already read.

Identity comes from Microsoft Entra through Azure Container Apps, which terminates sign-in in front
of the container. With `CIE_AUTH_MODE` unset the interface is entirely readable and every write is
refused with the reason, which is the secure default: a misconfigured deployment should lose the
ability to write rather than gain the ability to impersonate. `docs/DEPLOY.md` has the commands.

`/api/dashboard`, `/api/feed`, `/api/forecast`, `/api/handoffs`, `/api/campaigns`, `/api/overview`,
`/api/acceptance` and `/api/quality` return the same numbers as JSON, and `/healthz` answers a
container probe without touching the corpus.

`/pipeline`, `/my-work`, `/upcoming` and `/pursuits/<id>` redirect: they were the ownership model
this build replaced, and a bookmark should not 404. `docs/DECISIONS.md` **D17** says why the model
changed.

## Follows and the feed

A follow is per person. A feed is the union of one person's follows. Nobody is assigned anything.

| Follow | Matches on |
|---|---|
| A capability area | The NAICS, PSC and keyword crosswalks BD authored against that taxonomy node |
| An agency, or an office inside one | The codes on the requirement |
| A company | The entity rollup, in any role on the requirement: incumbent, partner or competitor |
| A raw NAICS or PSC code | Prefix, so `5413` catches `541330` and `R4` catches `R425` |
| A keyword | The title |

Every feed row says which follow put it there, because a list nobody curated is only trusted if it
can name its reason. Three actions, all per person:

| Action | What it means |
|---|---|
| **Track** | Keep an eye on this. Clears a dismiss |
| **Dismiss** | Not mine. Leaves your feed, stays reachable, touches nobody else's |
| **Sent** | Carried into TechnoMile by hand. Never cleared by the other two |

`sent` is the measure of whether this tool earns its place, which is why nothing can erase it as a
side effect. `docs/DECISIONS.md` **D18**.

## The forecast

```bash
npm run forecast -- --dry-run              # project, writing nothing
npm run forecast                           # project and write
npm run forecast -- --horizon 24
npm run forecast:backtest -- --sweep 2021,2022,2023
```

One line of arithmetic, stated on the screen rather than hidden:

    projected solicitation date  =  period end date  −  lead time

A contract ending has to be re-competed or let go. A vehicle ending has to be replaced on-ramp by
on-ramp, which is usually a larger and earlier opportunity than any order under it, so it is a
separate basis. The lead time comes from one of three places and every row says which:

| Source | What it is |
|---|---|
| A measured notice lag | This office's own days from posting a notice to signing the award, from solicitation numbers found in both SAM.gov and FPDS |
| An observed office cadence | Inferred from how often it re-lets the same PSC and how far before the previous end date it awards the follow-on |
| The 365-day default | Decision D13's assumption, and labelled one |

Every projection carries its evidence including the evidence against it, low-confidence rows are
shown rather than dropped, and a quarter's value is labelled a floor with the count of unpriced rows
beside it. It never writes a `pursuit`: a forecast says a requirement is likely, and the feed's whole
claim is that everything in it is real.

**Its accuracy is on the screen.** `npm run forecast:backtest` recomputes the projection as it would
have stood on a past date, using only what was knowable then, and scores it against what happened
next. The as-of discipline is enforced inside the aggregate rather than outside the view, because a
contract extended by a later modification is the leak that would make the whole exercise
reassuring and meaningless. `docs/DECISIONS.md` **D19** and **D20**.

## Handing off to TechnoMile

By hand, on purpose. There is no integration, so the hand-off panel on a requirement carries all
four shapes of it: a field block that selects on click, a written summary paragraph, the SAM.gov
link, and a CSV export that takes a multi-select from the feed. Codes carry their labels, absent
values say `not recorded` rather than leaving a gap, and no absent value is ever a zero.
`docs/DECISIONS.md` **D21**.

## Market sizing

```bash
npm run campaign -- --create "Flight test" --nodes CAP-01,CAP-03 \
                    --offices 9700/FA8601 --actor <you>
npm run size -- --actor <you>
npm run campaign -- --gap
```

A campaign is a set of capability areas plus the offices that buy them. Sizing gives three figures
and a rate, all derived from the corpus and none aspirational:

| | |
|---|---|
| **TAM** | Obligations under the campaign's codes, any office, over the window |
| **SAM** | The same, restricted to the offices the campaign says it competes in |
| **SOM** | SAM times the capture rate Astrion has actually achieved in that slice |

**TAM is a floor and every screen says so.** This corpus is Astrion's history plus the watchlist
competitors, not every federal dollar under these codes, and the difference is not derivable from
what is here. The caveat is stored as evidence on every campaign and cannot be turned off, because
it is the most quotable wrong number the system could produce.

**The capture rate is measured and never travels without its sample size.** Spec 11.2, and the
reason is that a 12 percent rate over four awards and the same rate over four hundred are different
claims. A campaign that names no offices gets no SAM at all rather than a quiet fallback to TAM.

The **gap report** lists requirements no campaign claims, with the campaign whose codes they match,
so a gap is something to act on rather than merely count.

## The digest

```bash
npm run digest                                  # every digest worth sending
npm run digest -- --person <principal> --html
npm run digest -- --out dist/digests --base-url https://…
```

Renders and stops. Nothing sends yet, and that is the state to ship in rather than a gap: the hard
part of a digest is what it says, and a transport is a dozen lines against a shape somebody can
already read. `docs/BACKLOG.md` item 9 has the traps.

It is per person, it sends nothing when there is nothing, the subject line carries the content, and
it never moves the read mark — a digest is a copy of the feed, not a visit to it.

## Is any of this working yet

```bash
npm run readiness
```

Prints what the loaded corpus can and cannot support, and names the command that moves each number.
Every screen here is honest about its own weak spots individually; this is the assembly of those
admissions, because "should I believe this yet" is asked of the whole thing rather than of one
screen. A run full of `!` on a shallow corpus is the expected state, not a defect.

## Detecting signals

Two sources produce requirements, and both write `pursuit` rows.

```bash
npm run signals -- --dry-run    # recompetes from the corpus, writing nothing
npm run signals                 # detect and write

npm run profile                 # build the targeting profile, once per corpus load
npm run load:sam -- --probe     # one request: is the key good, is the host reachable
npm run load:sam -- --dry-run   # search SAM.gov, writing nothing
npm run load:sam                # fetch and write
```

Run `--probe` first on a new environment. A full run makes one request per profile code, so a
bad key or a blocked host otherwise costs seventeen requests to discover, against a daily quota;
the probe spends one and says which of the two it was. It distinguishes them deliberately —
`SAM_API_KEY` wrong and "your egress policy does not allow api.sam.gov" look identical from
inside the process and get fixed by different people.

Two things about the key, both of which cost an afternoon if you get them wrong. It comes from
**SAM.gov**, at `sam.gov/workspace/profile/account-details` under "Public API Key", and it asks for
your account password to reveal it — a key from `api.data.gov/signup` does **not** work here, because
despite both being GSA they are separate systems with separate authentication. And the daily
allowance is set by the **role on the SAM.gov account**, not by the key:

| Account | Requests per day |
|---|---|
| Non-federal, no role | 10 |
| Non-federal, with a role | 1,000 |
| Federal system account | 10,000 |

A run needs one request per profile code, so **the no-role tier cannot complete a run at any date
range** — 17 does not fit in 10, and narrowing the dates does not change the number of codes. If you
are on that tier, request a role on the account rather than tuning the query.

**Recompetes** come from the corpus. Contracts ending inside the window become signals,
each carrying the position Astrion holds on it: prime incumbent, subcontractor, or none.
Three different plays, and the feed filters on that rather than ranking across it.

**SAM.gov notices** are targeted rather than swept. `npm run profile` builds
`opportunity_profile` from the capability taxonomy crosswalks and from the codes the corpus
shows Astrion working under, and the search asks for those codes and nothing else. Each
notice records which profile rows pulled it in, so "why is this in my feed" has two answers: the
follow that matched it, and the profile row that fetched it in the first place.

The notice type decides how early the work is, which is why the search is not limited to
things closing soon:

| Notice type | Becomes |
|---|---|
| Sources sought, special notice, intent to bundle | `shaping_target` — early enough to shape |
| Presolicitation, solicitation, combined synopsis | `active_solicitation` — out now |
| Award notice, with `--include-awards` | `market_movement` — competitive intelligence |

`SAM_API_KEY` comes from SAM.gov's own Account Details page, not from api.data.gov. It is read
from the environment and never written to the database; a test asserts it never reaches an
archived payload.

The window is not a constant in the code. It lives in `signal_class_threshold`, which BD Ops
owns per spec section 13, seeded at 12 to 36 months from spec section 9. `rhythm` on the same
row says `monthly`, which is how often this should run; it is idempotent, so running it more
often costs nothing but time.

A generated requirement carries a `signal_key` and a re-run updates it in place. Per-person
follows and actions live in their own tables and are never touched by a detection run, and a
requirement somebody created by hand is never touched at all.

## Two ways in, and which one owns what

There are two APIs and one corpus behind this, and they overlap. Overlap is the thing to get
right rather than the thing to avoid, so here is who owns what and why nothing is fetched twice.

| Data | Who owns it | Why | What the others are for |
|---|---|---|---|
| Notices, ongoing | **GovCon API delta** — `npm run load:govcon` | `/opportunities/delta?since=` returns only what changed. Quota is hourly. | `load:sam` weekly, as a check that the stream has not gone stale |
| Notices, first fill | **GovCon API search** — `--backfill` | Takes a date range and the plan's full history window | — |
| Award **history** | **the corpus** — `npm run load:fpds` | Fifteen years of transactions, which is what a recompete rhythm is learned from | — |
| Award **recency** | **GovCon API** — `npm run load:contracts` | Refreshed daily, so last week's award is here without waiting for an extract | — |
| Requirements **before they publish** | **GovWin export** — `npm run load:govwin` | The only source that tracks a requirement with no solicitation yet. 769 of the first 2,629 rows | — |
| One company's full history | **GovCon API** — `load:contracts --uei` | `companies/{uei}/awards` is not window-gated. Pro tier. | — |
| Entity, UEI, CAGE | **GovCon API**, on demand | Nothing else here has it | — |
| Exclusions | **GovCon API**, on demand | A live fact about today; a stale answer is the dangerous one | — |

### Why the API cannot replace the corpus

This is the one thing to be clear about before wiring contract data, because the API looks like a
drop-in replacement for the extract and is not one. Its FPDS coverage is comprehensive from
**October 2024** onward and a sparse backfill before that.

Two things need real depth, and the arithmetic is what settles it rather than a judgement call:

**Recompete cadence.** `office_recompete_cadence` learns an office's rhythm from follow-on chains. A
chain needs a contract that *ended* plus a successor starting within `[end − 180d, end + 365d]`;
`MIN_CADENCE_CHAINS` is 3 and a usable interval is at least 365 days. You cannot observe three
separate lineages each turning over on a year-or-more interval inside a window that only opens in late
2024. So an API-only corpus learns approximately no cadence, and every projection falls back to the
365-day default lead time.

**The backtest.** `forecast:backtest` scores a projection made as of a past date against what actually
happened next. With no history before the as-of date there is nothing to project from, so the number
that tells you whether to believe the forecast cannot be computed at all.

`npm run readiness` now breaks the corpus down by source and by the history each one spans, so a
shallow API-sourced corpus cannot pass for history:

```
  History it spans                   17.5 years
    from govcon_contract             3 actions, 1.0 years
                                      Recency and breadth. Comprehensive from October 2024 only,
                                      so it cannot supply the depth a cadence needs however many
                                      actions it carries.
    from fpds                        48,645 actions, 17.5 years
                                      Deep enough for a five-year rhythm to appear three times in
                                      one office.
```

The exception is `--uei`, which uses `companies/{uei}/awards`. That endpoint is ungated by the plan
window and returns a company's full history — real depth, but per company rather than per office.
Enough to complete Astrion's own incumbency and a named competitor set; not enough to learn how a
contracting office behaves.

### GovWin: the only source that sees a requirement before it exists

```bash
npm run load:govwin -- --file <export.xlsx> --headers   # columns only, check the mapping
npm run load:govwin -- --file <export.xlsx> --dry-run
npm run load:govwin -- --file <export.xlsx>             # weekly
```

Every other source here describes something that already happened: FPDS an award, SAM.gov a published
notice. GovWin describes a requirement an analyst is tracking, often years early. The first export held
2,629 rows, of which **769 were Pre-RFP or Forecast Pre-RFP** — requirements with no solicitation to
find yet, which is the earliest warning this system has ever had access to.

It gets its own table rather than becoming notices, because its lifecycle, its estimate provenance and
its disagreements with SAM.gov are the reason to have it. `govwin_pursuit_link` joins it to requirements
by solicitation number as a view rather than a merge: for one solicitation GovWin's tracked record said
*Awarded* while its own SAM-notice row said *Source Selection*, and that disagreement is often the
earliest sign something has moved.

**An estimate is a month, and stays a month.** In the export the estimate flag and the date precision
correspond exactly — every `Actual` date is a day, every Deltek or government estimate is a month —
because nobody knows the day an unpublished solicitation will drop. A month-precision date is stored on
the first of that month with its precision beside it, and comparisons are made by quarter.

**The value column is thousands.** `172400000` is $172.4bn, the OASIS+ ceiling. The loader multiplies on
the way in; read as dollars every figure would be a thousand times too small and nothing would fail.

**The prose is deliberately not stored.** `Summary` and `Latest News` are Deltek's licensed analysis, and
this repository publishes a self-contained snapshot that embeds every row it renders. Holding them would
put licensed content one careless publish away from a public URL, so the row links back to GovWin
instead. The export itself must never be committed.

#### Where it shows up

Loading it was not enough — it had to be reachable. Three places:

**`/govwin`, "Early requirements" in the rail.** Opens on the 769 not-yet-advertised rows rather than on
all 2,629, because a screen that opens on 944 expired records buries what matters. Filter by stage or
NAICS prefix, sort by soonest expected, value or how many companies are watching it on GovWin. Each row
links to a detail screen, and out to GovWin for the analysis this system does not store.

**The feed.** A tile counts the early requirements in your patch and a block previews the soonest, kept
separate from the requirement list rather than interleaved: a GovWin row has no notice, no response date
and an expected date that is a month, so mixing it in would present a tracked guess as a deadline.

**Follows.** `follow_govwin` mirrors the pursuit matching, so a follow means the same thing whichever
kind of record it reaches — a NAICS follow on `5413` matches a GovWin row under `541330` exactly as it
matches a notice.

Two follow types cannot match this source, and both are counted rather than hidden. **PSC** cannot,
because the export has no product or service code at all. **Company** cannot yet, because GovWin lists
incumbents as one unparsed string and splitting a name list on commas would attribute work to companies
that are not on it. `npm run readiness` and the screen itself both say so, so an empty patch does not
read as an empty market.

#### The forecast finally has an outside check

`forecast_item` projects when a requirement will solicit, from a contract end date minus a lead time it
learns per office and assumes at 365 days when it cannot. GovWin publishes an independent estimate of the
same event. `govwin_forecast_check` puts them side by side, joined on the predecessor contract — the only
identifier the two can share, since a projection describes something unpublished and so has no
solicitation number.

`govwin_forecast_gap` counts what each sees that the other does not. Both directions matter: a GovWin
Forecast Pre-RFP with no projection is a requirement this system is blind to, and a projection GovWin is
not tracking is worth a second look.

On the development corpus this returns **zero comparisons**, because the join needs the predecessor
contract in the corpus and that corpus holds six projections. That is the honest state of a thin corpus
rather than a broken view; the tests construct a match to prove the join works.

### Contract actions

```bash
npm run load:contracts -- --dry-run --from 2024-11-01 --sample
npm run load:contracts                       # since the stored cursor
npm run load:contracts -- --uei ZQF7MRQR4KL5  # one company's full history (Pro)
```

Transactions arriving here and from the bulk extract converge on one `contract_action` row, keyed on
spec 7.2's composite, so running both never double-counts an obligation. Both go through
`src/loaders/contract.ts`, which is also what guarantees an API-sourced transaction gets the same
entity resolution, classifications and code labels a CSV-sourced one does rather than quietly less.

**The one refusal worth knowing about.** `/contracts/{piid}` returns the latest transaction *plus* a
`transaction_rollup` summing every action on that PIID. Written into `contract_action` that would put a
whole contract's obligation on a single row: `cie_award_shape_asof` would compute the wrong shape,
campaign sizing would double-count, and nothing would error. The loader refuses any record carrying a
rollup marker and reports the count. There is a test asserting three transactions totalling $7.7m are
read as $7.7m and not as the rollup's $31m.

GovCon API also supplies `contract_award_unique_key`, which is globally unique and would resolve
exactly the PIID ambiguity that decision D13 works around. It is **stored and not acted on**:
`contract_award_key_agreement` measures whether it agrees with the current grouping. Changing how
contracts are grouped would silently move the forecast, the lineages and every campaign figure, so
that is a decision for evidence rather than for a field name.

**Why the delta endpoint is the primary.** api.sam.gov has no way to answer "what changed". A
run there re-searches every code on the profile over a posted-date window and re-reads notices it
already has — seventeen requests on this profile, against a quota measured per day. GovCon API
answers the same question in one request out of an allowance twenty-four times larger. That does
not save much money. What it buys is the thing that matters for an early-warning tool: **the sync
can run hourly instead of daily.** A sources sought posted at 9am is in somebody's feed by 10.

**Why running both does not duplicate anything.** Both loaders write through
`src/loaders/notice.ts`, and `signal_key` is `sam:<notice_id>` in both, because the notice is a
SAM.gov notice whichever door it came through. A notice that arrives from both converges on one
`pursuit` row and one feed item; whichever loader saw it second updates rather than inserts.
Provenance still separates them, so which API delivered which version stays answerable. There is
a test named `two APIs, one pursuit` and it is the assertion that fails first if somebody
reintroduces a second write path.

```bash
npm run load:govcon -- --probe     # one request: key, plan, rate limit, search window
npm run load:govcon                # changes since the stored cursor. Run this hourly.
npm run load:govcon -- --cursor     # where the last sync got to. No request.
npm run load:govcon -- --backfill --from 2026-01-01
```

**The cursor is why the hourly run is cheap and not wasteful.** `sync_cursor` holds the
high-water mark, in the database rather than in the container, because the container is ephemeral
and a lost cursor means the next run silently re-downloads a window it already had — data correct,
bill not. The cursor moves to the instant the run *started*, and only when the run completed: a
partial run that advanced its cursor would lose whatever it never reached, permanently and without
a trace.

**The gap you have to be told about.** The delta window is capped at 60 days regardless of plan,
and a `since` older than that is clamped *silently* — the response succeeds, the records are
correct, and the interval nobody asked for was never fetched by anybody. The loader detects the
clamp, records it on the cursor, and prints `! This run had a gap` naming the interval that was
missed. Fill it with `--backfill`.

**Screening, and why it is not on a schedule.**

```bash
npm run screen -- --find "Example"     # candidates and their UEIs
npm run screen -- ZQF7MRQR4KL5         # exclusions in force, plus the SAM.gov registration
```

Two requests at most, and none when a fresh answer is cached — a day for exclusions, a week for
registrations. Nothing here sweeps, because screening every company in the corpus would spend the
hourly allowance answering questions nobody asked, and the allowance is shared with the notice
sync. A lookup happens when a person is about to hand a requirement to TechnoMile with an
incumbent named on it, which is the only moment the answer matters.

It makes no determination, and says so every time. "No exclusion matched" is not a clearance —
the list matches on the name, UEI or CAGE as given, and a company excluded under a different legal
name will not appear. A hit is not a disqualification either, because names collide. A
`termination_date` of null is an *indefinite* exclusion and must never be read as an absent one.

## Scoring

```bash
npm run score -- --dry-run
npm run score
```

Every open pursuit becomes an `assessment` with one `factor_result` per factor, one
`gate_result` per gate, and an `evidence_ref` per claim. `/pursuits/<id>` opens the trace.

Four things it does deliberately:

**Weights are rows.** `score_model_factor` holds them and every assessment pins the model
version it was computed under, so changing a weight makes a new version and never moves a
past score.

**A failed gate shows no score at all.** Not a low one. The factors are not evaluated, so
there is nothing to show.

**Unknown, not applicable, and zero are three different things.** A code that matches nothing
scores zero. No code at all is unknown, keeps its weight in the denominator, and costs
coverage. A question that does not arise is not applicable and leaves the denominator
entirely. The strategic fit divides by the **applicable** weight, and coverage below 60
percent gives no rank at all.

**Three gates report `not_evaluated` rather than `pass`.** There is no clearance data, no
conflict register, and a notice rarely names its ordering vehicle. A gate nobody checked is
not a gate that was cleared.

## Loading a corpus

**No data is in this repository, and none may be.** Gate A came back no on 14 August 2026:
DACIS-derived data may not be committed. The authored seed files go in `data/seed/`, which
`.gitignore` excludes, and reach the loaders through `CIE_SEED_DIR`. The test suite uses the
synthetic set in `tests/seed/` instead. CI checks on every push that nothing real has crept
in. See `CONTRIBUTING.md`.

One command handles a whole folder of exports:

```bash
npm run load -- --dry-run --dir /path/to/exports   # classify everything, write nothing
npm run load -- --dir /path/to/exports             # load it
```

It reads each file's header row, works out which of five shapes it is, and loads them in
dependency order. Always `--dry-run` a new batch first: it prints the classification and names
anything it does not recognise. Every loader is idempotent.

## The documents

| | |
|---|---|
| `CIE_Build_Spec_v1.0.md` | The specification. It wins. |
| `CIE_Phase1_Status.md` | What is built, what the corpus actually said, what is not done. **Not in this repository** — it records findings about real contracts, so it lives with the specification. |
| `docs/DECISIONS.md` | Twenty-four decisions where this departs from the spec, each with the measurement that forced it. |
| `docs/BACKLOG.md` | Remaining phases, in dependency order, sized, with the traps in each. |
| `docs/DEPLOY.md` | Running the interface locally, and putting it on Azure Container Apps. |
| `docs/GITHUB_SETUP.md` | One-time checklist for putting this on GitHub. |
| `CONTRIBUTING.md` | Local setup and the things that will trip you up. |

Migration headers explain the defect or decision behind each one. **0014**, **0015** and
**0017** are worth reading before touching the loaders, **0019** before touching the signals
(it explains why a PIID does not identify a contract), **0022** before touching the feed, and
**0023** before touching the forecast: it explains why the as-of functions are functions.

## Three things to know before changing anything

**Migrations are forward-only and checksummed.** The runner refuses to run if an applied file
changed. Add a migration; never edit one.

**A blank value is null, not zero, and a negative value is a deobligation.** Sixty subcontract
rows and five DACIS contract rows have no value. `value_is_shared` on a DACIS contract means
the figure covers several awardees and must not be summed.

**Numbers in comments and docs came from measurements.** Where one is quoted — 18.6 percent of
obligated dollars, 26 of 434 rows, 10 of 74 programs at the export cap — it is repeatable
against the corpus. If you change behaviour that a number describes, re-measure it.
