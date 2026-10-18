import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Inputs (biometrics.db, watch.json, archive/) come from SP_ANALYSIS_DATA when
 * set — run.sh points it at the /biometrics mount — and from the in-repo data/
 * folder otherwise. Outputs always go to out/, so the data mount can be read-only.
 */
export const DATA = resolve(process.env.SP_ANALYSIS_DATA || 'analysis/watch-deviation/data')
export const OUT = resolve('analysis/watch-deviation/out')

/**
 * Open a pulled pod snapshot read-only. Snapshots keep the pod's WAL journal
 * mode, and SQLite cannot open a WAL database read-only from a read-only
 * mount (it needs to create -shm beside it). In that case work from a temp
 * copy switched to a rollback journal.
 */
export function openSnapshot(path: string): Database.Database {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    db.prepare('select 1 from sqlite_master limit 1').get()
    return db
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_CANTOPEN') throw error
    const copy = join(mkdtempSync(join(tmpdir(), 'sp-snapshot-')), 'biometrics.db')
    copyFileSync(path, copy)
    new Database(copy).pragma('journal_mode = DELETE')
    return new Database(copy, { readonly: true, fileMustExist: true })
  }
}
