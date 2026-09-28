import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { CATEGORIES, DECIDED_BY, RISKS, REOFFER } from '../config/declined.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Refusal / Declined Care (Shared Lifecycle Object 296):
//   care/intervention offered → relevant information/decision process → declined/refused → reason
//   where offered/provided → immediate clinical implications → alternative plan → escalation where
//   required → reassessment/re-offer where appropriate.
// A refusal is the person's right. SHIFT records what was offered, what they were told, who decided,
// their reason if they gave one, what it means clinically, and the plan instead. A high-risk refusal
// must be escalated to a senior clinician, who responds with a plan. The care can be offered again
// until it is accepted or no longer needed.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  DECLINED: 'Declined', ESCALATED: 'Escalated: waiting for a senior response', ACCEPTED: 'Accepted when offered again', CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const OPEN = ['DECLINED', 'ESCALATED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-DECLINE-001'];

const Q = `
  SELECT d.id, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.service_id AS serviceId, s.name AS service, d.category, d.offered, d.information, d.decided_by AS decidedBy, d.representative, d.capacity_concern AS capacityConcern,
         d.reason, d.implications, d.risk, d.plan, d.reoffer_by AS reofferBy, d.offered_at AS offeredAt, d.state,
         rb.display_name AS recordedBy, d.recorded_by AS recordedById, d.recorded_at AS recordedAt,
         d.escalated_to AS escalatedTo, d.escalated_at AS escalatedAt, d.response, sb.display_name AS respondedBy, d.responded_at AS respondedAt,
         eb.display_name AS endedBy, d.ended_at AS endedAt, d.ended_note AS endedNote
    FROM declined_care d
    JOIN person p ON p.id = d.person_id
    JOIN service s ON s.id = d.service_id
    JOIN workforce_person rb ON rb.id = d.recorded_by
    LEFT JOIN workforce_person sb ON sb.id = d.responded_by
    LEFT JOIN workforce_person eb ON eb.id = d.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'DECLINED_CARE', personId }).decision === 'ALLOW';
const senior = (ctx: WorkContext) => ctx.role.capabilities.includes('declined.respond');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'declined_care', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const log = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('declined_log', { id: newId(), declined_id: id, kind, body, by_id: ctx.workerId, at: now() });
const LOG_LABELS: Record<string, string> = {
  DECLINED: 'Declined', ESCALATED: 'Escalated', RESPONSE: 'Senior response', PLAN: 'Plan changed', REOFFERED: 'Offered again', ACCEPTED: 'Accepted',
  CLOSED: 'Closed', ERROR: 'Entered in error',
};

// Open refusals for the record's header: what was declined and how risky.
export function current(store: Store, personId: string) {
  return store.all<Row>("SELECT offered, risk, state FROM declined_care WHERE person_id = ? AND state IN ('DECLINED', 'ESCALATED') ORDER BY CASE risk WHEN 'HIGH' THEN 0 WHEN 'MODERATE' THEN 1 ELSE 2 END, offered_at DESC", personId)
    .map((r) => `${r.offered}${r.risk === 'HIGH' ? ' (high risk)' : ''}`);
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const today = todayLocal();
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (OPEN.includes(state)) actions.push('reoffer');
    if (state === 'DECLINED') actions.push('escalate');
    if (state === 'ESCALATED' && senior(ctx)) actions.push('respond');
    if (state === 'DECLINED') actions.push('plan');
    if (OPEN.includes(state)) actions.push('close');
    if (OPEN.includes(state) && (senior(ctx) || r.recordedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], categoryLabel: CATEGORIES[String(r.category)] ?? String(r.category),
    decidedByLabel: DECIDED_BY[String(r.decidedBy)] ?? String(r.decidedBy), riskLabel: RISKS[String(r.risk)] ?? String(r.risk),
    capacityConcern: Boolean(r.capacityConcern),
    needsEscalation: state === 'DECLINED' && r.risk === 'HIGH' && !r.response,
    reofferDue: OPEN.includes(state) && !!r.reofferBy && String(r.reofferBy) <= today,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM declined_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.declined_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'declined', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That declined care is no longer in SHIFT.');
  return r;
};

const reofferDate = (v: unknown) => {
  const d = text(v, 10);
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < todayLocal() || d > addDays(todayLocal(), 60)) throw new HttpError(400, 'DATE', 'Choose when to offer it again, from today, or leave it empty.');
  return d;
};

export function record(store: Store, ctx: WorkContext, personId: string, b: {
  category?: string; offered?: string; information?: string; decidedBy?: string; representative?: string; capacityConcern?: string; reason?: string;
  implications?: string; risk?: string; plan?: string; reofferBy?: string; offeredAt?: string;
}) {
  enforce(store, ctx, { op: 'DECLINED_CARE', personId }, personId);
  const category = CATEGORIES[String(b.category)] ? String(b.category) : '';
  if (!category) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose what kind of care was offered.');
  const offered = text(b.offered, 200);
  if (offered.length < 3) throw new HttpError(400, 'OFFERED_REQUIRED', 'Write what was offered, e.g. "Enoxaparin 40 mg injection".');
  const information = text(b.information, 1000);
  if (information.length < 10) throw new HttpError(400, 'INFORMATION_REQUIRED', 'Write what they were told about it, e.g. "Explained it prevents clots in the legs and lungs; risk is higher while in bed".');
  const decidedBy = DECIDED_BY[String(b.decidedBy)] ? String(b.decidedBy) : '';
  if (!decidedBy) throw new HttpError(400, 'DECIDED_BY_REQUIRED', 'Choose who declined.');
  const representative = decidedBy === 'REPRESENTATIVE' ? text(b.representative, 200) : '';
  if (decidedBy === 'REPRESENTATIVE' && representative.length < 3) throw new HttpError(400, 'REPRESENTATIVE_REQUIRED', 'Write the representative\'s name and role, e.g. "Rawiri Te Whare, EPOA personal care and welfare".');
  const implications = text(b.implications, 1000);
  if (implications.length < 10) throw new HttpError(400, 'IMPLICATIONS_REQUIRED', 'Write what declining means for them now, e.g. "Higher risk of a clot while mostly in bed".');
  const risk = RISKS[String(b.risk)] ? String(b.risk) : '';
  if (!risk) throw new HttpError(400, 'RISK_REQUIRED', 'Choose how risky declining is.');
  const when = Date.parse(String(b.offeredAt ?? ''));
  if (Number.isNaN(when) || when > Date.now() + 5 * 60_000 || when < Date.now() - 7 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it was offered, in the last week.');
  const reason = text(b.reason, 1000);
  const plan = text(b.plan, 1000);
  const reofferBy = reofferDate(b.reofferBy);
  const concern = b.capacityConcern === 'YES';
  store.tx(() => {
    const id = newId();
    store.insert('declined_care', {
      id, person_id: personId, service_id: ctx.serviceId, category, offered, information, decided_by: decidedBy, representative: representative || null,
      capacity_concern: concern ? 1 : 0, reason: reason || null, implications, risk, plan: plan || null, reoffer_by: reofferBy,
      offered_at: new Date(when).toISOString(), state: 'DECLINED', recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'declined', id, 'DECLINED', { actorId: ctx.workerId, workContextId: ctx.id }, offered);
    log(store, ctx, id, 'DECLINED', [`${offered} declined by ${decidedBy === 'PERSON' ? 'the person' : representative}.`, `Told: ${information}.`,
      reason ? `Reason: ${reason}.` : 'No reason given.', `Means: ${implications}. Risk ${RISKS[risk].toLowerCase()}.`, plan ? `Plan: ${plan}.` : '',
      concern ? 'Concern about their capacity to decide.' : '', reofferBy ? `Offer again by ${reofferBy}.` : ''].filter(Boolean).join(' '));
    logged(store, ctx, 'DECLINED_RECORD', personId, id, `${category}: ${risk}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; to?: string; outcome?: string; plan?: string; reofferBy?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'DECLINED_CARE', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This declined care belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  switch (action) {
    case 'reoffer': {
      inState(...OPEN);
      const outcome = REOFFER[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether they accepted this time.');
      if (outcome === 'DECLINED') need(3, 'Write what they said, e.g. "Still says no; will think about it after lunch".');
      const next = outcome === 'DECLINED' ? reofferDate(b.reofferBy) : null;
      store.tx(() => {
        if (outcome === 'ACCEPTED') {
          transition(store, 'declined', id, 'ACCEPTED', who, note.slice(0, 200) || undefined);
          store.run('UPDATE declined_care SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note || 'Accepted when offered again.', id);
          log(store, ctx, id, 'ACCEPTED', `Offered again and accepted.${note ? ` ${note}` : ''}`);
        } else {
          store.run('UPDATE declined_care SET reoffer_by = ? WHERE id = ?', next, id);
          log(store, ctx, id, 'REOFFERED', `Offered again and declined. ${note}${next ? ` Offer again by ${next}.` : ''}`);
        }
        logged(store, ctx, `DECLINED_REOFFER_${outcome}`, personId, id, note.slice(0, 200) || undefined);
      });
      break;
    }
    case 'escalate': {
      inState('DECLINED');
      const to = text(b.to, 200);
      if (to.length < 3) throw new HttpError(400, 'TO_REQUIRED', 'Write who you escalated to, e.g. "Dr Li (consultant) by phone".');
      store.tx(() => {
        transition(store, 'declined', id, 'ESCALATED', who, to);
        store.run('UPDATE declined_care SET escalated_to = ?, escalated_at = ?, response = NULL, responded_by = NULL, responded_at = NULL WHERE id = ?', to, at, id);
        log(store, ctx, id, 'ESCALATED', `To ${to}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'DECLINED_ESCALATE', personId, id, to);
      });
      break;
    }
    case 'respond': {
      inState('ESCALATED');
      if (!senior(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot respond to an escalated refusal.`);
      need(10, 'Write your response, e.g. "Spoke with her: she understands the risk and still declines; stockings and walk every 2 hours".');
      const plan = text(b.plan, 1000);
      const next = reofferDate(b.reofferBy);
      store.tx(() => {
        transition(store, 'declined', id, 'DECLINED', who, 'Senior response');
        store.run('UPDATE declined_care SET response = ?, responded_by = ?, responded_at = ?, plan = COALESCE(?, plan), reoffer_by = ? WHERE id = ?',
          note, ctx.workerId, at, plan || null, next, id);
        log(store, ctx, id, 'RESPONSE', `${note}${plan ? ` Plan: ${plan}.` : ''}${next ? ` Offer again by ${next}.` : ''}`);
        logged(store, ctx, 'DECLINED_RESPOND', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'plan': {
      inState('DECLINED');
      const plan = text(b.plan, 1000);
      if (plan.length < 5) throw new HttpError(400, 'PLAN_REQUIRED', 'Write the plan instead, e.g. "Compression stockings; walk every 2 hours".');
      const next = reofferDate(b.reofferBy);
      store.tx(() => {
        store.run('UPDATE declined_care SET plan = ?, reoffer_by = ? WHERE id = ?', plan, next, id);
        log(store, ctx, id, 'PLAN', `${plan}${next ? ` Offer again by ${next}.` : ''}`);
        logged(store, ctx, 'DECLINED_PLAN', personId, id, plan.slice(0, 200));
      });
      break;
    }
    case 'close': {
      inState(...OPEN);
      need(5, 'Say why it is closed, e.g. "Course finished" or "Discharged home".');
      store.tx(() => {
        transition(store, 'declined', id, 'CLOSED', who, note.slice(0, 200));
        store.run('UPDATE declined_care SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, 'CLOSED', note);
        logged(store, ctx, 'DECLINED_CLOSE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      if (!senior(ctx) && r.recordedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who recorded it, or a senior clinician, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Recorded for the wrong person".');
      store.tx(() => {
        transition(store, 'declined', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE declined_care SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'DECLINED_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Declined care view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.offered_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canRecord: can,
    options: { categories: CATEGORIES, decidedBy: DECIDED_BY, risks: RISKS, reoffer: REOFFER },
  };
}

// Home → Declined care for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('declined.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include declined care`);
  const rows = store.all<Row>(`${Q} WHERE d.service_id = ? AND d.state IN ('DECLINED', 'ESCALATED') ORDER BY d.offered_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_DECLINED_CARE', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    attention: rows.filter((x) => x.state === 'ESCALATED' || x.needsEscalation),
    reoffer: rows.filter((x) => x.state === 'DECLINED' && !x.needsEscalation && x.reofferDue),
    others: rows.filter((x) => x.state === 'DECLINED' && !x.needsEscalation && !x.reofferDue),
    canRespond: senior(ctx),
  };
}
