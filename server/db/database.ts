import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, unknown>;

// The SQLite engine underneath: node:sqlite on the server (node.ts), sql.js in the
// browser (sqljs.ts). Everything above this interface is the same code on both.
export interface Driver {
  exec(sql: string): void;
  get(sql: string, params: unknown[]): Row | undefined;
  all(sql: string, params: unknown[]): Row[];
  run(sql: string, params: unknown[]): number;
}

export class Store {
  private readonly driver: Driver;
  private depth = 0;

  constructor(driver: Driver) {
    this.driver = driver;
    this.driver.exec('PRAGMA foreign_keys = ON;');
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
        this.driver.exec(m.sql);
        this.run(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(m.version),
        );
      });
    }
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.driver.get(sql, params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.driver.all(sql, params) as T[];
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    return { changes: this.driver.run(sql, params) };
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
    this.driver.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.driver.exec('COMMIT');
      return out;
    } catch (err) {
      this.driver.exec('ROLLBACK');
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
