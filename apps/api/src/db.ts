import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/**
 * Bundler nie zna jeszcze `node:sqlite` (esbuild ścina prefiks `node:`),
 * więc bierzemy moduł wbudowany przez proces. Node 24+ ma go bez flag.
 */
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncType;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reservations (
    id            TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL,
    seat_id       TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    email         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'purchased', 'expired')),
    code          TEXT UNIQUE,
    purchased_at  TEXT
  );

  -- Jedno żywe (aktywne albo kupione) miejsce na kurs. Baza pilnuje tego sama.
  CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_live_seat
    ON reservations(event_id, seat_id)
    WHERE status IN ('active', 'purchased');

  CREATE INDEX IF NOT EXISTS reservations_event_idx ON reservations(event_id);

  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    task         TEXT NOT NULL,
    input        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    visible_at   INTEGER NOT NULL,
    total_tried  INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    has_error    INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
  );

  CREATE INDEX IF NOT EXISTS jobs_ready_idx
    ON jobs(completed_at, has_error, visible_at);
`;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/**
 * SQLite w Node jest synchroniczny. BEGIN IMMEDIATE bierzemy od razu,
 * żeby dwa procesy nie weszły w tę samą rezerwację.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback mógł już się wydarzyć; ważniejszy jest pierwotny błąd.
    }
    throw error;
  }
}
