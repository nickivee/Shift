import type { Store } from '../db/database.ts';
import { newId, now, sha256 } from '../lib/util.ts';

export type AuditSpace = 'AUTH' | 'PERSONAL' | 'WORK' | 'SYSTEM';
export type AuditOutcome = 'COMMITTED' | 'VIEWED' | 'BLOCKED' | 'HELD' | 'FAILED';

export interface AuditEntry {
  actorId?: string | null;
  sessionId?: string | null;
  workContextId?: string | null;
  space: AuditSpace;
  subjectPersonId?: string | null;
  operation: string;
  objectType?: string | null;
  objectId?: string | null;
  purpose?: string | null;
  decision?: string | null;
  outcome: AuditOutcome;
  reason?: string | null;
  ruleRefs?: string[];
  engines?: number[];
  transactionId?: string | null;
}

const GENESIS = '0'.repeat(64);

// Append-only, hash-chained audit (Package 10 §12). Each entry commits to the one before,
// so any later alteration of history is detectable by verifyChain().
export function audit(store: Store, e: AuditEntry): string {
  const prev = store.get<{ hash: string }>('SELECT hash FROM audit_event ORDER BY seq DESC LIMIT 1');
  const row = {
    id: newId(),
    at: now(),
    actor_id: e.actorId ?? null,
    session_id: e.sessionId ?? null,
    work_context_id: e.workContextId ?? null,
    space: e.space,
    subject_person_id: e.subjectPersonId ?? null,
    operation: e.operation,
    object_type: e.objectType ?? null,
    object_id: e.objectId ?? null,
    purpose: e.purpose ?? null,
    decision: e.decision ?? null,
    outcome: e.outcome,
    reason: e.reason ?? null,
    rule_refs: e.ruleRefs?.length ? e.ruleRefs.join(';') : null,
    engines: e.engines?.length ? e.engines.join(',') : null,
    transaction_id: e.transactionId ?? null,
    prev_hash: prev?.hash ?? GENESIS,
  };
  store.insert('audit_event', { ...row, hash: hashOf(row) });
  return row.id;
}

function hashOf(row: Record<string, unknown>): string {
  const { hash: _ignored, seq: _seq, ...rest } = row as Record<string, unknown>;
  const keys = Object.keys(rest).sort();
  return sha256(JSON.stringify(keys.map((k) => [k, rest[k] ?? null])));
}

export function verifyChain(store: Store): { ok: boolean; entries: number; brokenAt?: number } {
  const rows = store.all<Record<string, unknown>>('SELECT * FROM audit_event ORDER BY seq');
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || hashOf(r) !== r.hash) {
      return { ok: false, entries: rows.length, brokenAt: Number(r.seq) };
    }
    prev = String(r.hash);
  }
  return { ok: true, entries: rows.length };
}
