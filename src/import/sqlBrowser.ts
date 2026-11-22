import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { SqlJsStatic } from 'sql.js';

let sql: Promise<SqlJsStatic> | null = null;

/** Lädt sql.js (SQLite als WebAssembly) einmalig im Browser. */
export function loadSql(): Promise<SqlJsStatic> {
  sql ??= initSqlJs({ locateFile: () => wasmUrl } as unknown as Parameters<typeof initSqlJs>[0]);
  return sql;
}
