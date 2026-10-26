# Datakit VS Code Extension — Project Standards

Datakit is an extension that connects from inside VS Code, as a client, to servers such as Kafka, MongoDB, MariaDB/MySQL, PostgreSQL and Redis. The goal is a complete database client experience: establishing connections, running queries and commands, and listing and editing data.

The rules in this file are binding. If a rule needs to be departed from, approval is obtained first.

When several different tasks are given, use sub-agents.

## 1. UI: Vue.js

- All webview UIs are written with **Vue 3**: Single File Components (`.vue`), `<script setup lang="ts">` and the Composition API.
- No other UI framework such as React, Svelte, Angular or Solid is used. The UI is not written without a framework, in plain DOM code, either.
- When choosing a UI library, such as a table, form or editor component, a library that has a Vue version or is framework-independent (web component, pure JS) is chosen. Libraries written only for React are not used.
- The UI follows the VS Code theme: colors, fonts and spacing are taken from `--vscode-*` CSS variables; no hard-coded colors are written. It must look right in light, dark and high-contrast themes.
- If VS Code's own components (Tree View, Quick Pick, text editor, notifications) do the job, no webview is opened. Webviews are used for rich screens such as the result table and the connection form.

## 2. Ready-made libraries

If a library that meets the requirement exists, it is used. Infrastructure such as server protocols, query parsers or data format converters is not written by hand. Only a thin adaptation layer is written on top of the library.

The chosen library must meet these conditions:

1. **It must be pure JavaScript/TypeScript.** It must not require a native (C/C++) module. Native modules have to be compiled for VS Code's Electron version, require a separate package for each platform, and cause problems in Remote/WSL environments.
2. **It must be actively maintained.** It must be a project that releases regularly and deals with issues.
3. **Its license must be suitable.** It must carry a permissive license such as MIT, Apache-2.0, BSD or ISC.
4. **It must be widely used and have TypeScript types.** The types can be inside the package or under `@types/*`.

If no library meets these conditions, the situation is reported before starting to write code, and how to proceed is decided together.

Server drivers:

| Server          | Driver                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| MySQL / MariaDB | `mysql2`                                                                                                       |
| PostgreSQL      | `pg`                                                                                                           |
| MongoDB         | `mongodb` (official driver)                                                                                    |
| Redis           | `redis` (node-redis)                                                                                           |
| Kafka           | `@platformatic/kafka` (`kafkajs` has not had a release since 2023, `@confluentinc/kafka-javascript` is native) |

The table is updated as new server types are added.

## 3. Language: UI in English only

- All text the user sees is in English: webviews, command names, menus, tree view labels, notifications, error messages and setting descriptions.
- No translation is done. No `package.nls.<lang>.json` or `l10n/bundle.l10n.<lang>.json` files are added, and localization libraries such as `vue-i18n` are not used. Text is written directly in English.
- Names in the code (variables, functions, files) and code comments are in English too.

## 4. Project structure

The project is a **pnpm monorepo**, and the code is split into separate packages according to their responsibilities. Code that depends on VS Code and code that connects to servers are kept apart from each other.

### 4.1 Folder structure

```
vs-code-adapter/
├─ packages/
│  ├─ core/              # Shared types, adapter interface, webview message protocol, shared SQL layer
│  ├─ adapters/
│  │  ├─ common/         # Shared Node helpers for the adapters: SSH tunnel, TLS
│  │  ├─ mysql/          # MySQL and MariaDB (mysql2)
│  │  ├─ postgres/       # PostgreSQL (pg)
│  │  ├─ mongodb/        # MongoDB (mongodb)
│  │  ├─ redis/          # Redis (redis)
│  │  └─ kafka/          # Kafka
│  ├─ extension/         # VS Code extension: activate, commands, Tree View, webview panels
│  └─ webview-ui/        # Vue 3 + Vite UI
├─ docker/               # docker-compose servers for development and testing
├─ CLAUDE.md
├─ README.md
├─ package.json          # Root scripts: build, test, typecheck, package
├─ pnpm-workspace.yaml
└─ tsconfig.base.json    # TypeScript settings inherited by all packages
```

### 4.2 Dependency rules between packages

| Package             | May depend on                                 | Cannot use                                     |
| ------------------- | --------------------------------------------- | ---------------------------------------------- |
| `core`              | Only pure JS libraries                        | `vscode`, Node APIs, DOM                       |
| `adapters/common`   | `core`                                        | `vscode`                                       |
| `adapters/<server>` | `core`, `adapters/common`, the driver library | `vscode`, another server's adapter             |
| `extension`         | `core`, `adapters/*`                          | `webview-ui` (only loads its build output)     |
| `webview-ui`        | `core`                                        | `vscode`, Node APIs, `adapters/*`, `extension` |

- `extension` is the only package that imports the `vscode` module. This way the adapters can be tested without opening VS Code.
- `core` runs both in the extension (Node) and in the webview (browser). That is why it does not use Node or DOM APIs.
- The extension and the webview communicate only through `postMessage`. The message types are defined in `core`, and both sides use the same types.
- Logic used by more than one adapter is not copied. If it is pure logic, it is moved to `core` (e.g. splitting SQL statements); if it needs Node, it is moved to `adapters/common`.

### 4.3 Package layout

Every package follows the same skeleton:

```
<package>/
├─ src/
│  └─ index.ts       # The API the package exposes
├─ test/
├─ package.json
└─ tsconfig.json     # Inherits tsconfig.base.json
```

- Packages import each other only by package name (`@datakit/core`). Files in another package's `src/` folder are not accessed directly; whatever is needed is exposed through `index.ts`.
- Package names: `@datakit/core`, `@datakit/adapter-common`, `@datakit/adapter-<server>`, `@datakit/webview-ui`. The extension package is named `datakit`.

In the `extension` and `webview-ui` packages, `src/` is split by feature, not by file type. Type folders such as `commands/` or `panels/` are not created:

```
extension/src/
├─ extension.ts      # activate() and deactivate(); only does the registration work
├─ connections/      # Connection store, sessions, adapter registry
├─ explorer/         # Connection explorer (Tree View)
├─ webview/          # Shared webview panel infrastructure (CSP, messaging)
├─ sql/              # Commands and panels specific to MySQL/MariaDB and PostgreSQL
├─ mongodb/
├─ redis/
└─ kafka/

webview-ui/src/
├─ main.ts           # Entry point; chooses the screen to open
├─ host.ts           # Messaging with VS Code (acquireVsCodeApi wrapper)
├─ components/       # Components used on more than one screen
├─ composables/      # Shared Composition API functions (useXxx)
├─ connection/       # Connection form
├─ sql/              # Result table, table editing
├─ mongodb/
├─ redis/
├─ kafka/
└─ dev/              # Fake VS Code host for developing the UI in a browser
```

Code shared by all servers lives in the top-level folders. Code specific to a single server goes in the folder named after that server.

### 4.4 Naming

| Item             | Rule                          | Example                     |
| ---------------- | ----------------------------- | --------------------------- |
| Folder           | Lowercase, kebab-case         | `webview-ui`, `connections` |
| TypeScript file  | camelCase                     | `connectionStore.ts`        |
| Vue component    | PascalCase                    | `DataGrid.vue`              |
| Composable       | camelCase with a `use` prefix | `usePaging.ts`              |
| Unit test        | `<file>.test.ts`              | `splitStatements.test.ts`   |
| Integration test | `<topic>.integration.test.ts` | `mysql.integration.test.ts` |

### 4.5 Build and test tools

| Task               | Tool                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package management | pnpm workspaces                                                                                                                                          |
| Extension bundle   | esbuild; the output is a single file: `packages/extension/dist/extension.js`                                                                             |
| Webview build      | Vite + `@vitejs/plugin-vue`; the output is written under `packages/extension/dist/webview/`                                                              |
| Type checking      | `tsc --noEmit` in every package, `vue-tsc --noEmit` in the webview                                                                                       |
| Testing            | Vitest. Integration tests run against real servers running in Docker.                                                                                    |
| Packaging          | `vsce package --no-dependencies`. Since everything is bundled, dependencies are not added to the VSIX; vsce also does not support pnpm's symlink layout. |

### 4.6 Adding a new server type

1. Create the `packages/adapters/<server>/` package and implement the adapter interface from `core`.
2. Add the chosen driver library to the table in Section 2.
3. Add the adapter to the registry in `extension/src/connections/`.
4. If server-specific screens are needed, put them under `extension/src/<server>/` and `webview-ui/src/<server>/`.
5. Add a test server under `docker/` and write the integration test.

## 5. Additional principles

- **TypeScript** is used in `strict` mode.
- **Secrets such as passwords and tokens** are not stored as plain text. They are kept in VS Code `SecretStorage` and are not written to connection settings or to logs.
- **Large data** is processed with paging or streaming. A table with millions of rows or a Redis database with a large number of keys must not lock up the extension.
