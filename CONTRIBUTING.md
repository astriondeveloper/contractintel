# Working on the CIE

Everything here runs on a laptop. Nothing depends on the environment this was originally
built in.

## Getting a working database in five minutes

```bash
git clone <repo-url> cie && cd cie
cp .env.example .env
docker compose up -d db          # PostgreSQL 16
npm install
npm run migrate                  # 18 forward-only SQL migrations
npm run seed                     # the authored seed files, if you have them locally
npm test                         # 164 tests, on the synthetic seeds in tests/seed/
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
src/web/server.ts       routing, static assets, graceful shutdown
src/web/queries.ts      every statement the interface runs, in one place
src/web/pages/          one file per screen
src/web/components.ts   tile, table, pager, chip, empty state
src/web/html.ts         escaping. Everything interpolated is escaped unless it came from `html`
src/web/public/         app.css, the Archivo weights, the logo
```

Three rules, each load bearing:

**It is read only, and the router enforces it.** Anything other than `GET` or `HEAD` gets a
405. Working the review queue or confirming a seeded row writes to the corpus and needs the
audit trail spec section 20 describes; a link on a list screen would bypass it.

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

## Before you open a pull request

```bash
npm run typecheck && npm test
```

CI runs those plus the migrations twice, the seed loaders twice, the acceptance suite, and a
Docker build. If it passes locally it will pass there, with one exception: CI runs
`npm ci`, so a dependency you added without committing the lockfile fails there and not
here.

## Things that will trip you up

**Migrations are forward-only and checksummed.** The runner records a hash of every applied
file and refuses to run if one changes. Editing a migration that has been applied anywhere
is not a thing you can do; add another one. This is deliberate and CI enforces it by
applying migrations twice.

**There are no mocks.** Tests run against a real PostgreSQL because the schema *is* the
design — 18 SQL files, no ORM. Several of the defects found so far were in SQL that a
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
  0014 and 0015 are worth reading before touching the loaders.

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
