# Deploy to Fly.io (single server)

This app runs as a single container (Python backend + static-built frontend).

## One-time setup

```bash
fly auth login
fly apps create <your-app-name>
```

Update `fly.toml` `app = "<your-app-name>"`.

## Deploy

To avoid Fly's "redundancy by default" creating multiple Machines:

```bash
fly deploy --ha=false
fly scale count 1 -y
```

`fly scale count 1` is preserved across future `fly deploy` runs (unless you scale down to zero Machines).

## Convenience script

```bash
./scripts/fly-deploy-single.sh
```

