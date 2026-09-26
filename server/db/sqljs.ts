import type { Database } from 'sql.js';
import { Store, type Driver } from './database.ts';

// sql.js runs SQLite compiled to WebAssembly, synchronously, inside the browser.
export function openSqlJsStore(db: Database): Store {
  const rows = (sql: string, params: unknown[], limit: number): Record<string, unknown>[] => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params as never);
      const out: Record<string, unknown>[] = [];
      while (out.length < limit && stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  };
  const driver: Driver = {
    exec: (sql) => db.exec(sql),
    get: (sql, params) => rows(sql, params, 1)[0],
    all: (sql, params) => rows(sql, params, Infinity),
    run: (sql, params) => {
      db.run(sql, params as never);
      return db.getRowsModified();
    },
  };
  return new Store(driver);
}
