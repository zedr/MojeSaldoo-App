# MojeSaldoo Backend Container

## Build

### Build from Github

Use Containerfile.github — it clones the
`main` branch straight from GitHub at build time, so the build context can be
any directory containing the Containerfile. A GitHub API token must be
supplied as a **BuildKit secret** (never a plain `--build-arg`, which would
leak into the image history) via the `GITHUB_API_TOKEN` environment variable:

```bash
GITHUB_API_TOKEN=ghp_xxx podman build \
  --secret id=github_token,env=GITHUB_API_TOKEN \
  -f automation/containers/backend/Containerfile \
  -t mojesaldoo-backend:latest \
  .
```

> Requires a token with read access to
> `https://github.com/netka99/MojeSaldoo-App.git`. Podman/Buildah and Docker
> BuildKit both support `--secret`; the file's `RUN --mount=type=secret` reads
> it only for the duration of the clone step.

## Run with Compose (recommended)

A `compose.yml` at the **repo root** brings up the backend together with a
**PostgreSQL 16** database, with persistence and healthchecks already wired.
Since the backend's build clones its source from GitHub (see above), export
`GITHUB_API_TOKEN` before building — compose wires it to the `github_token`
build secret automatically (see the `secrets:` block in `compose.yml`). From
the repo root:

```bash
export GITHUB_API_TOKEN=ghp_xxx
podman compose up --build -d   # build the image and start in the background
podman compose logs -f backend # follow logs
podman compose down            # stop and remove the containers
```

It builds the backend image, publishes port `8000`, and points the backend at the
`db` service via `PG_DATABASE_URL`. The backend waits for Postgres to be healthy,
then the entrypoint runs migrations against it. Postgres data lives in the named
`pgdata` volume; uploaded media and logs are persisted under `./data/` on the host
(gitignored). When `PG_DATABASE_URL` is unset or malformed the backend falls back
to SQLite. Override the env vars from your shell or a `.env` file in the repo root,
e.g.:

```bash
DJANGO_SECRET_KEY="change-this-in-production" \
DJANGO_ALLOWED_HOSTS="localhost,127.0.0.1" \
  podman compose up --build -d
```

> Requires a compose provider (`podman-compose`, or the docker-compose plugin).
> Unlike the image's `HEALTHCHECK` (ignored under podman's default OCI format),
> the compose-level healthcheck against `/healthz/` is honored.

## Run (plain podman)

Prepare persistent directories on the host, then start the container:

```bash
mkdir -p /data/mojesaldoo/media
touch /data/mojesaldoo/db.sqlite3

podman run -d \
  --name mojesaldoo-backend \
  -p 8000:8000 \
  -v /data/mojesaldoo/db.sqlite3:/app/db.sqlite3:Z \
  -v /data/mojesaldoo/media:/app/media:Z \
  -e DJANGO_SECRET_KEY="change-this-in-production" \
  -e DJANGO_ALLOWED_HOSTS="localhost,127.0.0.1" \
  mojesaldoo-backend:latest
```

Configuration env vars (read in `config/settings.py`):

| Variable | Default | Notes |
| --- | --- | --- |
| `DJANGO_SECRET_KEY` | insecure dev key | **Set this** in any real deployment. |
| `DJANGO_DEBUG` | `False` (set in image) | Leave off in production. |
| `DJANGO_ALLOWED_HOSTS` | `*` | Comma-separated hostnames. |
| `PG_DATABASE_URL` | _unset_ → SQLite | `postgres://user:pass@host:5432/dbname`. When valid, the backend uses Postgres; otherwise it falls back to SQLite at `/app/db.sqlite3`. |

## Migrations

Migrations run automatically at container start via the entrypoint
(`manage.py migrate --noinput`) before gunicorn launches, so the bind-mounted
`db.sqlite3` is brought up to date on every boot.

## Verify

```bash
# Liveness endpoint — should return {"status": "ok"} with HTTP 200
curl -s http://localhost:8000/healthz/

# Container health status (from the HEALTHCHECK)
podman inspect --format '{{.State.Health.Status}}' mojesaldoo-backend

# Check logs
podman logs mojesaldoo-backend
```

## Sanity checks (after build)

```bash
podman run --rm mojesaldoo-backend:latest tesseract --version
podman run --rm mojesaldoo-backend:latest tesseract --list-langs | grep pol
podman run --rm mojesaldoo-backend:latest ls /app/staticfiles/
```

## Notes

- **Volumes**: do not mount `/app` as a whole — this would shadow the baked-in `staticfiles/`. Mount only `db.sqlite3` and `media/` as shown above.
- **Base image / Tesseract**: built on `centos:stream10`. Its BaseOS provides the platform Python 3.12 (`python3` package, `python3.12` binary) and AppStream provides `tesseract`/`tesseract-langpack-pol` directly (EPEL no longer packages Tesseract). An internet connection is required at build time to pull packages.
- **Static files**: collected into `/app/staticfiles/` at build time and served by WhiteNoiseMiddleware.
