import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const hasMeta = this.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    );
    let current = 0;
    if (hasMeta && hasMeta.n > 0) {
      const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      current = row ? Number(row.value) : 0;
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(m.version),
        );
      });
    }
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }

  insert(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.run(sql, ...cols.map((c) => normalise(row[c])));
  }

  // Nested calls join the outer transaction, so an enter-once command is all-or-nothing.
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }
}

function normalise(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
