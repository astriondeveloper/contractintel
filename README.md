# Contract Intelligence + Integration Engine

Phase 1 implementation of `CIE_Build_Spec_v1.0.md`. The specification is the controlling
document; where this build departs from it, `docs/DECISIONS.md` says so and why.

TypeScript on Node 22, PostgreSQL 16, forward-only SQL migrations, no ORM, no mocks in the
tests. One container, deployable to Azure Container Apps by changing two environment
variables.

## State

The data foundation is built and verified against the real corpus, recompete signals are
detected from it, and there is a read-only interface over both. The scoring engine is not
built, so signals are ordered by date and value rather than ranked.

| | |
|---|---|
| Schema | 42 tables, 21 views, 20 migrations |
| Loaders | FPDS transactions, FPDS subcontract edges, DACIS customers, programs, contracts |
| Loaded | 22,624 contract actions, 4,042 subcontract edges, 854 customers, 74 programs, 213 DACIS contracts |
| Entity resolution | 100 percent of the FPDS corpus resolved; review queue empty |
| Signals | Recompetes from the corpus, and targeted SAM.gov notices from sources sought through solicitation |
| Interface | Thirteen read-only screens, server rendered, no client bundle |
| Tests | 200, against a real PostgreSQL 16 |
| Acceptance tests | 6 of 12 pass, 0 fail, 6 blocked, each naming what it waits for |

`npm run accept` prints the current state of all twelve. **Blocked** means a test names its
dependency; a **FAIL** is a real problem and CI treats it as one.

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

Read only, and structurally so: the router answers `GET` and `HEAD` and returns 405 to
anything else. Confirming a seeded row or merging two entities writes to the corpus and needs
the audit trail spec section 20 describes, so those belong to a later phase rather than to a
button that quietly bypasses it.

| Screen | What it answers |
|---|---|
| Overview | What is loaded, how it resolved, when each source last landed |
| Upcoming | The pipeline: solicitations open now, recompetes coming, and work early enough to shape |
| Entities | One row per resolved company; the detail screen lists every spelling it answers to |
| Contract actions | The FPDS corpus, with the vendor string as filed beside the entity it resolved to |
| Subcontracts | Prime-to-sub edges, and which side Astrion is on |
| Customers, Programs, DACIS contracts | The DACIS reference exports |
| Taxonomy | The capability tree and its crosswalks |
| Watchlist | Observed teaming direction against what the seed file stated |
| Review queue | Everything the resolver refused to decide alone |
| Data quality | The seven views that keep known source defects visible |
| Acceptance | The twelve tests from spec section 18, run live |

`/api/overview`, `/api/upcoming`, `/api/acceptance` and `/api/quality` return the same numbers as JSON, and
`/healthz` answers a container probe without touching the corpus.

## Detecting signals

Two sources feed the pipeline, and both write `pursuit` rows.

```bash
npm run signals -- --dry-run    # recompetes from the corpus, writing nothing
npm run signals                 # detect and write

npm run profile                 # build the targeting profile, once per corpus load
npm run load:sam -- --dry-run   # search SAM.gov, writing nothing
npm run load:sam                # fetch and write
```

**Recompetes** come from the corpus. Contracts ending inside the window become signals,
each carrying the position Astrion holds on it: prime incumbent, subcontractor, or none.
Three different plays, and `/upcoming` groups by that rather than ranking across it.

**SAM.gov notices** are targeted rather than swept. `npm run profile` builds
`opportunity_profile` from the capability taxonomy crosswalks and from the codes the corpus
shows Astrion working under, and the search asks for those codes and nothing else. Each
notice records which profile rows pulled it in, so "why is this in my pipeline" has an
answer.

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

A generated pursuit carries a `signal_key` and a re-run updates it in place. `state`, `owner`
and `campaign_id` belong to whoever is working the pursuit and are never overwritten, and a
pursuit somebody created by hand is never touched at all.

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
| `docs/DECISIONS.md` | Fifteen decisions where this departs from the spec, each with the measurement that forced it. |
| `docs/BACKLOG.md` | Remaining phases, in dependency order, sized, with the traps in each. |
| `docs/DEPLOY.md` | Running the interface locally, and putting it on Azure Container Apps. |
| `docs/GITHUB_SETUP.md` | One-time checklist for putting this on GitHub. |
| `CONTRIBUTING.md` | Local setup and the things that will trip you up. |

Migration headers explain the defect or decision behind each one. **0014**, **0015** and
**0017** are worth reading before touching the loaders, and **0019** before touching the
signals: it explains why a PIID does not identify a contract.

## Three things to know before changing anything

**Migrations are forward-only and checksummed.** The runner refuses to run if an applied file
changed. Add a migration; never edit one.

**A blank value is null, not zero, and a negative value is a deobligation.** Sixty subcontract
rows and five DACIS contract rows have no value. `value_is_shared` on a DACIS contract means
the figure covers several awardees and must not be summed.

**Numbers in comments and docs came from measurements.** Where one is quoted — 18.6 percent of
obligated dollars, 26 of 434 rows, 10 of 74 programs at the export cap — it is repeatable
against the corpus. If you change behaviour that a number describes, re-measure it.
