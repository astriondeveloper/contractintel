# Putting this on GitHub

A one-time checklist. The repository has a single initial commit of a scrubbed tree, for the
reason in the next section, so this is a push and not an import.

## Gate A: answered, and already acted on

**Gate A came back no on 14 August 2026.** DACIS-derived data may not live in this
repository. Everything that followed from that has been done, so there is nothing to decide
before pushing:

| | |
|---|---|
| The three authored seed files | Untracked, and `.gitignore` excludes `data/seed/*` |
| `Dockerfile` | No longer copies them; `/app/data/seed` is an empty mount point |
| `docker-compose.yml` | Mounts `./data/seed` read-only instead |
| Test fixtures | Rebuilt on `tests/seed/`, a synthetic set with invented companies |
| Real identifiers and company names in code, migrations and docs | Removed |
| The findings document | Untracked; it belongs with the specification |
| Git history | **Rewritten.** See below. |
| A guard against regression | CI step *No DACIS-derived data committed*, on every push |

### The history was rewritten, deliberately

The four earlier commits each contained the seed CSVs and real identifiers in test
fixtures. Untracking a file does not remove it from history, and a private repository is
still a copy. Since nothing had ever been pushed, the clean fix was available and was
taken: the history is now a single initial commit of the scrubbed tree.

The reasoning those four messages carried is not lost — it is in `docs/DECISIONS.md`, in the
migration headers, and in the Phase 1 status document. If you ever want the original
messages for internal reference, the earlier `cie_phase1.zip` deliveries still have them,
and they are on OneDrive rather than in a repository.

**Do not restore an older zip's `.git` directory into this repository.** That would put the
seed files and the real identifiers straight back into history.

## Create the repository

> **Superseded on 14 August 2026.** The repository is `astriondeveloper/contractintel` and it
> is **public**, decided on the ground that everything the system holds is open-source
> intelligence. `docs/DECISIONS.md` **D12** records that and says what it does and does not
> change: D11 stands in full, and no data may be committed regardless. The paragraph below is
> what was specified before that was settled, kept because the rest of this checklist assumes
> the repository was made the way it describes.

Private, in the Astrion organisation. Do **not** initialise it with a README, licence or
`.gitignore` — this repository has its own and GitHub's would conflict on the first push.

## Push

From the unzipped repository root:

```bash
git remote add origin git@github.com:<org>/<repo>.git
git push -u origin main
```

The branch is already `main`.

Over HTTPS instead of SSH:

```bash
git remote add origin https://github.com/<org>/<repo>.git
git push -u origin main
```

CI runs on that first push. It needs no secrets: the workflow starts its own PostgreSQL 16 as
a service container.

## Protect main

Settings → Branches → Add rule, for `main`:

- Require a pull request before merging
- Require status checks to pass: **`migrate, seed, typecheck, test`**
- Require branches to be up to date before merging
- Do not allow force pushes

The status check name will only appear in that list after CI has run at least once, so push
first, then add the rule.

The reason for insisting on this rather than leaving it: the migrations are forward-only and
checksummed. A force push that rewrote an applied migration would leave every database that
had already run it unable to migrate, and the error would surface somewhere unrelated.

## What CI does

`.github/workflows/ci.yml`, two jobs.

**`migrate, seed, typecheck, test`** — starts PostgreSQL 16, then:

| Step | Why |
|---|---|
| `npm ci` | The lockfile is the contract. Drift fails here rather than in a branch. |
| `npm run typecheck` | |
| `npm run migrate` | 18 forward-only SQL migrations. |
| `npm run migrate` again, then `migrate:status` | Applying twice must be a no-op. Also catches an edited migration, because the runner checksums applied files. |
| `npm run seed` twice | The seed loaders claim idempotency; this checks it. |
| `npm test` | 164 tests against a real database. |
| `npm run accept` | Fails the build on a `FAIL` line. Blocked items are expected and do not fail it. |

**`docker image builds`** — a separate job so a Docker problem is distinguishable from a test
failure. The image is how this deploys to Azure Container Apps per spec section 2.3.

There is also a **No DACIS-derived data committed** step, which fails on a tracked file under
`data/seed/` and warns on any token shaped like a real UEI.

Every step of the first job was run locally against a real PostgreSQL 16 and passes. **The
Docker job was not**, because no Docker daemon was available in the environment this was built
in. The `Dockerfile` did change when Gate A was answered — it no longer copies `data/seed` —
so if the first CI run shows one red job, that is the one to expect, and the fix will be small.

## After it is up

1. File the entries in `docs/BACKLOG.md` as issues. They are written to be pasted more or
   less verbatim, and the two issue templates in `.github/ISSUE_TEMPLATE/` match their shape.
2. Open one issue for the export change that is still outstanding: populate `Transaction #`.
   The source-data template fits it. Gate A itself needs no issue — it is answered and acted
   on, and `docs/DECISIONS.md` D11 records what followed.
3. Build the next phase on a branch. `docs/BACKLOG.md` is in dependency order; the scoring
   engine is item 2 and unblocks four acceptance tests.

## The one thing that stops being true

Once this is on GitHub, `cie_phase1.zip` is a stale copy. Delete it, or the next person to
pick this up will edit the wrong thing.
