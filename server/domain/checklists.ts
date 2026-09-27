import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { raise as raiseEscalation, recipients, URGENCY } from './escalations.ts';
import { CHECKLISTS, CHECKLIST_BY_ID } from '../config/checklists.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Checklist (the checklist lifecycle listed under Shared Lifecycle Object 278):
//   checklist required → individual check items due → check performed → evidence/response →
//   exception → resolution/escalation → checklist completion.
// A nurse or doctor says a checklist is needed for someone and by when. Anyone caring for the
// person works through the items: yes (with evidence where the item asks for it), no, or not
// applicable. A "no" is an exception: it stays open until someone fixes it and says how, or
// escalates it (Object 225). The checklist completes when no item is due and no exception is
// open. The checklists themselves are the synthetic organisation's own (RR-CHK-001).

type Row = Record<string, string | number | null>;
type Cap = 'checklist.record' | 'checklist.manage';
const STATES: Record<string, string> = {
  REQUIRED: 'Not started', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled', ENTERED_IN_ERROR: 'Entered in error',
};
const ITEM_STATES: Record<string, string> = {
  DUE: 'Due', DONE: 'Yes', NOT_APPLICABLE: 'Not applicable', EXCEPTION: 'Exception', RESOLVED: 'Fixed', ESCALATED: 'Escalated',
};
const LOG: Record<string, string> = {
  REQUIRED: 'Required', DONE: 'Checked', NOT_APPLICABLE: 'Not applicable', EXCEPTION: 'Exception', RESOLVED: 'Fixed', ESCALATED: 'Escalated',
  COMPLETED: 'Completed', CANCELLED: 'Cancelled', ERROR: 'Entered in error',
};
const OPEN = ['REQUIRED', 'IN_PROGRESS'];
const OPEN_ITEM = ['DUE', 'EXCEPTION'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-CHK-001'];

const Q = `
  SELECT c.id, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.service_id AS serviceId, c.template_id AS templateId, c.state, c.due_at AS dueAt, c.reason,
         rb.display_name AS requiredBy, c.required_at AS requiredAt, cb.display_name AS endedBy, c.ended_at AS endedAt, c.end_note AS endNote
    FROM checklist c
    JOIN person p ON p.id = c.person_id
    JOIN workforce_person rb ON rb.id = c.required_by
    LEFT JOIN workforce_person cb ON cb.id = c.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'CHECKLIST', personId, cap }).decision === 'ALLOW';
const addMins = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'checklist', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, byId: string, id: string, kind: string, body: string) =>
  store.insert('checklist_log', { id: newId(), checklist_id: id, kind, body, by_id: byId, at: now() });

function shape(store: Store, ctx: WorkContext | null, r: Row, can: { record: boolean; manage: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const def = CHECKLIST_BY_ID.get(String(r.templateId));
  const items = store.all<Row>(`SELECT i.id, i.label, i.evidence_label AS evidenceLabel, i.state, i.evidence, i.note, w.display_name AS "by", i.at,
      i.resolution, rw.display_name AS resolvedBy, i.resolved_at AS resolvedAt, i.escalation_id AS escalationId
    FROM checklist_item i LEFT JOIN workforce_person w ON w.id = i.by_id LEFT JOIN workforce_person rw ON rw.id = i.resolved_by
    WHERE i.checklist_id = ? ORDER BY i.seq`, id).map((i) => ({ ...i, stateLabel: ITEM_STATES[String(i.state)] ?? String(i.state) })) as (Row & { stateLabel: string })[];
  const due = items.filter((i) => i.state === 'DUE').length;
  const exceptions = items.filter((i) => i.state === 'EXCEPTION');
  const ready = OPEN.includes(state) && !items.some((i) => OPEN_ITEM.includes(String(i.state)));
  const actions: string[] = [];
  if (ready && can.record) actions.push('complete');
  if (OPEN.includes(state) && can.manage) actions.push('cancel', 'error');
  return {
    ...r, id, state, stateLabel: STATES[state], label: def?.label ?? String(r.templateId), purpose: def?.purpose ?? '',
    items, due, exceptions: exceptions.length, exceptionLabels: exceptions.map((i) => `${i.label}${i.note ? `: ${i.note}` : ''}`),
    overdue: OPEN.includes(state) && String(r.dueAt) <= now(), ready, actions,
    canCheck: OPEN.includes(state) && can.record, canEscalate: OPEN.includes(state) && !!ctx && can.record && recipients(store, ctx, String(r.personId)).length > 0,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM checklist_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.checklist_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'checklist', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That checklist is no longer in SHIFT.');
  return r;
};

export function requireChecklist(store: Store, ctx: WorkContext, personId: string, b: { templateId?: string; reason?: string }) {
  enforce(store, ctx, { op: 'CHECKLIST', personId, cap: 'checklist.manage' }, personId);
  const def = CHECKLIST_BY_ID.get(String(b.templateId));
  if (!def) throw new HttpError(400, 'CHECKLIST_REQUIRED', 'Choose a checklist.');
  if (store.get("SELECT 1 FROM checklist WHERE person_id = ? AND template_id = ? AND state IN ('REQUIRED', 'IN_PROGRESS')", personId, def.id)) {
    throw new HttpError(409, 'ALREADY_OPEN', `A ${def.label.toLowerCase()} is already open for this person.`);
  }
  const reason = text(b.reason, 300);
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('checklist', {
      id, person_id: personId, service_id: ctx.serviceId, template_id: def.id, state: 'REQUIRED', due_at: addMins(at, def.dueMins), reason: reason || null,
      required_by: ctx.workerId, required_at: at,
    });
    def.items.forEach((it, i) => store.insert('checklist_item', {
      id: newId(), checklist_id: id, item_key: it.id, label: it.label, seq: i, evidence_label: it.evidence ?? null, state: 'DUE',
    }));
    recordInitial(store, 'checklist', id, 'REQUIRED', { actorId: ctx.workerId, workContextId: ctx.id }, def.label);
    addLog(store, ctx.workerId, id, 'REQUIRED', `${def.label}.${reason ? ` ${reason}` : ''}`);
    logged(store, ctx, 'CHECKLIST_REQUIRE', personId, id, def.label);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; itemId?: string; result?: string; evidence?: string; roleKey?: string; urgency?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const def = CHECKLIST_BY_ID.get(String(r.templateId))!;
  const cap: Cap = ['cancel', 'error'].includes(action) ? 'checklist.manage' : 'checklist.record';
  enforce(store, ctx, { op: 'CHECKLIST', personId, cap }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This checklist is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const item = (itemState: string) => {
    const i = store.get<{ id: string; label: string; state: string; evidence_label: string | null }>(
      'SELECT id, label, state, evidence_label FROM checklist_item WHERE id = ? AND checklist_id = ?', String(b.itemId ?? ''), id);
    if (!i) throw new HttpError(404, 'NOT_FOUND', 'That item is no longer in this checklist.');
    if (i.state !== itemState) throw new HttpError(409, 'ITEM_STATE', itemState === 'DUE' ? 'That item has already been checked.' : 'That item is not an open exception.');
    return i;
  };
  const started = () => { if (state === 'REQUIRED') transition(store, 'checklist', id, 'IN_PROGRESS', who, 'First item checked'); };
  switch (action) {
    case 'check': {
      inState(...OPEN);
      const i = item('DUE');
      const result = String(b.result);
      if (!['YES', 'NO', 'NA'].includes(result)) throw new HttpError(400, 'RESULT_REQUIRED', 'Choose yes, no or not applicable.');
      const evidence = text(b.evidence, 500);
      if (result === 'YES' && i.evidence_label && evidence.length < 2) throw new HttpError(400, 'EVIDENCE_REQUIRED', `Fill in: ${i.evidence_label}.`);
      if (result === 'NO') need(5, 'Write what is wrong, e.g. "Call bell cord frayed; not working".');
      if (result === 'NA') need(5, 'Write why it does not apply.');
      const to = result === 'YES' ? 'DONE' : result === 'NO' ? 'EXCEPTION' : 'NOT_APPLICABLE';
      store.tx(() => {
        started();
        store.run('UPDATE checklist_item SET state = ?, evidence = ?, note = ?, by_id = ?, at = ? WHERE id = ?', to, evidence || null, note || null, ctx.workerId, at, i.id);
        addLog(store, ctx.workerId, id, to, `${i.label}.${evidence ? ` ${i.evidence_label}: ${evidence}.` : ''}${note ? ` ${note}` : ''}`);
        logged(store, ctx, `CHECKLIST_${to}`, personId, id, i.label);
      });
      break;
    }
    case 'resolve': {
      inState(...OPEN);
      const i = item('EXCEPTION');
      need(5, 'Write how it was fixed, e.g. "New call bell fitted and tested".');
      store.tx(() => {
        store.run("UPDATE checklist_item SET state = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?", note, ctx.workerId, at, i.id);
        addLog(store, ctx.workerId, id, 'RESOLVED', `${i.label}. ${note}`);
        logged(store, ctx, 'CHECKLIST_RESOLVE', personId, id, i.label);
      });
      break;
    }
    case 'escalate': {
      inState(...OPEN);
      const i = item('EXCEPTION');
      need(10, 'Say what the risk is and what you need.');
      const urgency = (URGENCY as readonly string[]).includes(String(b.urgency)) ? String(b.urgency) : '';
      if (!urgency) throw new HttpError(400, 'URGENCY_REQUIRED', 'Choose how urgent this is.');
      store.tx(() => {
        const esc = raiseEscalation(store, ctx, personId, { roleKey: b.roleKey, urgency, concern: 'Other', trigger: `${def.label}: ${i.label} not met. ${note}` });
        store.run("UPDATE checklist_item SET state = 'ESCALATED', resolution = ?, resolved_by = ?, resolved_at = ?, escalation_id = ? WHERE id = ?", note, ctx.workerId, at, esc.id, i.id);
        addLog(store, ctx.workerId, id, 'ESCALATED', `${i.label}. ${note}`);
        logged(store, ctx, 'CHECKLIST_ESCALATE', personId, id, i.label);
      });
      break;
    }
    case 'complete': {
      inState(...OPEN);
      const open = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM checklist_item WHERE checklist_id = ? AND state IN ('DUE', 'EXCEPTION')", id)?.n ?? 0;
      if (open) throw new HttpError(409, 'ITEMS_OPEN', 'Check every item, and fix or escalate every exception, before completing.');
      store.tx(() => {
        transition(store, 'checklist', id, 'COMPLETED', who, note.slice(0, 200) || 'Completed');
        store.run('UPDATE checklist SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
        addLog(store, ctx.workerId, id, 'COMPLETED', note || 'Every item checked.');
        logged(store, ctx, 'CHECKLIST_COMPLETE', personId, id, def.label);
      });
      break;
    }
    case 'cancel':
    case 'error': {
      inState(...OPEN);
      if (action === 'cancel') need(5, 'Write why it is no longer needed.');
      else need(10, 'Write why this was entered in error, e.g. "Started for the wrong person".');
      const to = action === 'cancel' ? 'CANCELLED' : 'ENTERED_IN_ERROR';
      store.tx(() => {
        transition(store, 'checklist', id, to, who, note.slice(0, 200));
        store.run('UPDATE checklist SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx.workerId, id, action === 'cancel' ? 'CANCELLED' : 'ERROR', note);
        logged(store, ctx, action === 'cancel' ? 'CHECKLIST_CANCEL' : 'CHECKLIST_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Checklists view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { record: may(store, ctx, personId, 'checklist.record'), manage: may(store, ctx, personId, 'checklist.manage') };
  const all = store.all<Row>(`${Q} WHERE c.person_id = ? ORDER BY c.required_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canRecord: can.record, canManage: can.manage,
    options: {
      checklists: CHECKLISTS.map((c) => ({ id: c.id, label: c.label, purpose: c.purpose })),
      urgencies: URGENCY, recipients: can.record ? recipients(store, ctx, personId) : [],
    },
  };
}

// For the record header: open exceptions.
export function current(store: Store, personId: string) {
  return store.all<{ template_id: string; label: string; note: string | null }>(`SELECT c.template_id, i.label, i.note FROM checklist_item i JOIN checklist c ON c.id = i.checklist_id
    WHERE c.person_id = ? AND c.state IN ('REQUIRED', 'IN_PROGRESS') AND i.state = 'EXCEPTION' ORDER BY i.at`, personId)
    .map((i) => `${i.label}${i.note ? `: ${i.note}` : ''}`);
}

// Home → Checklists: open exceptions, overdue checklists, not started, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('checklist.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing checklists`);
  }
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = c.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship r WHERE r.person_id = c.person_id AND r.service_id = ? AND r.ended_at IS NULL)`;
  const rows = store.all<Row>(`${Q} WHERE c.state IN ('REQUIRED', 'IN_PROGRESS') AND (${inService}) ORDER BY c.due_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, null, r, { record: false, manage: false }));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CHECKLISTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    exceptions: rows.filter((r) => r.exceptions > 0),
    overdue: rows.filter((r) => r.overdue),
    notStarted: rows.filter((r) => r.state === 'REQUIRED' && !r.overdue),
    open: rows.length,
  };
}
