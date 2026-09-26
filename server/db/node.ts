import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store, type Driver } from './database.ts';

export function openNodeStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const driver: Driver = {
    exec: (sql) => db.exec(sql),
    get: (sql, params) => db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined,
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params) => Number(db.prepare(sql).run(...(params as never[])).changes),
  };
  return new Store(driver);
}
