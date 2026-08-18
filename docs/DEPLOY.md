# Running the interface, and deploying it

The interface is one container that talks to one PostgreSQL database over `DATABASE_URL`
and reads nothing else. Spec section 16: configuration from environment variables, no cloud
coupling. Moving it between a laptop and Azure is a change of two variables.

## On a laptop

```bash
cp .env.example .env
docker compose up
```

That starts PostgreSQL 16, applies the 18 migrations, loads whatever seed files are in
`./data/seed`, and serves the interface on **http://localhost:3000**.

Without Docker, against any PostgreSQL 16 you can reach:

```bash
npm install
npm run migrate
npm run seed
npm run web
```

The interface renders against an empty database rather than failing, so it is safe to start
before a corpus exists. Every screen says what would fill it.

To load a corpus into the running stack:

```bash
docker compose --profile load run --rm load     # reads ./data/drops
# or, outside Docker
npm run load -- --dry-run --dir /path/to/exports
npm run load -- --dir /path/to/exports
```

## Environment

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none, required | PostgreSQL connection string. The only thing that changes between a laptop and Azure. |
| `PGSSLMODE` | empty | Set to `require` against Azure Database for PostgreSQL Flexible Server. |
| `PORT` | `3000` | Port the interface listens on. |
| `HOST` | `0.0.0.0` | Bind address. Leave it alone in a container. |
| `PGPOOL_MAX` | `10` | Connection pool ceiling. Raise with the database's `max_connections`, not past it. |
| `CIE_SEED_DIR` | `./data/seed` | Where the three authored seed files are mounted. Never baked into the image. |
| `CIE_DROP_DIR` | `./data/drops` | Where the scheduled export drop lands. Spec decision D8. |

Nothing is a secret except `DATABASE_URL`. It carries a password, so it belongs in a secret
store rather than in a deployment manifest.

## Azure Container Apps, from nothing

Spec section 2.3. One command, and it is also the redeploy command: it creates what is
missing and leaves alone what is already there.

```bash
az login
./scripts/deploy-azure.sh --resource-group cie --location eastus
```

It creates a resource group, a container registry, a PostgreSQL 16 flexible server, a
Container Apps environment, a migration job, and the app; builds the image in the registry
rather than locally, so no Docker daemon is needed; runs the migrations as a one-off job;
and prints the URL.

The database password is generated on the first run and printed once. Azure will not read
it back, so keep it: a redeploy against the same server needs it as `DB_PASSWORD`.

To publish it on the internet:

```bash
./scripts/deploy-azure.sh --resource-group cie --location eastus --ingress external
```

Read the next section before you do.

### Ingress, and the fact that there is no authentication

**The interface has no authentication.** With `--ingress external`, anyone with the URL
reads the whole corpus. That is a property of the build, not an oversight, and public
ingress does not make it safe — it makes it a decision.

`docs/DECISIONS.md` **D12** records that decision: everything the system currently holds is
open-source intelligence, so publishing it costs nothing that is not already public. Two
things follow.

**The default is still `internal`.** Public ingress is something a deploy asks for
explicitly, because the argument for it is about today's corpus rather than about the
software.

**It stops being appropriate when the corpus stops being OSINT.** Pipeline judgements,
capture strategy, and the `campaign` and `pursuit` tables are Astrion's own thinking rather
than a public record. The scoring engine is the phase that starts filling them. Authentication
belongs to that same phase as the first write screen, because spec section 20's audit trail
needs an identity to attribute a change to. Until then, `internal` plus the VNet, or
Container Apps' built-in Microsoft Entra authentication, is a five-minute change:

```bash
az containerapp auth microsoft update \
  --name cie-web --resource-group cie \
  --client-id <app-registration-id> --tenant-id <tenant> \
  --issuer "https://login.microsoftonline.com/<tenant>/v2.0"
az containerapp auth update --name cie-web --resource-group cie \
  --unauthenticated-client-action RedirectToLoginPage
```

### Redeploying from GitHub

`.github/workflows/deploy.yml` does the second deploy onwards: build the image, run the
migration job, wait for it, roll the app, check `/healthz`. It never needs the connection
string, because that is already a Container Apps secret on both the job and the app.

After the first `scripts/deploy-azure.sh` run, set these repository **variables**:

| Variable | Value |
|---|---|
| `AZURE_RESOURCE_GROUP` | The resource group you passed |
| `AZURE_REGISTRY` | The registry name the script printed |
| `AZURE_APP` | `cie-web`, unless you changed `--prefix` |
| `AZURE_MIGRATE_JOB` | `cie-migrate`, unless you changed `--prefix` |
| `DEPLOY_ON_PUSH` | `true` to deploy on every push to `main`. Leave unset for manual only. |

And one credential, either:

- **OpenID Connect**, preferred, nothing long-lived stored: variables `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, with a federated credential on the app
  registration scoped to this repository.
- **A service principal**: secret `AZURE_CREDENTIALS`, the JSON from
  `az ad sp create-for-rbac --sdk-auth`.

The workflow runs in the `production` environment, so adding a required reviewer there gates
every deploy behind an approval.

### Migrations are a job, not a startup step

The app does not migrate on boot, deliberately. Several replicas racing the same
forward-only migration is a bad way to find out whether the runner is safe under
concurrency, and a migration failure should stop a deploy rather than crash-loop a revision.
Both the script and the workflow run the job first and roll the app only if it succeeds.

### The scheduled load

Spec decision D8 permits scheduled file drops and forbids ad hoc upload, so the load is a
second job against a mounted share rather than an endpoint on the interface:

```bash
az containerapp job create \
  --name cie-load --resource-group cie --environment cie-env \
  --image <registry>.azurecr.io/cie:latest \
  --trigger-type Schedule --cron-expression "0 6 * * *" \
  --secrets db-url="..." \
  --env-vars DATABASE_URL=secretref:db-url PGSSLMODE=require CIE_DROP_DIR=/app/data/drops \
  --command "npm" --args "run,load"
```

Mount the share the scheduled export writes into at `/app/data/drops`. Every loader is
idempotent, so a job that runs against an unchanged folder reports zero new and writes
nothing.

### The other scheduled jobs, and why a deployment without them looks broken

The load fills the corpus. It does not fill the feed, the forecast or the score, and a
deployment that ran only the migration and the load would sit there with every screen
correctly explaining that it is empty. That is the most likely way this goes live and gets
written off, so the jobs are listed here with the rhythm each one actually wants.

| Job | Command | Rhythm | What it fills |
|---|---|---|---|
| Targeting profile | `npm run profile` | after each corpus load | The NAICS and PSC codes both notice searches ask for |
| Notices, primary | `npm run load:govcon` | **hourly** | The feed's open solicitations and sources sought |
| Notices, fallback | `npm run load:sam` | weekly | The same notices, as a check that the delta stream has not gone stale |
| Contract actions | `npm run load:contracts` | daily | Award recency: end dates and obligations for work awarded since the last extract |
| Recompete detection | `npm run signals` | monthly | The feed's recompetes |
| Scoring | `npm run score` | after each of the above | Every requirement's band and rule trace |
| Forecast | `npm run forecast` | weekly | The quarterly projection |
| Campaign sizing | `npm run size -- --actor <principal>` | monthly | TAM, SAM, SOM and the capture rate |
| Digest | `npm run digest` | weekly, once wired to a relay | Renders per person; sends nothing yet |

The rhythms are not invented here. `signal_class_threshold.rhythm` carries one per signal
class and BD Ops owns that row, so the cron and the database should agree; if they drift, the
database is right and the cron is stale.

One job per line, same shape as the load:

```bash
for spec in "govcon:0 * * * *:run,load:govcon" \
            "contracts:0 6 * * *:run,load:contracts" \
            "sam:0 7 * * 0:run,load:sam" \
            "signals:0 3 1 * *:run,signals" \
            "score:30 * * * *:run,score" \
            "forecast:0 4 * * 1:run,forecast"; do
  name="${spec%%:*}"; rest="${spec#*:}"; cron="${rest%%:*}"; args="${rest##*:}"
  az containerapp job create \
    --name "cie-$name" --resource-group cie --environment cie-env \
    --image <registry>.azurecr.io/cie:latest \
    --trigger-type Schedule --cron-expression "$cron" \
    --secrets db-url="..." sam-key="..." govcon-key="..." \
    --env-vars DATABASE_URL=secretref:db-url PGSSLMODE=require \
               SAM_API_KEY=secretref:sam-key GOVCON_API_KEY=secretref:govcon-key \
    --command "npm" --args "$args"
done
```

Both keys are Container Apps secrets and secrets only. They are read from the environment, never
written to the database, and a test per loader asserts neither reaches an archived payload.

`SAM_API_KEY` comes from api.data.gov and has to be registered for the Opportunities API
specifically; a key that works against another api.data.gov endpoint returns 403 there.

`GOVCON_API_KEY` comes from govconapi.com and is sent as a bearer token. Note the two different
failure modes: 401 is a key the API does not recognise, and 403 is a key it recognises on a plan
that does not include that endpoint or that date range. The second one cannot be fixed by checking
the key, which is why `--probe` prints the plan and the window rather than just "ok".

**Two things about the hourly job.** It is the only job here that runs hourly, and it is
affordable only because it is incremental — the cursor in `sync_cursor` is what makes the second
run of the hour ask for changes rather than for the window again. And the hourly allowance is
shared with the on-demand screening lookups a person triggers from a screen, so the sync holds
fifty requests back rather than draining it; a sync that took the interactive lookups down with it
would be a worse outcome than a sync that missed a few notices until the next hour.

Check `npm run load:govcon -- --cursor` after the first day. A cursor that has not moved means the
job is not running; a cursor carrying `! the last run was clamped` means a window was missed and
needs `--backfill`.

**Check it landed rather than assuming it did.** `npm run readiness` prints what the corpus
can and cannot support, and it is the one command to run after the first full cycle:

```bash
az containerapp job start --name cie-readiness --resource-group cie \
  --command "npm" --args "run,readiness"
```

It flags the things that are the honest state of a shallow corpus rather than defects, so a
run full of `!` on day one is expected. The figure to watch across the first month is how many
projections rest on a measurement rather than on the 365-day assumption: that number climbs on
its own as SAM.gov history accrues, with no code change.

### Checking the SAM.gov key from inside the container

The key is the one piece of configuration that cannot be verified from the environment listing,
and the network path to `api.sam.gov` is the one piece that differs between a laptop and a
container app with egress rules. `--probe` settles both in one request:

```bash
az containerapp job start --name cie-sam --resource-group cie \
  --command "npm" --args "run,load:sam,--,--probe"
```

It exits non-zero when the host is unreachable or the key is refused, so it works as a
smoke step in a release pipeline. It says which of the two it was: a failure before SAM.gov
answers is reported as a network or egress problem and explicitly not as a key problem, because
that is the confusion that costs an afternoon. `SAM_API_KEY` is an
[api.data.gov](https://api.data.gov/signup/) key registered for the Opportunities API — forty
characters of letters and digits with no punctuation. A SAM.gov account role is not this
credential.

### Developing against SAM.gov without a key

`npm run sam:stub` serves the v2 endpoint's shape on port 3999, with invented notices:

```bash
npm run sam:stub
SAM_API_BASE=http://localhost:3999/opportunities/v2/search \
  SAM_API_KEY=stub npm run load:sam
```

It answers 401 without a key and 400 without the posted range, because the real endpoint
does, and the tests inject the fetch function rather than using it — so this is the only thing
that exercises the actual HTTP path, the parameter shape and the pagination.

### Developing against GovCon API without a key

`npm run govcon:stub` does the same for GovCon API, on port 3998:

```bash
npm run govcon:stub
export GOVCON_API_BASE=http://localhost:3998/api/v1 GOVCON_API_KEY=stub
npm run load:govcon -- --probe
npm run load:govcon -- --unfiltered
npm run screen -- ZGCONUEI0002
```

Same reasoning, and it reproduces the four behaviours easiest to get wrong: 401 without a bearer
token, 400 on a bare `/opportunities/search`, a silent clamp with a `sync.clamp_reason` block on a
`since` older than 60 days, and an `X-RateLimit-Remaining` header that counts down so the reserve
logic actually fires. Every record it serves is invented and ZGCON-prefixed.

The stub is also where the field mapping gets checked. `--sample` prints the field names of the
first record returned, so on first contact with the live API you can compare them against
`GovconOpportunity` in `src/loaders/govcon/opportunities.ts` rather than assuming they match:

```bash
npm run load:govcon -- --dry-run --unfiltered --sample
```

A field this build does not read is a field not reaching the feed, and that is invisible without
looking.

### Health probes

`/healthz` returns 200 with `{"status":"ok"}` when the database is reachable and 503 when it
is not. It does not depend on a corpus being loaded, so it is a correct readiness probe on a
fresh deployment. The `Dockerfile` declares a `HEALTHCHECK` against it.

## A snapshot you can send someone

Deploying needs a database and a container. Neither is a reasonable thing to ask of someone
who wants to look at a screen and tell you what is wrong with it, so there is a third thing
between running it locally and deploying it:

```bash
npm run demo -- --out dist/demo.html
```

One HTML file, no server, no network, no database. It opens anywhere, carries every screen
including the entity detail ones, and the search boxes filter the exported rows in the page.
The stylesheet and all four Archivo weights are inlined, so it renders in Archivo rather than
falling back to Arial on a machine that has never seen the repository.

There is no second implementation behind it. Each screen is rendered by the same function the
server calls, so a screen that changes changes in the snapshot too.

Two things it is not, and it says both on the page: nothing in it is live, and each list
carries its first page of rows rather than all of them.

**Build it from a synthetic corpus unless you mean to hand someone the real one.** The file
embeds every row it renders. Point `DATABASE_URL` at a database seeded from `tests/seed` and
the companies in the output are invented; point it at the real corpus and the file is the
corpus.

## What is deliberately not here

**No static hosting of the live system.** Every screen is a live query against the database.
The snapshot above is for review and is stamped with the time it was built; a corpus
committed to a repository or pushed to a host would be wrong the day after it was taken.

**No data in the image.** `docs/DECISIONS.md` D11 keeps the seed files out of the repository
and out of the image, and D12 leaves that unchanged for a reason that survives the OSINT
finding: a repository is a bad place for a snapshot regardless of how sensitive it is, and
the authored seed files are Astrion's judgement about which spellings are one company rather
than any part of the public record.
