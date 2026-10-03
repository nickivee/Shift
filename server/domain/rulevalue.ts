import type { Store } from '../db/database.ts';
import { RULE_KEY } from '../config/ruleset.ts';
import { todayLocal, HttpError } from '../lib/util.ts';

// Reading a rule: the value in effect on a date for an organisation (see ruleset.ts for how values are set).
type Row = Record<string, string | number | null>;

const chain = (store: Store, jurisdictionId: string): string[] => {
  const out: string[] = [];
  let id: string | null = jurisdictionId;
  while (id && !out.includes(id)) {
    out.push(id);
    id = store.get<{ parent_id: string | null }>('SELECT parent_id FROM jurisdiction WHERE id = ?', id)?.parent_id ?? null;
  }
  return out;
};
export const jurisdictionOf = (store: Store, organisationId: string) =>
  store.get<{ jurisdiction_id: string }>('SELECT jurisdiction_id FROM organisation WHERE id = ?', organisationId)?.jurisdiction_id ?? 'NZ';

export interface Applied { value: unknown; id: string; version: number; effectiveFrom: string; jurisdictionId: string; sourceRef: string; sourceUrl: string | null; category: string; note: string | null }

// The value in effect on a date for an organisation, or undefined when its jurisdiction has set none.
export function appliedRule(store: Store, organisationId: string, key: string, asAt = todayLocal()): Applied | undefined {
  for (const j of chain(store, jurisdictionOf(store, organisationId))) {
    const r = store.get<Row>(
      `SELECT id, value, version, effective_from AS effectiveFrom, jurisdiction_id AS jurisdictionId, source_ref AS sourceRef, source_url AS sourceUrl, category, note
         FROM rule_setting WHERE jurisdiction_id = ? AND rule_key = ? AND status = 'ACTIVE' AND effective_from <= ? ORDER BY effective_from DESC, version DESC LIMIT 1`, j, key, asAt);
    if (r) return { ...(r as unknown as Applied), value: JSON.parse(String(r.value)) };
  }
  return undefined;
}

export function ruleValue<T>(store: Store, organisationId: string, key: string, asAt?: string): T | undefined {
  return appliedRule(store, organisationId, key, asAt)?.value as T | undefined;
}

// For a screen that cannot work without the rule: say plainly that it has not been set.
export function requireRule<T>(store: Store, organisationId: string, key: string, asAt?: string): T {
  const v = ruleValue<T>(store, organisationId, key, asAt);
  if (v === undefined) throw new HttpError(409, 'RULE_NOT_SET', `This organisation has not set the rule "${RULE_KEY.get(key)?.label ?? key}" for its jurisdiction yet, so this cannot be done here.`);
  return v;
}

