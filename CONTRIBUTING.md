# Working on the CIE

Everything here runs on a laptop. Nothing depends on the environment this was originally
built in.

## Getting a working database in five minutes

```bash
git clone <repo-url> cie && cd cie
cp .env.example .env
docker compose up -d db          # PostgreSQL 16
npm install
npm run migrate                  # 20 forward-only SQL migrations
npm run seed                     # the authored seed files, if you have them locally
npm test                         # 218 tests, on the synthetic seeds in tests/seed/
npm run accept                   # the twelve acceptance tests from spec section 18
npm run web                      # the interface, http://localhost:3000
```

`docker compose up` on its own does all of that except the tests: database, migrations,
seeds, and the interface on port 3000.

While working on a screen, `npm run web:dev` restarts on save.

If you would rather not use Docker, any PostgreSQL 16 you can reach works. Set
`DATABASE_URL` in `.env` and skip the `docker compose` line. The test harness derives
`cie_test` from `DATABASE_URL` by swapping the database name and drops and recreates it on
every run, so the role needs `CREATEDB`.

`npm run accept` reporting **blocked** items is expected. Blocked means a test names what
it is waiting for. A **FAIL** is a real problem and CI treats it as one.

## Loading a corpus

The exports are not in the repository. Put a folder of DACIS and FPDS CSVs somewhere and:

```bash
npm run load -- --dry-run --dir /path/to/exports   # classify everything, write nothing
npm run load -- --dir /path/to/exports             # load it
```

`npm run load` reads each file's header row and works out which of five shapes it is, then
loads them in dependency order: customers, programs, FPDS transactions, subcontract edges,
DACIS contracts. Always run `--dry-run` first on a new export batch. It prints the
classification and names any file it does not recognise, which is how a renamed or
half-exported file gets caught before it writes anything.

Every loader is idempotent, so re-running on the same folder is safe and reports zero new.

One thing the header row cannot tell the loader: Astrion's role on a DACIS contract export.
It is read from the filename, and `role_source` on the row records that it was inferred. If
your filenames do not follow Deltek's convention, pass it:

```bash
npm run load -- --role loss /path/to/whatever_they_called_it.csv
```

## Working on the interface

`src/web/` is a `node:http` server that renders strings. No framework, no client bundle, no
build step, and no dependency that is not already in the lockfile.

```
src/web/server.ts       routing, the three write endpoints, static assets, graceful shutdown
src/web/queries.ts      every statement the interface runs, in one place
src/web/actions.ts      every write, each one with its audit row in the same transaction
src/web/handoff.ts      the field block, the written summary, the CSV. No database
src/web/pages/          one file per screen
src/web/components.ts   tile, table, pager, chip, feed row, empty state
src/web/html.ts         escaping. Everything interpolated is escaped unless it came from `html`
src/web/public/         app.css, the Archivo weights, the logo
```

`npm run demo -- --out dist/demo.html` renders the whole interface to one self-contained HTML
file for review, using the same page functions the server calls. It embeds every row it
renders, so build it against a synthetic corpus unless you mean to hand someone the real one.
`docs/DEPLOY.md` has the detail.

Four rules, each load bearing:

**Writing happens on three shapes of path and nowhere else, and the router enforces it.**

```
POST /requirements/<id>/<action>   track, dismiss, clear, sent, unsent, note
POST /follows/<action>             follow, unfollow
POST /feed/mark-read
```

Anything else answers 404 to a POST, and 405 to any other method. Every write refuses without a
signed-in principal, and every one writes its change and its audit row in the same transaction, so
a change without its audit row is not a thing that can happen. Spec section 20. CI asserts both
halves: that POST on a non-action path is a 404, and that a real action with no authentication
configured is a 403 rather than a write attributed to nobody.

If you add a write, add it inside `performPursuitAction` or `performFollowAction` and let the
existing transaction helper record it. Do not open a fourth endpoint shape: the narrowness is the
property, not the tidiness.

**A GET never writes.** The read mark is the case that tempts you. Advancing it on page load looks
right and loses the item somebody was halfway through reading when they hit refresh, so it is a
button. `touchUser` is the one exception and it records presence rather than a change.

**Every screen must render against an empty database.** That is the state of a fresh clone,
because no data is in this repository and none may be. A screen that assumes rows exist will
fail for the next person who clones it, so each one names the command that would fill it.
CI checks every route against a seeded-but-unloaded database.

**Two acceptance tests read `src/web/public/app.css`.** Test 11 fails on any `font-size`
below 12px or expressed in a relative unit, because a relative unit makes the smallest
rendered size unknowable from the file. Test 12 fails if Archivo is not `@font-face`
declared, not first in the body stack, or not on disk. Both run on every push. The four
Archivo weights are committed under `src/web/public/fonts/` (SIL Open Font License) so the
face renders identically in a container with no outbound network.

Styling follows the Astrion 2026 Brand Evolution: dark first, Astrion Black behind
Deep Space cards, Alabaster type, Astrion Sky for anything interactive, and the three-stop
gradient only as the thin rule at the top edge.

## Working on the SAM.gov loader

`loadSamOpportunities` takes its HTTP call as a parameter, so the tests hand it recorded
pages and never touch the network or need a key. That is also how to develop against it:
point `SAM_API_BASE` at a local stub and `SAM_API_KEY` at anything.

Two properties are load bearing and both are tested.

**The search is targeted.** It asks only for codes on `opportunity_profile`, and it refuses
to run at all when the profile is empty rather than falling back to searching for
everything. A test asserts that every code the loader asks for is on the profile.

**The key never lands in the database.** `source_version` archives the whole notice, so a
test asserts the key does not appear in any archived payload.

If you add a notice type, add it to `NOTICE_TYPES` with the signal class it maps to.
`classify` returns null for anything it does not know and the loader counts those and skips
them, so a new SAM.gov type shows up as a number to look at rather than being filed under
whatever is nearest.

Letting this run has a second effect worth knowing: `office_notice_lag` measures the days between a
notice being posted and the award being signed, from solicitation numbers that appear in both
SAM.gov and FPDS, and that measurement is what moves a forecast from an assumption to a figure. Each
office that crosses three matched notices improves without a line of code changing.

## Working on the forecast

`src/forecast/` is three files plus two entry points: `cadence.ts` learns what it can from the
corpus, `forecast.ts` does the projection and the writing, `backtest.ts` scores it against history.

```bash
npm run forecast -- --dry-run
npm run forecast
npm run forecast:backtest -- --sweep 2021,2022,2023
```

Four things are load bearing and all four are tested.

**The as-of functions are functions and not views, and that is the whole reason the backtest is
worth running.** `cie_award_shape_asof(date)` aggregates a contract's end date *inside* a
signed-date filter. Filtering `contract_group` afterwards cannot express that: the end date is an
aggregate over actions, so a modification signed in 2025 would supply the end date to a projection
recomputed for 2023. `cie_followon_chain_asof(date)` closes the same leak on the cadence side. A
test asserts both directly, because without them the backtest reports a hit rate it cannot repeat.

**A forecast is wholly derived and stale rows are pruned.** A `pursuit` is a real thing and
survives a re-detection. A projection whose contract has been extended past the horizon is deleted,
or the table slowly fills with dates that were true once. A test extends a contract and asserts the
projection disappears.

**It never writes a `pursuit`.** A forecast says a requirement is likely; the feed says one exists.
A test counts `pursuit` rows either side of a run.

**Confidence is derived from the evidence, not asserted.** `bandFor` reads the facts, and every fact
lands in `forecast_evidence` with `supports` set, contrary evidence included. If you add a fact, add
it to the `facts` array and let the band fall out; do not special-case the band.

If a lead time looks wrong, the answer is almost always in `lead_source`. `default` means neither a
measured notice lag nor an observed rhythm cleared its sample-size bar, which is the honest state on
a shallow corpus and is what the screen says. `docs/BACKLOG.md` item 8 is what makes it better.

## Working on follows and the feed

`follow_pursuit` is a seven-arm union view, one arm per follow type, and it carries the field that
matched so every feed row can say why it is there. `follow_forecast` is its counterpart against
projections.

Two properties, both tested:

**A capability follow matches on what the work is, not on who buys it.** A taxonomy node crosswalks
to agencies as well as codes, and matching on the agency crosswalk would mean following one
capability quietly subscribed somebody to every notice that agency posts. A test asserts a
requirement in the node's agency, under a code the node does not crosswalk to, does not match.

**One person's actions never reach another person's feed.** `pursuit_action` is keyed per person, and
a test asserts a dismiss by one person leaves the other's feed alone. If you add a per-person
concept, key it the same way; a shared verdict makes somebody the owner, which is the model
`docs/DECISIONS.md` D17 replaced.

## Working on the scoring engine

`src/scoring/` is four files: `model.ts` loads the versioned model and the shapes a rule
returns, `gates.ts` and `factors.ts` hold one function per rule, and `engine.ts` does the
arithmetic and the writing.

Adding a factor means a row in `score_model_factor` **and** a case in `evaluateFactors`. A
factor on the model with no rule behind it comes back `unknown` rather than zero, so
coverage falls and somebody notices, which is the failure mode you want.

Three rules are load bearing and all three are tested:

**Divide by applicable weight, not known weight.** `not_applicable` leaves the denominator;
`unknown` stays in it. The test asserts the right answer *and* asserts it differs from the
wrong one, because both are plausible numbers and only one is right. This was defect 2 in
the Codex baseline.

**A score exists only in the `scored` state.** The database enforces it with a check
constraint, and a test tries to violate it.

**Nothing invents an answer.** If a rule cannot evaluate something it returns `unknown` or
`not_evaluated` with a reason naming what is missing. `docs/DECISIONS.md` D16 lists what the
engine refuses to guess and why.

## Before you open a pull request

```bash
npm run typecheck && npm test
```

CI runs those plus the migrations twice, the seed loaders twice, the scheduled jobs against an
empty corpus, every route through a running server, the write endpoints with no authentication
configured, the acceptance suite, and a Docker build. If it passes locally it will pass there, with
one exception: CI runs `npm ci`, so a dependency you added without committing the lockfile fails
there and not here.

If you add a screen, add its route to the route list in `.github/workflows/ci.yml`. Every screen
has to render against a seeded-but-unloaded database, because that is the state of a fresh clone,
and the check is the only thing that keeps it true.

## Things that will trip you up

**Migrations are forward-only and checksummed.** The runner records a hash of every applied
file and refuses to run if one changes. Editing a migration that has been applied anywhere
is not a thing you can do; add another one. This is deliberate and CI enforces it by
applying migrations twice.

**There are no mocks.** Tests run against a real PostgreSQL because the schema *is* the
design — 23 SQL files, no ORM. Several of the defects found so far were in SQL that a
mocked test would have declared healthy. `tests/fixtures/README.md` explains why fixtures
are generated at run time rather than committed.

**Fixtures are synthetic but structurally faithful.** They used to carry real names, on the
argument that a fixture with invented names tests the CSV parser rather than the resolver.
Gate A settled that, and the argument survived the change: `tests/seed/` reproduces every
awkward shape the real map has — shared UEIs, punctuation variants, a near neighbour that must
stay separate — with invented companies. If you need a shape that is not there, add the shape.
Never a real company.

**A negative value is a deobligation, not an error.** `subcontract_edge.value_usd` and
`contract_action.action_obligation` carry no check constraint on purpose. Spec 7.2.

**A blank value is null, not zero.** Sixty subcontract rows and five DACIS contract rows
have no value. Zero would be summed as a free contract.

**Read `participant_list_truncated` before counting program participants.** The DACIS
programs export caps its participant column at 500 and ten of the seventy-four programs are
at the cap, so their counts are floors.

**Do not sum `value_usd` across contracts where `value_is_shared` is true.** Ten contracts
are marked shared, meaning the figure covers several awardees.

## Where the reasoning lives

- `CIE_Build_Spec_v1.0.md` — the controlling document. It wins.
- `CIE_Phase1_Status.md` — current state, what is verified, what is not built. Not in this
  repository: it records findings about real contracts, so it sits with the specification.
- `docs/DECISIONS.md` — every place the build departs from the spec, and why.
- `docs/BACKLOG.md` — the remaining phases, sized, in dependency order.
- Migration headers — each one explains the defect or decision that produced it. Migrations
  0014 and 0015 are worth reading before touching the loaders, 0019 before the signals, 0022
  before the feed, and 0023 before the forecast.

Commit messages carry reasoning going forward. The history starts at one commit because the
earlier ones contained data Gate A forbids — see `docs/GITHUB_SETUP.md`.

## Data, and why none of it is here

**Gate A came back no on 14 August 2026: DACIS-derived data may not live in this
repository.** That is settled, and the repository is built around it.

What that means in practice:

- **The three authored seed files are not committed.** `.gitignore` excludes
  `data/seed/*`. Put them there locally and the loaders find them; `CIE_SEED_DIR` points at
  that directory and is the only thing that needs to change to read them from anywhere else.
- **The image does not bake them in either.** `Dockerfile` creates `/app/data/seed` as an
  empty mount point. Baking the files in would copy them into every image layer and every
  registry the image reaches.
- **The test suite uses `tests/seed/`**, a synthetic set that reproduces every structural
  property the tests depend on — the shared UEIs, the punctuation variants, the near
  neighbour that must stay separate — with invented companies. `tests/seed/README.md` lists
  the properties and why each one is there. Identifiers there use a `ZZ` prefix for UEIs and
  `Z` for CAGE codes so one cannot be mistaken for real.
- **No real company name, UEI, CAGE code, PIID or contract number appears anywhere in this
  repository.** CI checks it on every push, in the step named *No DACIS-derived data
  committed*.
- **Measured findings about real contracts live in the Phase 1 status document**, alongside
  the specification, not here. Where a decision needed a number to make sense, `docs/DECISIONS.md`
  keeps the aggregate and points at the status document for the specifics.

Astrion's own name is not DACIS data and appears freely.

### If you add a test that needs a new data shape

Add the shape to `tests/seed/`, not a real company. Two rules, both in
`tests/seed/README.md`: nothing traceable to a real company, and document the property you
added so the next person tidying up does not delete it.
