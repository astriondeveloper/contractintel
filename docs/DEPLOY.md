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

### Health probes

`/healthz` returns 200 with `{"status":"ok"}` when the database is reachable and 503 when it
is not. It does not depend on a corpus being loaded, so it is a correct readiness probe on a
fresh deployment. The `Dockerfile` declares a `HEALTHCHECK` against it.

## What is deliberately not here

**No static hosting.** Every screen is a live query against the database. There is nothing
to publish to a static host, and a snapshot of the corpus committed to a repository would be
wrong the day after it was taken.

**No data in the image.** `docs/DECISIONS.md` D11 keeps the seed files out of the repository
and out of the image, and D12 leaves that unchanged for a reason that survives the OSINT
finding: a repository is a bad place for a snapshot regardless of how sensitive it is, and
the authored seed files are Astrion's judgement about which spellings are one company rather
than any part of the public record.
