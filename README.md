# Contract Intelligence + Integration Engine

Phase 1 implementation of `CIE_Build_Spec_v1.0.md`. The specification is the controlling
document; where this build departs from it, `docs/DECISIONS.md` says so and why.

TypeScript on Node 22, PostgreSQL 16, forward-only SQL migrations, no ORM, no mocks in the
tests. One container, deployable to Azure Container Apps by changing two environment
variables.

## State

The data foundation is built and verified against the real corpus. The scoring engine and the
interface are not built.

| | |
|---|---|
| Schema | 40 tables, 17 views, 18 migrations |
| Loaders | FPDS transactions, FPDS subcontract edges, DACIS customers, programs, contracts |
| Loaded | 22,624 contract actions, 4,042 subcontract edges, 854 customers, 74 programs, 213 DACIS contracts |
| Entity resolution | 100 percent of the FPDS corpus resolved; review queue empty |
| Tests | 164, against a real PostgreSQL 16 |
| Acceptance tests | 3 of 12 pass, 0 fail, 9 blocked, each naming what it waits for |

`npm run accept` prints the current state of all twelve. **Blocked** means a test names its
dependency; a **FAIL** is a real problem and CI treats it as one.

## Start here

```bash
cp .env.example .env
docker compose up -d db
npm install && npm run migrate && npm run seed
npm test
```

Full setup, including without Docker, is in **`CONTRIBUTING.md`**.

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
| `docs/DECISIONS.md` | Eleven decisions where this departs from the spec, each with the measurement that forced it. |
| `docs/BACKLOG.md` | Remaining phases, in dependency order, sized, with the traps in each. |
| `docs/GITHUB_SETUP.md` | One-time checklist for putting this on GitHub. |
| `CONTRIBUTING.md` | Local setup and the things that will trip you up. |

Migration headers explain the defect or decision behind each one. **0014**, **0015** and
**0017** are worth reading before touching the loaders.

## Three things to know before changing anything

**Migrations are forward-only and checksummed.** The runner refuses to run if an applied file
changed. Add a migration; never edit one.

**A blank value is null, not zero, and a negative value is a deobligation.** Sixty subcontract
rows and five DACIS contract rows have no value. `value_is_shared` on a DACIS contract means
the figure covers several awardees and must not be summed.

**Numbers in comments and docs came from measurements.** Where one is quoted — 18.6 percent of
obligated dollars, 26 of 434 rows, 10 of 74 programs at the export cap — it is repeatable
against the corpus. If you change behaviour that a number describes, re-measure it.
