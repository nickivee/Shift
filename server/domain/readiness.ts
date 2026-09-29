import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history, revise } from './lifecycle.ts';
import { KINDS, ASSESSORS, TEMPLATES, ITEM_STATUS, END_REASONS } from '../config/readiness.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Clinical Readiness (Shared Lifecycle Object 293):
//   readiness assessment required → prerequisites → completed/outstanding/not applicable →
//   authorised assessment → ready/not ready/conditional → reassessment.
// Anyone caring for the person can ask whether they are ready for something (a procedure, going home,
// a move, getting up, therapy) and work through what must be done first. Only a profession allowed
// for that kind of readiness decides. Ready needs every essential item done or not applicable;
// ready with conditions and not ready each need a reason and a date to reassess.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  ASSESSING: 'Being assessed', READY: 'Ready', CONDITIONAL: 'Ready with conditions', NOT_READY: 'Not ready', CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const OPEN = ['ASSESSING', 'READY', 'CONDITIONAL', 'NOT_READY'];
const DECIDED = ['READY', 'CONDITIONAL', 'NOT_READY'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-READY-001'];

const Q = `
  SELECT r.id, r.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         r.service_id AS serviceId, s.name AS service, r.kind, r.purpose, r.needed_by AS neededBy, r.state,
         rb.display_name AS raisedBy, r.raised_by AS raisedById, r.raised_at AS raisedAt,
         db.display_name AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote, r.conditions, r.reassess_by AS reassessBy,
         r.end_reason AS endReason, eb.display_name AS endedBy, r.ended_at AS endedAt, r.ended_note AS endedNote
    FROM readiness r
    JOIN person p ON p.id = r.person_id
    JOIN service s ON s.id = r.service_id
    JOIN workforce_person rb ON rb.id = r.raised_by
    LEFT JOIN workforce_person db ON db.id = r.decided_by
    LEFT JOIN workforce_person eb ON eb.id = r.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'READINESS', personId }).decision === 'ALLOW';
// The kinds of readiness this workstation may decide.
const decides = (ctx: WorkContext) => ctx.role.capabilities.includes('readiness.assess') && ctx.role.profession
  ? Object.keys(KINDS).filter((k) => ASSESSORS[k].includes(String(ctx.role.profession))) : [];

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'readiness', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const log = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('readiness_log', { id: newId(), readiness_id: id, kind, body, by_id: ctx.workerId, at: now() });

function items(store: Store, id: string) {
  return store.all<Row>(`SELECT i.id, i.label, i.essential, i.status, i.note, w.display_name AS doneBy, i.done_at AS doneAt FROM readiness_item i
      LEFT JOIN workforce_person w ON w.id = i.done_by WHERE i.readiness_id = ? ORDER BY i.position, i.rowid`, id)
    .map((i) => ({ ...i, id: String(i.id), label: String(i.label), status: String(i.status), essential: Boolean(i.essential), statusLabel: ITEM_STATUS[String(i.status)] }));
}

const LOG_LABELS: Record<string, string> = {
  RAISED: 'Assessment asked for', ITEM: 'Item updated', ADDED: 'Item added', READY: 'Ready', CONDITIONAL: 'Ready with conditions', NOT_READY: 'Not ready',
  REASSESS: 'Reassessment started', CLOSED: 'Closed', ERROR: 'Entered in error',
};

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const kind = String(r.kind);
  const list = items(store, id);
  const today = todayLocal();
  const outstanding = list.filter((i) => i.status === 'OUTSTANDING');
  const essentialOutstanding = outstanding.filter((i) => i.essential);
  const mayDecide = decides(ctx).includes(kind);
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (state === 'ASSESSING') actions.push('add');
    if (state === 'ASSESSING' && mayDecide) actions.push('decide');
    if (DECIDED.includes(state)) actions.push('reassess');
    if (OPEN.includes(state)) actions.push('close');
    if (OPEN.includes(state) && (mayDecide || r.raisedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, kind, stateLabel: STATES[state], kindLabel: KINDS[kind] ?? kind, neededBy: r.neededBy ? String(r.neededBy) : null,
    items: list, outstanding: outstanding.length, essentialOutstanding: essentialOutstanding.map((i) => i.label),
    canUpdateItems: can && ctx.serviceId === r.serviceId && state === 'ASSESSING',
    reassessDue: DECIDED.includes(state) && !!r.reassessBy && String(r.reassessBy) <= today,
    late: OPEN.includes(state) && state !== 'READY' && !!r.neededBy && String(r.neededBy) < today,
    endLabel: r.endReason ? END_REASONS[String(r.endReason)] ?? String(r.endReason) : null,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM readiness_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.readiness_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'readiness', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That readiness assessment is no longer in SHIFT.');
  return r;
};

export function raise(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; purpose?: string; neededBy?: string; note?: string }) {
  enforce(store, ctx, { op: 'READINESS', personId }, personId);
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what they need to be ready for.');
  const purpose = text(b.purpose, 200);
  if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Say what exactly, e.g. "Home to her daughter\'s on Friday" or "Knee aspiration".');
  const neededBy = text(b.neededBy, 10) || null;
  if (neededBy && (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || neededBy < todayLocal() || neededBy > addDays(todayLocal(), 180))) throw new HttpError(400, 'DATE', 'Choose when it is needed by, from today.');
  const open = store.get('SELECT 1 FROM readiness WHERE person_id = ? AND service_id = ? AND kind = ? AND purpose = ? AND state IN (\'ASSESSING\', \'READY\', \'CONDITIONAL\', \'NOT_READY\')', personId, ctx.serviceId, kind, purpose);
  if (open) throw new HttpError(409, 'ALREADY_OPEN', 'There is already an open readiness assessment for this. Reassess that one instead.');
  store.tx(() => {
    const id = newId();
    const at = now();
    store.insert('readiness', { id, person_id: personId, service_id: ctx.serviceId, kind, purpose, needed_by: neededBy, state: 'ASSESSING', raised_by: ctx.workerId, raised_at: at });
    TEMPLATES[kind].forEach(([label, essential], n) => store.insert('readiness_item', {
      id: newId(), readiness_id: id, label, essential: essential ? 1 : 0, status: 'OUTSTANDING', position: n, added_by: ctx.workerId, added_at: at,
    }));
    recordInitial(store, 'readiness', id, 'ASSESSING', { actorId: ctx.workerId, workContextId: ctx.id }, `${KINDS[kind]}: ${purpose}`);
    log(store, ctx, id, 'RAISED', `${KINDS[kind]}: ${purpose}${neededBy ? `, needed by ${neededBy}` : ''}.${text(b.note) ? ` ${text(b.note)}` : ''}`);
    logged(store, ctx, 'READINESS_RAISE', personId, id, `${KINDS[kind]}: ${purpose}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { itemId?: string; status?: string; label?: string; essential?: string; decision?: string; note?: string; conditions?: string; reassessBy?: string; reason?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const kind = String(r.kind);
  enforce(store, ctx, { op: 'READINESS', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This readiness assessment belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This readiness assessment is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const decider = () => {
    if (!decides(ctx).includes(kind)) {
      throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot decide readiness ${KINDS[kind].toLowerCase()}. It needs a ${ASSESSORS[kind].join(' or ')}.`);
    }
  };
  const date = (min: string, msg: string) => {
    const d = text(b.reassessBy, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < min || d > addDays(todayLocal(), 90)) throw new HttpError(400, 'DATE', msg);
    return d;
  };
  switch (action) {
    case 'item': {
      inState('ASSESSING');
      const item = store.get<Row>('SELECT id, label FROM readiness_item WHERE id = ? AND readiness_id = ?', text(b.itemId, 60), id);
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'That item is not on this assessment.');
      const status = ITEM_STATUS[String(b.status)] ? String(b.status) : '';
      if (!status) throw new HttpError(400, 'STATUS_REQUIRED', 'Choose done, not applicable or still to do.');
      if (status === 'NOT_APPLICABLE') need(5, 'Say why it does not apply, e.g. "No blood thinners charted".');
      store.tx(() => {
        store.run('UPDATE readiness_item SET status = ?, note = ?, done_by = ?, done_at = ? WHERE id = ?',
          status, note || null, status === 'OUTSTANDING' ? null : ctx.workerId, status === 'OUTSTANDING' ? null : at, item.id);
        log(store, ctx, id, 'ITEM', `${item.label}: ${ITEM_STATUS[status].toLowerCase()}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'READINESS_ITEM', personId, id, `${item.label}: ${status}`);
      });
      break;
    }
    case 'add': {
      inState('ASSESSING');
      const label = text(b.label, 120);
      if (label.length < 3) throw new HttpError(400, 'LABEL_REQUIRED', 'Write what must be done, e.g. "Hearing aids in".');
      const essential = b.essential === 'YES';
      store.tx(() => {
        const pos = store.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM readiness_item WHERE readiness_id = ?', id)!.n;
        store.insert('readiness_item', { id: newId(), readiness_id: id, label, essential: essential ? 1 : 0, status: 'OUTSTANDING', position: pos, added_by: ctx.workerId, added_at: at });
        log(store, ctx, id, 'ADDED', `${label}${essential ? ' (essential)' : ''}.`);
        logged(store, ctx, 'READINESS_ADD_ITEM', personId, id, label);
      });
      break;
    }
    case 'decide': {
      inState('ASSESSING');
      decider();
      const decision = DECIDED.includes(String(b.decision)) ? String(b.decision) : '';
      if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose ready, ready with conditions, or not ready.');
      const list = items(store, id);
      const essentialOut = list.filter((i) => i.essential && i.status === 'OUTSTANDING').map((i) => i.label);
      if (decision === 'READY' && essentialOut.length) {
        throw new HttpError(409, 'ITEMS_OUTSTANDING', `Not everything essential is done: ${essentialOut.join('; ')}. Choose ready with conditions, or not ready.`);
      }
      const conditions = text(b.conditions, 1000);
      if (decision === 'CONDITIONAL' && conditions.length < 10) throw new HttpError(400, 'CONDITIONS_REQUIRED', 'Write the conditions, e.g. "Only once the INR is under 1.5 this morning".');
      if (decision === 'NOT_READY') need(10, 'Say why not ready, e.g. "Still needs oxygen; not safe on the stairs yet".');
      const reassessBy = decision === 'READY' ? (text(b.reassessBy, 10) ? date(todayLocal(), 'Choose a valid-until date from today, or leave it empty.') : null)
        : date(todayLocal(), 'Choose when to reassess, from today.');
      store.tx(() => {
        transition(store, 'readiness', id, decision, who, (conditions || note).slice(0, 200) || undefined);
        store.run('UPDATE readiness SET decided_by = ?, decided_at = ?, decision_note = ?, conditions = ?, reassess_by = ? WHERE id = ?',
          ctx.workerId, at, note || null, decision === 'CONDITIONAL' ? conditions : null, reassessBy, id);
        log(store, ctx, id, decision, [decision === 'CONDITIONAL' ? `Conditions: ${conditions}.` : '', note, essentialOut.length ? `Still to do: ${essentialOut.join('; ')}.` : '',
          reassessBy ? `${decision === 'READY' ? 'Valid until' : 'Reassess by'} ${reassessBy}.` : ''].filter(Boolean).join(' ') || 'All done.');
        logged(store, ctx, `READINESS_${decision}`, personId, id, KINDS[kind]);
      });
      break;
    }
    case 'reassess': {
      inState(...DECIDED);
      need(5, 'Say why you are reassessing, e.g. "Oxygen now off; walking the stairs with the physio".');
      store.tx(() => {
        const before = store.get<Record<string, unknown>>('SELECT decision_note, conditions, reassess_by FROM readiness WHERE id = ?', id)!;
        revise(store, 'readiness', id, before, {}, { decision_note: 'Decision note', conditions: 'Conditions', reassess_by: 'Reassess by' }, who, note);
        transition(store, 'readiness', id, 'ASSESSING', who, note.slice(0, 200));
        store.run('UPDATE readiness SET decided_by = NULL, decided_at = NULL, decision_note = NULL, conditions = NULL, reassess_by = NULL WHERE id = ?', id);
        log(store, ctx, id, 'REASSESS', `Was ${STATES[state].toLowerCase()}${before.conditions ? ` with conditions: ${before.conditions}` : ''}${before.decision_note ? ` (${before.decision_note})` : ''}. ${note}`);
        logged(store, ctx, 'READINESS_REASSESS', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'close': {
      inState(...OPEN);
      const reason = END_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it is closed.');
      if (reason === 'WENT_AHEAD' && !['READY', 'CONDITIONAL'].includes(state)) throw new HttpError(409, 'NOT_READY', 'It can only have gone ahead once someone decided they were ready.');
      if (reason === 'OTHER') need(5, 'Say why it is closed.');
      store.tx(() => {
        transition(store, 'readiness', id, 'CLOSED', who, END_REASONS[reason]);
        store.run('UPDATE readiness SET end_reason = ?, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', reason, ctx.workerId, at, note || null, id);
        log(store, ctx, id, 'CLOSED', `${END_REASONS[reason]}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'READINESS_CLOSE', personId, id, reason);
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      if (!decides(ctx).includes(kind) && r.raisedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who asked for it, or someone who can decide it, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Raised for the wrong person".');
      store.tx(() => {
        transition(store, 'readiness', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE readiness SET end_reason = NULL, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'READINESS_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Readiness view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE r.person_id = ? ORDER BY r.raised_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canRaise: can,
    decides: decides(ctx),
    options: { kinds: KINDS, itemStatus: ITEM_STATUS, endReasons: END_REASONS },
  };
}

// Home → Readiness for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('readiness.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include readiness`);
  const rows = store.all<Row>(`${Q} WHERE r.service_id = ? AND r.state IN ('ASSESSING', 'READY', 'CONDITIONAL', 'NOT_READY') ORDER BY COALESCE(r.needed_by, '9999'), r.raised_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_READINESS', decision: 'ALLOW', outcome: 'VIEWED' });
  const d = decides(ctx);
  return {
    toDecide: rows.filter((x) => x.state === 'ASSESSING' && !x.essentialOutstanding.length),
    assessing: rows.filter((x) => x.state === 'ASSESSING' && x.essentialOutstanding.length),
    reassess: rows.filter((x) => x.reassessDue),
    decided: rows.filter((x) => DECIDED.includes(x.state) && !x.reassessDue),
    decides: d,
  };
}
