import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { RULE_KEYS, RULE_KEY, JURISDICTION_KINDS, STATUS, REFS, type RuleKey } from '../config/ruleset.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';
import { jurisdictionOf, appliedRule, type Applied } from './rulevalue.ts';
export { jurisdictionOf, appliedRule, ruleValue, requireRule } from './rulevalue.ts';

// Rules as data (SHIFT-DESIGN-RULESET-001). A rule value has a source, a start date and a version. A person
// with the rules role proposes a value; a different person with approval authority approves it; it
// applies from its start date and the earlier value stays in the history. Each organisation belongs to a
// jurisdiction (a country, state or health system), which may sit inside another and inherit what it has
// not set itself. Nothing is assumed where no value exists.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 400) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Check a value against the shape the program applies, and return it in a clean form.
function clean(k: RuleKey, raw: unknown, prior?: unknown): unknown {
  switch (k.kind) {
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < (k.min ?? 0) || n > (k.max ?? 1e6)) throw new HttpError(400, 'VALUE', `Write ${k.label.toLowerCase()} as a whole number from ${k.min ?? 0} to ${k.max}.`);
      return n;
    }
    case 'professions': {
      const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\n|,/)).map((x) => text(x, 80)).filter(Boolean);
      if (!list.length || list.length > 30) throw new HttpError(400, 'VALUE', 'Write at least one profession, one on each line.');
      return [...new Set(list)];
    }
    case 'dates': {
      const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\n|,/)).map((x) => {
        if (typeof x === 'object' && x) return { month: Number((x as Row).month), day: Number((x as Row).day) };
        const m = /^(\d{1,2})[-/ ](\d{1,2})$/.exec(text(x, 10));
        return m ? { month: Number(m[1]), day: Number(m[2]) } : { month: 0, day: 0 };
      });
      if (!list.length || list.length > 12 || list.some((d) => !(d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31))) throw new HttpError(400, 'VALUE', 'Write each date as month-day, e.g. 6-30, one on each line.');
      return list.sort((a, b) => a.month - b.month || a.day - b.day);
    }
    case 'reasons': {
      const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\n/)).map((x) => (typeof x === 'object' && x ? { code: text((x as Row).code, 30), label: text((x as Row).label, 120) } : { code: '', label: text(x, 120) })).filter((x) => x.label);
      if (list.length < 2 || list.length > 20) throw new HttpError(400, 'VALUE', 'Write at least two reasons, one on each line.');
      const used = new Set<string>();
      const known = new Map(((prior as { code: string; label: string }[] | undefined) ?? []).map((p) => [p.label.toLowerCase(), p.code]));
      return list.map((x, i) => {
        let code = (x.code || known.get(x.label.toLowerCase()) || x.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `R${i + 1}`);
        while (used.has(code)) code += '_';
        used.add(code);
        return { code, label: x.label };
      });
    }
  }
}

function logged(store: Store, ctx: WorkContext, operation: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: null,
    operation, objectType: 'rule_setting', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [11],
  });
}

const caps = (ctx: WorkContext) => ctx.role.capabilities as string[];
const mayView = (ctx: WorkContext) => caps(ctx).includes('rules.manage') || caps(ctx).includes('rules.approve');

const shape = (r: Row, today: string, inEffect: Set<string>): Record<string, any> => {
  const status = String(r.status);
  const state = status === 'ACTIVE' ? (inEffect.has(String(r.id)) ? 'In effect' : String(r.effectiveFrom) > today ? `Starts ${r.effectiveFrom}` : 'Replaced') : STATUS[status];
  return { ...r, value: JSON.parse(String(r.value)), statusLabel: STATUS[status], state };
};

export function list(store: Store, ctx: WorkContext) {
  if (!mayView(ctx)) throw new HttpError(403, 'BLOCK', 'Your workstation does not include rules and settings.');
  const today = todayLocal();
  const orgJ = jurisdictionOf(store, ctx.organisationId);
  const jurisdictions = store.all<Row>('SELECT id, name, kind, parent_id AS parentId FROM jurisdiction ORDER BY name')
    .map((j): Record<string, any> => ({ ...j, kindLabel: JURISDICTION_KINDS[String(j.kind)] }));
  const rows = store.all<Row>(
    `SELECT s.id, s.jurisdiction_id AS jurisdictionId, s.rule_key AS ruleKey, s.value, s.version, s.status, s.effective_from AS effectiveFrom, s.category,
            s.source_ref AS sourceRef, s.source_url AS sourceUrl, s.note, pb.display_name AS proposedBy, s.proposed_by AS proposedById, s.proposed_at AS proposedAt,
            db.display_name AS decidedBy, s.decided_at AS decidedAt, s.decision_note AS decisionNote
       FROM rule_setting s LEFT JOIN workforce_person pb ON pb.id = s.proposed_by LEFT JOIN workforce_person db ON db.id = s.decided_by
      ORDER BY s.rule_key, s.jurisdiction_id, s.version DESC`);
  const effective = new Map<string, Applied | undefined>(RULE_KEYS.map((k) => [k.key, appliedRule(store, ctx.organisationId, k.key, today)]));
  const inEffect = new Set([...effective.values()].filter(Boolean).map((a) => a!.id));
  const rules = RULE_KEYS.map((k): Record<string, any> => {
    const a = effective.get(k.key);
    const mine = rows.filter((r) => r.ruleKey === k.key).map((r) => shape(r, today, inEffect));
    return {
      ...k, current: a ? { value: a.value, version: a.version, effectiveFrom: a.effectiveFrom, jurisdiction: jurisdictions.find((j) => j.id === a.jurisdictionId)?.name ?? a.jurisdictionId, sourceRef: a.sourceRef, sourceUrl: a.sourceUrl, category: a.category, note: a.note } : null,
      pending: mine.filter((r) => r.status === 'PROPOSED'), history: mine.filter((r) => r.status !== 'PROPOSED'),
    };
  });
  return {
    jurisdictions, organisation: { name: ctx.organisationName, jurisdictionId: orgJ, jurisdiction: jurisdictions.find((j) => j.id === orgJ)?.name ?? orgJ },
    rules, kinds: JURISDICTION_KINDS, canPropose: caps(ctx).includes('rules.manage'), canApprove: caps(ctx).includes('rules.approve'), me: ctx.workerId,
    toDo: caps(ctx).includes('rules.approve') ? rules.reduce((n, r) => n + r.pending.filter((p: Row) => p.proposedById !== ctx.workerId).length, 0) : 0,
  };
}

export const toDo = (store: Store, ctx: WorkContext) => (mayView(ctx) ? list(store, ctx).toDo : 0);

interface Body { id?: string; jurisdictionId?: string; key?: string; value?: unknown; effectiveFrom?: string; sourceRef?: string; sourceUrl?: string; note?: string; name?: string; kind?: string; parentId?: string }

export function act(store: Store, ctx: WorkContext, action: string, b: Body) {
  const approving = ['approve', 'reject', 'assign', 'jurisdiction'].includes(action);
  enforce(store, ctx, { op: approving ? 'RULES_APPROVE' : 'RULES_PROPOSE' }, null);
  store.tx(() => {
    switch (action) {
      case 'propose': {
        const k = RULE_KEY.get(text(b.key, 80));
        if (!k) throw new HttpError(400, 'KEY', 'That is not a rule SHIFT knows how to apply.');
        const j = store.get<Row>('SELECT id, name FROM jurisdiction WHERE id = ?', text(b.jurisdictionId, 40));
        if (!j) throw new HttpError(400, 'JURISDICTION', 'Choose the country, state or health system this is for.');
        const value = clean(k, b.value, appliedRule(store, ctx.organisationId, k.key)?.value);
        const from = text(b.effectiveFrom, 10);
        if (!DATE.test(from) || from < todayLocal()) throw new HttpError(400, 'DATE', 'Choose the date it starts. It cannot start in the past, so what already happened stays under the rule that applied.');
        const sourceRef = text(b.sourceRef, 160);
        if (sourceRef.length < 3) throw new HttpError(400, 'SOURCE', 'Say where it comes from: the Act or regulation and section, the standard, or the organisation\'s policy.');
        const url = text(b.sourceUrl, 300);
        if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new HttpError(400, 'URL', 'The link must start with https:// and be a public page.');
        if (k.category !== 'ORGANISATIONAL CONFIGURATION' && !url) throw new HttpError(400, 'URL', 'A rule that comes from law, a code or a standard needs a link to the public official page it is taken from.');
        if (store.get("SELECT 1 FROM rule_setting WHERE jurisdiction_id = ? AND rule_key = ? AND status = 'PROPOSED'", j.id, k.key)) throw new HttpError(409, 'ALREADY', 'A change to this rule is already waiting for approval.');
        const version = (store.get<{ v: number }>('SELECT max(version) AS v FROM rule_setting WHERE jurisdiction_id = ? AND rule_key = ?', j.id, k.key)?.v ?? 0) + 1;
        const id = newId();
        store.insert('rule_setting', {
          id, jurisdiction_id: j.id, rule_key: k.key, value: JSON.stringify(value), version, status: 'PROPOSED', effective_from: from, category: k.category,
          source_ref: sourceRef, source_url: url || null, note: text(b.note) || null, proposed_by: ctx.workerId, proposed_at: now(),
        });
        logged(store, ctx, 'RULE_PROPOSE', id, `${k.label} for ${j.name}, from ${from}`);
        break;
      }
      case 'approve':
      case 'reject': {
        const r = store.get<Row>("SELECT id, rule_key, jurisdiction_id, proposed_by, effective_from FROM rule_setting WHERE id = ? AND status = 'PROPOSED'", text(b.id, 64));
        if (!r) throw new HttpError(404, 'RULE', 'That change is not waiting for approval.');
        if (r.proposed_by === ctx.workerId) throw new HttpError(409, 'SAME_PERSON', 'Someone else has to approve a change you proposed.');
        const note = text(b.note);
        if (action === 'reject' && note.length < 5) throw new HttpError(400, 'NOTE', 'Say why it is not approved.');
        let from = String(r.effective_from);
        if (action === 'approve' && from < todayLocal()) from = todayLocal();
        store.run('UPDATE rule_setting SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, effective_from = ? WHERE id = ?', action === 'approve' ? 'ACTIVE' : 'REJECTED', ctx.workerId, now(), note || null, from, r.id);
        logged(store, ctx, action === 'approve' ? 'RULE_APPROVE' : 'RULE_REJECT', String(r.id), `${r.rule_key} for ${r.jurisdiction_id}${action === 'approve' ? `, from ${from}` : ''}`);
        break;
      }
      case 'jurisdiction': {
        const name = text(b.name, 80);
        const kind = text(b.kind, 20);
        if (name.length < 2) throw new HttpError(400, 'NAME', 'Write the name of the country, state or health system.');
        if (!JURISDICTION_KINDS[kind]) throw new HttpError(400, 'KIND', 'Choose whether it is a country, a state or region, or a health system.');
        const parent = text(b.parentId, 40) || null;
        if (parent && !store.get('SELECT 1 FROM jurisdiction WHERE id = ?', parent)) throw new HttpError(400, 'PARENT', 'Choose a country or state from the list.');
        if (store.get('SELECT 1 FROM jurisdiction WHERE lower(name) = lower(?)', name)) throw new HttpError(409, 'ALREADY', 'That one is already in the list.');
        const id = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || newId().slice(0, 8);
        store.insert('jurisdiction', { id, name, kind, parent_id: parent });
        logged(store, ctx, 'JURISDICTION_ADD', id, `${name} (${kind})`);
        break;
      }
      case 'assign': {
        const j = store.get<Row>('SELECT id, name FROM jurisdiction WHERE id = ?', text(b.jurisdictionId, 40));
        if (!j) throw new HttpError(400, 'JURISDICTION', 'Choose a country, state or health system from the list.');
        if (jurisdictionOf(store, ctx.organisationId) === j.id) throw new HttpError(409, 'ALREADY', 'The organisation is already under that one.');
        if (text(b.note).length < 5) throw new HttpError(400, 'NOTE', 'Say why the organisation is moving.');
        store.run('UPDATE organisation SET jurisdiction_id = ? WHERE id = ?', j.id, ctx.organisationId);
        logged(store, ctx, 'ORG_JURISDICTION', ctx.organisationId, `${ctx.organisationName} now under ${j.name}: ${text(b.note)}`);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return list(store, ctx);
}
