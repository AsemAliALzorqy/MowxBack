# SQLite schema and migrations

- `schema.sql`: complete readable snapshot of the current schema (v1).
- `migrations/001_initial.sql`: migration applied to a new database.
- `tests/test_database.py`: runs the migration using Python's built-in SQLite binding and checks constraints, foreign keys, views, aggregates, and soft deletion.
- `tests/test_money.js`: tests deterministic decimal-to-integer conversions.
- `tests/test_repository_node.js`: exercises Repository, report, JSON import/export, audit history, and a file-backed close/reopen test using Node `node:sqlite`.
- `tests/test_bridge_contract.js`: checks the 27 named IPC channels and Electron renderer security contract.

The app applies numbered migrations from `src/database/db.js`. Once a migration has been applied, its SHA-256 checksum is recorded in `schema_migrations`; do not edit an applied migration. Add the next change as a new file, e.g. `002_add_report_index.sql`, and update `schema.sql` to remain the complete schema snapshot.

Current schema version: **1** (`PRAGMA user_version = 1`). The initial migration adds only default expense categories and currency settings, not demo financial rows.

The desktop runtime uses `better-sqlite3` in Electron Main Process. The Node Repository tests use Node's built-in SQLite driver as a test adapter; this does not replace the Windows/Electron native-module test. See `docs/phase-2-integration-report-ar.md`.
