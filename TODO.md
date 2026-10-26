# To do

Work that has not been done yet but needs to be done. Finished items are removed from the list.

## Structure tab (MySQL, MariaDB, PostgreSQL)

- [ ] "Table" section: table name, comment; in MySQL, engine, character set and collation, AUTO_INCREMENT. For the character set, "change only the default" and "also convert the existing columns" (`CONVERT TO`) must be separate options. The model in core, the ALTER generation and the reading in the adapter (`describeTable`, `tableOptionChoices()`) are ready; the extension sending the choice lists to the page, and the UI, are missing.
- [ ] "Checks" section: adding and dropping CHECK constraints. The core and adapter side is ready, the UI is missing.
- [ ] When a table is renamed, the open data tab's title, its ID (the `TableDataPanel` key), the query in the editor (`FROM`) and the tree's cache must switch to the new name.
- [ ] End-to-end tests for these three items.
- [ ] Warn in advance about changes the server will reject; currently the server's error message is shown:
  - In MySQL, a column used by a CHECK cannot be renamed or dropped.
  - A column used in a foreign key's referential action (e.g. `ON DELETE SET NULL`) cannot be used in a CHECK.
- [ ] PostgreSQL: make indexes with an expression, a condition (`WHERE`), ordering, an operator class or a `WITH` option, and EXCLUDE constraints, editable; currently they can only be dropped.
- [ ] PostgreSQL: allow choosing `GENERATED ALWAYS` for new identity columns; allow converting serial (`nextval`) columns to identity.
- [ ] PostgreSQL: allow changing the expression of generated columns (`GENERATED ALWAYS AS … STORED`).
- [ ] PostgreSQL: allow editing the `USING` expression on a type change; currently `USING "column"::new_type` is always written.

## Data tab (grid)

- [ ] Make binary columns (MySQL binary/blob, PostgreSQL `bytea`) editable.
- [ ] Dedicated editors for PostgreSQL arrays, JSON and range types; currently the server's text format (`{a,b}`) is edited by hand.
- [ ] In PostgreSQL, after an edit, get the changed rows with `RETURNING` instead of querying the page again.

## Query console

- [ ] "Save as snippet" (snippet feature).
- [ ] Pinning the result tab ("Pin result tab").
- [ ] Suggestion row in the Execution Plan (e.g. "full table scan … index suggestion").
- [ ] MySQL: server warnings (`SHOW WARNINGS`) in the Messages tab.
- [ ] Fix suggestion on the error line (e.g. "Replace with o.total").
- [ ] Restore the open console and data tabs when VS Code is reopened (`WebviewPanelSerializer`).
- [ ] PostgreSQL: visual plan with `EXPLAIN (FORMAT JSON)`.
- [ ] PostgreSQL: `COPY … FROM STDIN` / `TO STDOUT` support.
- [ ] PostgreSQL: show `LISTEN`/`NOTIFY` notifications.
- [ ] `\'` in `E'…'` strings confuses the statement splitter; report it to `dbgate-query-splitter` and bump the version once a fix lands.

## Sidebar filter

- [ ] PostgreSQL: besides the database the data source is connected to, also search the other open database connections.
- [ ] PostgreSQL: also search sequences and types; show overloaded functions as separate nodes, as in the tree.
- [ ] Search MongoDB collections.
- [ ] Search Kafka topics.

## Query History

- [ ] A setting to turn off the history. Currently the executed SQL, together with the values in it, is kept as plain text in global state.

## PostgreSQL

- [ ] Tree: show partitions under the partitioned table.
- [ ] Tree: trigger, policy, role/privilege, extension and foreign server nodes.
- [ ] Tree: an option to show the functions, types and tables created by extensions.
- [ ] Connecting via a Unix socket (`host=/var/run/postgresql`).
- [ ] Multiple hosts (`host1,host2`) and `target_session_attrs`.
- [ ] For a data source whose password is set to "Never", don't ask for the password again when switching to another database.
- [ ] Test logging in with an SSL client certificate.
- [ ] Also run the integration tests against PostgreSQL 12–16; currently they run only against 17.

## Redis

- [ ] Cluster topology: SCAN must be done separately on each master node; database index 0 only.
- [ ] Sentinel topology: master name and sentinel addresses.
- [ ] redis-cli escapes in the CLI (`\n`, `\xHH`).
- [ ] SUBSCRIBE, MONITOR and MULTI/EXEC/WATCH support (on a separate connection).
- [ ] Blocking commands such as BLPOP must not make the key browser wait; they should run on a separate connection.
- [ ] Show the values of module types (JSON, TimeSeries, Bloom…).
- [ ] Show stream consumer groups.
- [ ] Keep a hash field's TTL when the field is renamed; currently HDEL + HSET removes it.
- [ ] Connecting via a Unix socket.

## MySQL and Redis connection

- [ ] Verify the TLS certificate against the system's CAs; currently a CA file is required.

## MongoDB

- [ ] Review the collection screen once the design arrives; currently it is inspired by the Redis, SQL and Kafka screens.
- [ ] Continue to the next batch with `it` in the shell.
- [ ] Authentication: X.509, LDAP, Kerberos, AWS IAM and OIDC.
- [ ] Reaching replica set members and SRV records through an SSH tunnel; currently only a single host.
- [ ] Import (JSON, JSON Lines, CSV).
- [ ] Change stream, GridFS, user/role management, sharding and replica set status screens.
- [ ] Keep the shell height and the document panel width when the tab is reopened.

## Kafka

- [ ] Replace the screen's own copies of the dialog, confirmation and notification (`KafkaDialog`, `ConfirmDialog`, `KafkaToast`) with the shared `ModalDialog`, `ConfirmDialog` and `ToastNote` components.
- [ ] Authentication for Schema Registry, Kafka Connect and ksqlDB (e.g. Confluent Cloud API key).
- [ ] Decode Protobuf schemas and Avro schemas that reference other subjects.
- [ ] JSON/Avro serialization for the key in Produce as well.
- [ ] Match write responses using a `writeId` to be added to the protocol; currently, if two writes of the same kind finish in reverse order, the messages can get mixed up.
- [ ] Show past checks in the Health strip.
- [ ] Test connecting with TLS, SCRAM and OAUTHBEARER, partitions without a leader, and offset gaps left by the log cleaner.
- [ ] Try `@platformatic/kafka` with the Node version of VS Code 1.105; the library requires Node ≥ 22.22 / 24.6.
