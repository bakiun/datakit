# Contributing to Datakit

This guide covers building Datakit from source, the local test servers and the package layout. For what the
extension does, see the [README](README.md). Project standards are in [CLAUDE.md](CLAUDE.md).

## Development

Requires Node.js 24 LTS (24.22.1 or later; `nvm use` reads `.nvmrc`), pnpm and Docker.

```sh
git clone https://github.com/bakiun/datakit.git
cd datakit
pnpm install
pnpm build          # webview UI + extension bundle
pnpm typecheck
pnpm test           # unit tests and the adapter integration tests (Testcontainers, Docker)
pnpm test:e2e       # starts docker/docker-compose.yml and runs the extension inside VS Code
pnpm package        # packages/extension/datakit-<version>.vsix
```

**Run the extension:** press F5 ("Run Extension").

## Local servers

`docker compose -f docker/docker-compose.yml up -d` starts these servers:

| Server          | Port                                  | Credentials                                                                 | Sample data                                                         |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| MySQL 8.4       | 33306                                 | user `app`, password `app-secret`                                           | `shop` database                                                     |
| MariaDB 11.4    | 33307                                 | user `app`, password `app-secret`                                           | `shop` database                                                     |
| PostgreSQL 17   | 35432                                 | user `app`, password `app-secret`; superuser `postgres`, password `datakit` | databases `shop` (schemas `public` and `inventory`) and `analytics` |
| MongoDB 8       | 37017                                 | user `root`, password `datakit`                                             | `shop` database                                                     |
| Redis 8.0       | 36379                                 | password `datakit`                                                          |                                                                     |
| Kafka 4.0       | 39092 (PLAINTEXT), 39094 (SASL PLAIN) | SASL PLAIN users `admin` and `app`, password `datakit`                      |                                                                     |
| Schema Registry | 38081                                 |                                                                             |                                                                     |
| Kafka Connect   | 38083                                 |                                                                             |                                                                     |
| ksqlDB          | 38088                                 |                                                                             |                                                                     |

ksqlDB starts only with `--profile ksqldb`.

## Working on the webview in a browser

`pnpm dev:webview` serves the data source editor with a mock host. Query flags:

- `?edit`: edit an existing data source.
- `?view=tableData`: the data view, with `&readonly` and `&postgres`.
- `?view=queryConsole`: the query console, with `&postgres`.
- `?view=redisKeys`: the Redis key browser.
- `?view=kafkaWorkspace`: the Kafka workspace, with `&readonly`, `&noservices` and `&production`.
- `?view=mongoCollection`: a MongoDB collection, with `&readonly` and `&view-collection`.
- `?theme=light`.

A host named `fail` makes Test Connection fail; a WHERE condition containing `fail` makes the data query fail.

## End-to-end tests

`pnpm test:e2e` downloads VS Code unless you point it at an installed one. To skip the download, set
`VSCODE_TEST_PATH` to an installed VS Code binary, e.g. `/Applications/Visual Studio Code.app/Contents/MacOS/Code`.

## Packages

| Package                      | Contents                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | Data source model, validation, connection URL, webview protocol, SQL session contract and SQL dialects (MySQL, PostgreSQL).                                                                                                                               |
| `packages/adapters/common`   | Node helpers shared by adapters: SSH tunnel (ssh2), TLS and key files, connection errors.                                                                                                                                                                 |
| `packages/adapters/mysql`    | MySQL and MariaDB adapter (mysql2).                                                                                                                                                                                                                       |
| `packages/adapters/postgres` | PostgreSQL adapter (pg, pg-cursor for streamed exports).                                                                                                                                                                                                  |
| `packages/adapters/redis`    | Redis adapter (node-redis).                                                                                                                                                                                                                               |
| `packages/adapters/mongodb`  | MongoDB adapter (mongodb, mongodb-query-parser) with a shell for common mongosh commands.                                                                                                                                                                 |
| `packages/adapters/kafka`    | Kafka adapter (@platformatic/kafka) and REST clients for Schema Registry, Kafka Connect, ksqlDB.                                                                                                                                                          |
| `packages/extension`         | Activation, Data Sources tree and filter, commands, connection store and sessions, data source editor, data views, query consoles, query history, PostgreSQL definitions and materialized views, MongoDB collections, Redis key browser, Kafka workspace. |
| `packages/webview-ui`        | Vue UI for the webviews, built into `packages/extension/dist/webview`.                                                                                                                                                                                    |

The Marketplace page of the extension shows the root [README.md](README.md): `pnpm package` passes it to vsce with
`--readme-path`. Links in it must be absolute, since the Marketplace cannot resolve relative links in this monorepo.
