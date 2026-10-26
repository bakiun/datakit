# Datakit — VS Code data extension

Connect to database servers from VS Code and work with their data. Supported engines: **MySQL / MariaDB**, **PostgreSQL**, **MongoDB**, **Redis** and **Kafka**.
Create and edit data sources (or paste a connection URL) and test the connection. The Data Sources tree groups them in
Development, Staging and Production folders by their Environment; on Production ones every write asks for confirmation. For MySQL and MariaDB, browse
databases, tables, views and routines, and double-click a table to open its data view: a SQL script editor whose last query fills a grid that
pages, sorts, edits and exports rows. Query consoles (`console-1.sql` under a data source) run scripts in a database
of your choice, with Messages and Execution Plan tabs. The filter in the Data Sources title bar searches the tables
of connected data sources, and the Query History view keeps what you ran.

For PostgreSQL (12 or later), the tree lists the databases of the server, the schemas of each database and their
tables, views, materialized views, sequences, functions, procedures and types (enums, domains, ranges and composite
types); the database the data source names and its `public` schema open first, and another database connects when
you open it. Tables open in the same data view and Structure tab as MySQL's: values keep the server's text (numeric,
int8, JSON, arrays, intervals, time zones), enums and booleans get a drop-down, edits are written by primary or unique
key with typed parameters, and a structure change set runs in one transaction. Consoles pick a database and a schema
(search path), show `RAISE NOTICE` and warnings under Messages, stop a running statement with `pg_cancel_backend`,
and explain statements with `EXPLAIN` or `EXPLAIN ANALYZE` (rolled back). Right-click an object for its definition,
or a materialized view to refresh it. The filter searches the schemas of the database the data source connects to.

For MongoDB, the tree lists databases and their collections and views; double-click a collection to open it. Find
documents with a filter, projection and sort in shell syntax (`{ created: { $gt: ISODate("2026-01-01") } }`), see
them as a list, a table or JSON, edit them in place, insert, delete and update by filter, run aggregation pipelines,
explain queries, manage indexes, sample the schema, export to JSON or CSV, and run common mongosh commands in the
shell under it.

For Redis, the tree lists the databases that hold keys; double-click one to open the key browser. The command at its
top lists keys (`SCAN 0 MATCH user:* COUNT 500 TYPE hash`, or `KEYS`, which runs as SCAN); other commands typed there run
like the CLI. Edit strings, hashes (with per-field TTLs on Redis 7.4+), lists, sets, sorted sets and streams, rename keys,
change TTLs, create and delete keys, export a value, and run commands in the CLI under it.

For Kafka, the tree lists the sections of the Kafka workspace; double-click one to open it. The workspace shows the
cluster overview and its health, brokers and their dynamic settings, topics (create, clone, clear, delete, settings,
partitions), the messages of a topic with filters, a live stream, produce and a dump to JSON Lines, consumer groups
with lag and offset resets, and ACLs. With their URLs set on the data source it also shows Schema Registry subjects,
Kafka Connect connectors and a ksqlDB editor.

Project standards are in [CLAUDE.md](CLAUDE.md).

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

- **Run the extension:** press F5 ("Run Extension").
- **Local servers:** `docker compose -f docker/docker-compose.yml up -d` starts MySQL 8.4 on port 33306 and
  MariaDB 11.4 on port 33307 with a sample `shop` database (user `app`, password `app-secret`), and Redis 8.0 on
  port 36379 (password `datakit`). Kafka 4.0 listens on 39092 (PLAINTEXT) and 39094 (SASL PLAIN, users `admin` and
  `app`, password `datakit`), with Schema Registry on 38081 and Kafka Connect on 38083; ksqlDB on 38088 starts
  with `--profile ksqldb`. MongoDB 8 listens on 37017 (user `root`, password `datakit`) with a sample `shop`
  database. PostgreSQL 17 listens on 35432 (user `app`, password `app-secret`; superuser `postgres`, password
  `datakit`) with the sample databases `shop` (schemas `public` and `inventory`) and `analytics`.
- **Work on the webview in a browser:** `pnpm dev:webview` serves the data source editor with a mock host.
  Query flags: `?edit` (edit an existing data source), `?view=tableData` (the data view, `&readonly`, `&postgres`),
  `?view=queryConsole` (the query console, `&postgres`), `?view=redisKeys` (the Redis key browser), `?view=kafkaWorkspace`
  (the Kafka workspace, `&readonly`, `&noservices`, `&production`), `?view=mongoCollection` (a MongoDB collection,
  `&readonly`, `&view-collection`), `?theme=light`.
  A host named `fail` makes Test Connection fail; a WHERE condition containing `fail` makes the data query fail.
- **e2e without downloading VS Code:** set `VSCODE_TEST_PATH` to an installed VS Code binary, e.g.
  `/Applications/Visual Studio Code.app/Contents/MacOS/Code`.

| Package                    | Contents                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core`            | Data source model, validation, connection URL, webview protocol, SQL session contract and SQL dialects (MySQL, PostgreSQL). |
| `packages/adapters/common` | Node helpers shared by adapters: SSH tunnel (ssh2), TLS and key files, connection errors.    |
| `packages/adapters/mysql`  | MySQL and MariaDB adapter (mysql2).                                                          |
| `packages/adapters/postgres` | PostgreSQL adapter (pg, pg-cursor for streamed exports).                                   |
| `packages/adapters/redis`  | Redis adapter (node-redis).                                                                  |
| `packages/adapters/mongodb` | MongoDB adapter (mongodb, mongodb-query-parser) with a shell for common mongosh commands.  |
| `packages/adapters/kafka`  | Kafka adapter (@platformatic/kafka) and REST clients for Schema Registry, Kafka Connect, ksqlDB. |
| `packages/extension`       | Activation, Data Sources tree and filter, commands, connection store and sessions, data source editor, data views, query consoles, query history, PostgreSQL definitions and materialized views, MongoDB collections, Redis key browser, Kafka workspace. |
| `packages/webview-ui`      | Vue UI for the webviews, built into `packages/extension/dist/webview`.                      |

## License

Datakit is licensed under the [GNU General Public License v3.0](LICENSE).
