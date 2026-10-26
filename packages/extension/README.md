# Datakit

Connect to **MySQL / MariaDB**, **PostgreSQL**, **MongoDB**, **Redis** and **Kafka** from VS Code. Browse their
objects, run queries and commands, and view and edit data without leaving the editor.

![The New data source form for MySQL: name, environment, host, port, user, password and connection URL, with tabs for SSH / SSL, options and advanced settings](https://raw.githubusercontent.com/bakiun/datakit/main/packages/extension/images/new-data-source.png)

## Getting started

1. Open the **Datakit** view in the Activity Bar.
2. Click **New Data Source**, pick the server type, and fill in the form or paste a connection URL.
3. Click **Test Connection**, then **Save & connect**.
4. Expand the data source in the **Data Sources** tree and double-click an object to open it.

## Data sources

- Create and edit connections with a form or a connection URL, and test them before saving.
- Connect through an SSH tunnel (password, private key or SSH agent) and use SSL / TLS.
- Passwords are kept in VS Code's secret storage, never in settings.
- Data sources are grouped into **Development**, **Staging** and **Production** folders. On Production data sources,
  every write asks for confirmation.
- The filter in the Data Sources title bar searches the tables of connected data sources.
- The **Query History** view keeps the queries you ran, ready to open again or copy.

## MySQL and MariaDB

![A MySQL table open in the data view: a SQL editor above a paged, editable grid of rows](https://raw.githubusercontent.com/bakiun/datakit/main/packages/extension/images/table-data.png)

- Browse databases, tables, views and routines.
- Double-click a table to open its data view: a SQL editor whose last query fills a grid that pages, sorts, edits and
  exports rows.
- Change a table's columns and indexes on the Structure tab.
- Query consoles run scripts against the database of your choice, with Messages and Execution Plan tabs.

## PostgreSQL (12 or later)

- Browse databases, schemas, tables, views, materialized views, sequences, functions, procedures and types (enums,
  domains, ranges and composite types). Opening another database connects to it.
- Values keep the server's own text (numeric, JSON, arrays, intervals, time zones). Enums and booleans get a drop-down.
- Edits are written by primary or unique key with typed parameters, and a set of structure changes runs in one
  transaction.
- Consoles pick a database and a schema, show `RAISE NOTICE` output and warnings, cancel a running statement, and
  explain statements with `EXPLAIN` or `EXPLAIN ANALYZE` (rolled back).
- Right-click an object to see its definition, or a materialized view to refresh it.

## MongoDB

- Browse databases, collections and views.
- Find documents with a filter, projection and sort in shell syntax, e.g.
  `{ created: { $gt: ISODate("2026-01-01") } }`.
- View documents as a list, a table or JSON, and edit them in place. Insert documents, and update or delete them by
  filter.
- Run aggregation pipelines, explain queries, manage indexes and sample the schema.
- Export to JSON or CSV, and run common mongosh commands in the built-in shell.

## Redis

- Browse the databases that hold keys and list keys with `SCAN` (for example `SCAN 0 MATCH user:* COUNT 500 TYPE hash`).
  `KEYS` runs as `SCAN`, so large databases stay responsive.
- Edit strings, hashes (with per-field TTLs on Redis 7.4+), lists, sets, sorted sets and streams.
- Create, rename and delete keys, change TTLs, and export a value.
- Run commands in the built-in CLI.

## Kafka

![The Kafka workspace showing the cluster overview: brokers, topics, under-replicated partitions, consumer lag and connector health](https://raw.githubusercontent.com/bakiun/datakit/main/packages/extension/images/kafka-overview.png)

- See the cluster overview and its health, brokers and their dynamic settings.
- Manage topics: create, clone, clear, delete, change settings and add partitions.
- Browse a topic's messages with filters, follow a live stream, produce messages and dump them to JSON Lines.
- Inspect consumer groups with their lag and reset offsets. Manage ACLs.
- With their URLs set on the data source: Schema Registry subjects, Kafka Connect connectors and a ksqlDB editor.

## Requirements

VS Code 1.105 or later.

## Feedback

Report bugs and request features on [GitHub Issues](https://github.com/bakiun/datakit/issues).

## License

[GNU General Public License v3.0](https://github.com/bakiun/datakit/blob/main/LICENSE)
