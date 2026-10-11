# LoraiScan

LoraiScan is a standalone audit-submission shell and multi-chain token scanner,
extracted from the Lora repository.

## Audit shell

Copy `config.example.yaml` to the ignored `config.yaml`, configure the primary
Lora database DSN, and set the Lorai API/RPC values in `audit.yaml` or through
environment variables such as `AUDIT_APIKEY` and
`AUDIT_RPCURLBYCHAIN_BSC`.

```bash
go run ./cmd/loraiscan
```

The shell can read contracts from the Lora `new_contracts` table or tokens from
the scanner's `token_liquidity` table. Use `--asset-db-dsn` when those tables
are stored in different databases.

## Scanner stack

The scanner runtime is in `scanner/`; the root Compose file owns its MySQL and
chain workers. Copy `scanner/.env.example` to `.env`, then start all currently
supported workers:

```bash
docker compose --profile robin --profile eth --profile base --profile arb up -d
```

The Compose volume has an explicit legacy name so an existing deployment can
be moved without copying or recreating MySQL data.
Workers build locally by default. Set `SCANNER_IMAGE` in `.env` to use a
published image instead.

Useful checks:

```bash
go test ./...
npm --prefix scanner test
docker compose --profile robin --profile eth --profile base --profile arb config --quiet
```
