import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { DOMAINS, DOMAIN_BY_ID } from '../config/usual.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Baseline / usual state (Shared Lifecycle Object 262):
//   usual state → current difference → action → outcome.
// How someone usually is, in words and, for some measurements, as a usual range, with who said
// so. Anyone caring for them can record it and say when something is different now; a nurse,
// doctor or physio records what is being done and how it ended: back to usual, or a new usual,
// which replaces the old one and keeps it. A latest reading outside their usual range is shown
// beside it. Usual ranges never change early warning scores.

type Row = Record<string, string | number | null>;
type Cap = 'usual.record' | 'usual.act';
const SOURCES: Record<string, string> = {
  PERSON: 'The person themselves', WHANAU: 'Whānau or support person', PRIOR_RECORD: 'An earlier record or letter', STAFF: 'Staff who know them well',
};
const NAMED = ['WHANAU', 'PRIOR_RECORD'];
const USUAL_STATES: Record<string, string> = { CURRENT: 'In use', SUPERSEDED: 'Replaced', ENTERED_IN_ERROR: 'Entered in error' };
const DIFF_STATES: Record<string, string> = { NOTICED: 'Needs action', ACTING: 'Being acted on', CLOSED: 'Closed' };
const OUTCOMES: Record<string, string> = { BACK_TO_USUAL: 'Back to their usual', NEW_USUAL: 'This is their new usual', ELSEWHERE: 'Now followed up elsewhere in their record' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005'];
const RECENT_DAYS = 7;

const USUAL = `
  SELECT u.id, u.person_id AS personId, u.domain, u.statement, u.low, u.high, u.source, u.source_name AS sourceName,
         rb.display_name AS recordedBy, u.recorded_at AS recordedAt, u.state, u.supersedes, u.error_reason AS errorReason
    FROM usual_state u
    JOIN workforce_person rb ON rb.id = u.recorded_by`;

const DIFF = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.domain, d.usual_text AS usualText, d.now_text AS nowText, nb.display_name AS noticedBy, d.noticed_at AS noticedAt, d.state,
         d.action, ab.display_name AS actedBy, d.acted_at AS actedAt, d.outcome, d.outcome_note AS outcomeNote,
         cb.display_name AS closedBy, d.closed_at AS closedAt
    FROM usual_difference d
    JOIN person p ON p.id = d.person_id
    JOIN workforce_person nb ON nb.id = d.noticed_by
    LEFT JOIN workforce_person ab ON ab.id = d.acted_by
    LEFT JOIN workforce_person cb ON cb.id = d.closed_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'USUAL', personId, cap }).decision === 'ALLOW';
const options = () => ({ domains: DOMAINS, sources: SOURCES, outcomes: OUTCOMES });
const label = (domain: unknown) => DOMAIN_BY_ID.get(String(domain))?.label ?? String(domain);

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, objectType: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

// "88 to 92%. COPD; lives in this range on room air"
function usualText(r: Row) {
  const m = DOMAIN_BY_ID.get(String(r.domain))?.measure;
  const range = m && r.low !== null && r.high !== null ? `${r.low} to ${r.high}${m.unit === '%' ? '%' : ` ${m.unit}`}` : '';
  return [range, r.statement ? String(r.statement) : ''].filter(Boolean).join('. ');
}

function shapeUsual(store: Store, r: Row, canRecord: boolean) {
  return {
    ...r, state: String(r.state), domain: String(r.domain), label: label(r.domain), text: usualText(r), stateLabel: USUAL_STATES[String(r.state)],
    sourceLabel: r.source ? SOURCES[String(r.source)] : null, actions: canRecord && r.state === 'CURRENT' ? ['update', 'error'] : [],
    history: history(store, 'usual', String(r.id)),
  };
}

function shapeDiff(store: Store, r: Row, canRecord: boolean, canAct: boolean) {
  const actions: string[] = [];
  if (canAct && r.state === 'NOTICED') actions.push('act', 'close');
  if (canAct && r.state === 'ACTING') actions.push('close');
  return {
    ...r, state: String(r.state), domain: String(r.domain), label: label(r.domain), stateLabel: DIFF_STATES[String(r.state)], outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] : null,
    actions, history: history(store, 'difference', String(r.id)),
  };
}

const currentUsual = (store: Store, personId: string, domain: string) =>
  store.get<Row>(`${USUAL} WHERE u.person_id = ? AND u.domain = ? AND u.state = 'CURRENT'`, personId, domain);

// Latest readings from the last week that fall outside their usual range, where no one has said so yet.
function outside(store: Store, personId: string) {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600_000).toISOString();
  const obs = store.get<{ fields: string; at: string }>(
    "SELECT fields_json AS fields, effective_at AS at FROM clinical_event WHERE person_id = ? AND category = 'OBS' AND state = 'CURRENT' AND effective_at >= ? ORDER BY effective_at DESC LIMIT 1",
    personId, since);
  if (!obs) return [];
  const fields = JSON.parse(obs.fields) as Record<string, unknown>;
  const open = new Set(store.all<{ domain: string }>("SELECT domain FROM usual_difference WHERE person_id = ? AND state != 'CLOSED'", personId).map((d) => d.domain));
  const found = [];
  for (const d of DOMAINS) {
    if (!d.measure || open.has(d.id)) continue;
    const u = currentUsual(store, personId, d.id);
    if (!u || u.low === null || u.high === null) continue;
    const raw = fields[d.measure.field];
    const value = d.measure.field === 'bp' ? Number(String(raw ?? '').split('/')[0]) : Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(value)) continue;
    if (value < Number(u.low) || value > Number(u.high)) {
      found.push({ domain: d.id, label: d.label, value, unit: d.measure.unit, usual: usualText(u), at: obs.at, direction: value < Number(u.low) ? 'below' : 'above' });
    }
  }
  return found;
}

export function record(store: Store, ctx: WorkContext, personId: string,
  b: { domain?: string; statement?: string; low?: string | number; high?: string | number; source?: string; sourceName?: string }, closing?: string) {
  enforce(store, ctx, { op: 'USUAL', personId, cap: 'usual.record' }, personId);
  const d = DOMAIN_BY_ID.get(String(b.domain));
  if (!d) throw new HttpError(400, 'DOMAIN_REQUIRED', 'Choose what this is about.');
  const statement = text(b.statement, 500) || null;
  let low: number | null = null;
  let high: number | null = null;
  if (d.measure && (String(b.low ?? '') !== '' || String(b.high ?? '') !== '')) {
    low = Number(b.low);
    high = Number(b.high);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < d.measure.min || high > d.measure.max || low > high) {
      throw new HttpError(400, 'RANGE_INVALID', `Give their usual ${d.label.toLowerCase()} as a range from ${d.measure.min} to ${d.measure.max}, lowest first.`);
    }
  }
  if (!statement && low === null) throw new HttpError(400, 'USUAL_REQUIRED', d.measure ? 'Give their usual range, or describe what is usual for them.' : 'Describe what is usual for them.');
  if (statement && statement.length < 3) throw new HttpError(400, 'USUAL_REQUIRED', 'Describe what is usual for them.');
  const source = SOURCES[String(b.source)] ? String(b.source) : '';
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose where you learned what is usual for them.');
  const sourceName = text(b.sourceName, 200) || null;
  if (NAMED.includes(source) && (sourceName ?? '').length < 3) {
    throw new HttpError(400, 'SOURCE_NAME_REQUIRED', source === 'WHANAU' ? 'Write who told you, and how they are related.' : 'Write which record or letter, and its date.');
  }
  const prior = currentUsual(store, personId, d.id);
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('usual_state', {
      id, person_id: personId, service_id: ctx.serviceId, domain: d.id, statement, low, high, source, source_name: sourceName,
      recorded_by: ctx.workerId, recorded_at: now(), state: 'CURRENT', supersedes: prior ? String(prior.id) : null,
    });
    recordInitial(store, 'usual', id, 'CURRENT', who, closing ?? `Usual ${d.label.toLowerCase()} recorded`);
    if (prior) transition(store, 'usual', String(prior.id), 'SUPERSEDED', who, closing ?? 'Updated');
    logged(store, ctx, 'USUAL_RECORD', personId, 'usual_state', id, `${d.label}: ${usualText({ domain: d.id, statement, low, high })}`);
  });
  return id;
}

export function recordUsual(store: Store, ctx: WorkContext, personId: string, b: Parameters<typeof record>[3]) {
  record(store, ctx, personId, b);
  return forPerson(store, ctx, personId);
}

export function markError(store: Store, ctx: WorkContext, id: string, b: { reason?: string }) {
  const r = store.get<Row>(`${USUAL} WHERE u.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'USUAL', personId, cap: 'usual.record' }, personId);
  if (r.state !== 'CURRENT') throw new HttpError(409, 'WRONG_STATE', 'Only what is in use can be marked as entered in error.');
  const reason = text(b.reason, 500);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write what was wrong, e.g. "recorded on the wrong person".');
  store.tx(() => {
    transition(store, 'usual', id, 'ENTERED_IN_ERROR', { actorId: ctx.workerId, workContextId: ctx.id }, reason);
    store.run('UPDATE usual_state SET error_reason = ? WHERE id = ?', reason, id);
    logged(store, ctx, 'USUAL_ERROR', personId, 'usual_state', id, reason);
  });
  return forPerson(store, ctx, personId);
}

// Anyone caring for them can say something is different from usual.
export function notice(store: Store, ctx: WorkContext, personId: string, b: { domain?: string; nowText?: string }) {
  enforce(store, ctx, { op: 'USUAL', personId, cap: 'usual.record' }, personId);
  const d = DOMAIN_BY_ID.get(String(b.domain));
  if (!d) throw new HttpError(400, 'DOMAIN_REQUIRED', 'Choose what is different.');
  const nowText = text(b.nowText, 1000);
  if (nowText.length < 5) throw new HttpError(400, 'NOW_REQUIRED', 'Write how they are now, e.g. "quiet, staying in his room, not joking with staff".');
  if (store.get("SELECT 1 FROM usual_difference WHERE person_id = ? AND domain = ? AND state != 'CLOSED'", personId, d.id)) {
    throw new HttpError(409, 'ALREADY_OPEN', `A difference in ${d.label.toLowerCase()} is already open for them. Add to that one.`);
  }
  const u = currentUsual(store, personId, d.id);
  const id = newId();
  store.tx(() => {
    store.insert('usual_difference', {
      id, person_id: personId, service_id: ctx.serviceId, domain: d.id, usual_id: u ? String(u.id) : null, usual_text: u ? usualText(u) : null,
      now_text: nowText, noticed_by: ctx.workerId, noticed_at: now(), state: 'NOTICED',
    });
    recordInitial(store, 'difference', id, 'NOTICED', { actorId: ctx.workerId, workContextId: ctx.id }, `${d.label}: ${nowText.slice(0, 200)}`);
    logged(store, ctx, 'USUAL_DIFFERENCE', personId, 'usual_difference', id, `${d.label}: ${nowText.slice(0, 200)}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { action?: string; outcome?: string; note?: string; statement?: string; low?: string | number; high?: string | number }) {
  const r = store.get<Row>(`${DIFF} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'USUAL', personId, cap: 'usual.act' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  switch (action) {
    case 'act': {
      if (r.state !== 'NOTICED') throw new HttpError(409, 'WRONG_STATE', 'Action has already been recorded or it is closed.');
      const done = text(b.action, 1000);
      if (done.length < 5) throw new HttpError(400, 'ACTION_REQUIRED', 'Write what is being done, e.g. "GP asked to review today; urine sent".');
      store.tx(() => {
        transition(store, 'difference', id, 'ACTING', who, done);
        store.run('UPDATE usual_difference SET action = ?, acted_by = ?, acted_at = ? WHERE id = ?', done, ctx.workerId, at, id);
        logged(store, ctx, 'USUAL_DIFFERENCE_ACT', personId, 'usual_difference', id, done);
      });
      break;
    }
    case 'close': {
      if (r.state === 'CLOSED') throw new HttpError(409, 'WRONG_STATE', 'This is already closed.');
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose how it ended.');
      if (r.state === 'NOTICED' && outcome !== 'BACK_TO_USUAL') throw new HttpError(400, 'ACTION_FIRST', 'Record what is being done before closing it this way.');
      const note = text(b.note, 1000);
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how it ended, e.g. "Back to his usual self after antibiotics".');
      store.tx(() => {
        let newUsual: string | null = null;
        if (outcome === 'NEW_USUAL') {
          newUsual = record(store, ctx, personId, { domain: String(r.domain), statement: b.statement, low: b.low, high: b.high, source: 'STAFF', sourceName: `After a change noticed ${String(r.noticedAt).slice(0, 10)}` }, 'New usual after a change');
        }
        transition(store, 'difference', id, 'CLOSED', who, `${OUTCOMES[outcome]}: ${note}`);
        store.run('UPDATE usual_difference SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ?, new_usual_id = ? WHERE id = ?', outcome, note, ctx.workerId, at, newUsual, id);
        logged(store, ctx, `USUAL_DIFFERENCE_${outcome}`, personId, 'usual_difference', id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Usual state view: what is usual for each area, what is different now, and how earlier differences ended.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'usual.record');
  const canAct = may(store, ctx, personId, 'usual.act');
  const usuals = store.all<Row>(`${USUAL} WHERE u.person_id = ? ORDER BY u.recorded_at DESC`, personId).map((r) => shapeUsual(store, r, canRecord));
  const diffs = store.all<Row>(`${DIFF} WHERE d.person_id = ? ORDER BY d.noticed_at DESC`, personId).map((r) => shapeDiff(store, r, canRecord, canAct));
  const open = diffs.filter((d) => d.state !== 'CLOSED');
  const areas = DOMAINS.map((d) => ({
    domain: d.id, label: d.label, measure: d.measure ?? null,
    usual: usuals.find((u) => u.domain === d.id && u.state === 'CURRENT') ?? null,
    different: open.find((x) => x.domain === d.id) ?? null,
  }));
  return {
    areas, outside: outside(store, personId), open, closed: diffs.filter((d) => d.state === 'CLOSED'),
    earlier: usuals.filter((u) => u.state !== 'CURRENT'), canRecord, canAct, seesFunction: ctx.role.views.includes('function'), options: options(),
  };
}

// For the record header: what is different from usual now.
export function current(store: Store, personId: string) {
  const open = store.all<Row>(`${DIFF} WHERE d.person_id = ? AND d.state != 'CLOSED' ORDER BY d.noticed_at`, personId)
    .map((d) => `${label(d.domain)}: ${d.nowText}`);
  const out = outside(store, personId).map((o) => `${o.label} ${o.value}${o.unit === '%' ? '%' : ` ${o.unit}`}, usually ${o.usual}`);
  const items = [...open, ...out];
  return items.length ? items : null;
}

// Home → Different from usual: differences no one has acted on, readings outside usual, then those being acted on.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('usual.act')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include acting on changes from usual`);
  const people = store.all<{ id: string }>(
    "SELECT person_id AS id FROM encounter WHERE service_id = ? AND state = 'ACTIVE' UNION SELECT person_id AS id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL",
    ctx.serviceId, ctx.serviceId).map((p) => p.id);
  const inService = `d.person_id IN (${people.map(() => '?').join(',') || "''"})`;
  const rows = store.all<Row>(`${DIFF} WHERE ${inService} AND d.state != 'CLOSED' ORDER BY d.noticed_at`, ...people).map((r) => shapeDiff(store, r, true, true));
  const readings = people.flatMap((pid) => {
    const found = outside(store, pid);
    if (!found.length) return [];
    const p = store.get<Row>(`SELECT p.given_name || ' ' || p.family_name AS patient,
      (SELECT location FROM encounter e WHERE e.person_id = p.id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location FROM person p WHERE p.id = ?`, pid);
    return found.map((o) => ({ ...o, personId: pid, patient: p?.patient, location: p?.location }));
  });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_USUAL_DIFFERENCES', decision: 'ALLOW', outcome: 'VIEWED' });
  return { noticed: rows.filter((r) => r.state === 'NOTICED'), readings, acting: rows.filter((r) => r.state === 'ACTING'), options: options() };
}
