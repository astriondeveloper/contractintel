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

## Azure Container Apps

Spec section 2.3. The image is the same one CI builds; nothing about it is Azure-specific.

Build and push:

```bash
az acr build --registry <registry> --image cie:$(git rev-parse --short HEAD) .
```

Create the app, with the connection string as a secret rather than a plain variable:

```bash
az containerapp create \
  --name cie \
  --resource-group <group> \
  --environment <container-apps-environment> \
  --image <registry>.azurecr.io/cie:<tag> \
  --target-port 3000 \
  --ingress internal \
  --secrets db-url="postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/cie" \
  --env-vars DATABASE_URL=secretref:db-url PGSSLMODE=require \
  --min-replicas 1 --max-replicas 3
```

Four things to get right:

**`--ingress internal`, not `external`.** The interface has no authentication. It is a window
on the corpus, and the corpus is the thing Gate A is careful about. Put it behind the
network boundary, or behind an authentication proxy, before making it reachable from the
internet. Container Apps can front it with Microsoft Entra authentication if it needs to be
reachable from outside the VNet.

**`PGSSLMODE=require`.** Azure Database for PostgreSQL rejects an unencrypted connection.
Without this the app starts and every screen reports a database error.

**Migrations are a job, not a startup step.** The app does not migrate on boot, deliberately:
several replicas racing the same forward-only migration is a bad way to find out that
migrations are not idempotent under concurrency. Run them once, as a job, before the
revision goes live:

```bash
az containerapp job create \
  --name cie-migrate --resource-group <group> \
  --environment <container-apps-environment> \
  --image <registry>.azurecr.io/cie:<tag> \
  --trigger-type Manual --replica-timeout 600 \
  --secrets db-url="..." \
  --env-vars DATABASE_URL=secretref:db-url PGSSLMODE=require \
  --command "npm" --args "run,migrate"
```

**The scheduled load is a second job.** Spec decision D8 permits scheduled file drops and
forbids ad hoc upload, so the load runs on a schedule against a mounted share
(`CIE_DROP_DIR`), never as an endpoint on the interface. Give it
`--trigger-type Schedule` and the same image with `--args "run,load"`.

### Health probes

`/healthz` returns 200 with `{"status":"ok"}` when the database is reachable and 503 when it
is not. It does not depend on a corpus being loaded, so it is a correct readiness probe on a
fresh deployment. The `Dockerfile` already declares a `HEALTHCHECK` against it.

## What is deliberately not here

**No authentication.** The interface reads; it does not write, and the router returns 405 to
anything but `GET` and `HEAD`. That makes it safe to run beside a database, not safe to
publish. Access control belongs at the network or proxy layer until spec section 20's audit
trail exists, at which point the write screens arrive with it.

**No static hosting.** Every screen is a live query. There is nothing to publish to a static
host, and a snapshot of the corpus checked into a repository or pushed to a public host is
exactly what Gate A forbids.
