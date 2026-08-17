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
| Tests | 368, against a real PostgreSQL 16 |
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
npm run load:sam -- --dry-run   # search SAM.gov, writing nothing
npm run load:sam                # fetch and write
```

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

`SAM_API_KEY` comes from api.data.gov, registered for the Opportunities API. It is read from
the environment and never written to the database; a test asserts it never reaches an
archived payload.

The window is not a constant in the code. It lives in `signal_class_threshold`, which BD Ops
owns per spec section 13, seeded at 12 to 36 months from spec section 9. `rhythm` on the same
row says `monthly`, which is how often this should run; it is idempotent, so running it more
often costs nothing but time.

A generated requirement carries a `signal_key` and a re-run updates it in place. Per-person
follows and actions live in their own tables and are never touched by a detection run, and a
requirement somebody created by hand is never touched at all.

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
