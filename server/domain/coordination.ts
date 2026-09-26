import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce, tasksFor } from './record.ts';
import { audit } from './audit.ts';
import { transition, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Received: routes addressed to this service (and this role, when the destination names one).
export function received(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'RECEIVE', destinationServiceId: ctx.serviceId, destinationRoleKey: null });
  const rows = store.all<Record<string, string | number>>(
    `SELECT r.id, r.state, r.created_at, r.requires_acceptance, d.label AS destination, e.rendered_text AS text, e.category, e.urgent,
            e.id AS event_id, e.state AS event_state, e.id <> r.source_event_id AS amended, p.id AS person_id,
            p.given_name || ' ' || p.family_name AS patient, w.display_name AS sender, e.author_role_label AS sender_role
       FROM route r JOIN destination d ON d.id = r.destination_id
       JOIN clinical_event e ON e.lineage_id = r.source_lineage_id AND e.state <> 'SUPERSEDED'
       JOIN person p ON p.id = r.person_id JOIN workforce_person w ON w.id = r.actor_id
      WHERE d.service_id = ? AND (d.role_key IS NULL OR d.role_key = ?)
      ORDER BY CASE WHEN r.state = 'ACTIONED' THEN 1 ELSE 0 END, e.urgent DESC, r.created_at DESC LIMIT 200`,
    ctx.serviceId, ctx.role.roleKey,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_RECEIVED', decision: 'ALLOW', outcome: 'VIEWED', engines: [13] });
  return rows.map((r) => ({
    id: r.id, state: r.state, createdAt: r.created_at, requiresAcceptance: Boolean(r.requires_acceptance), destination: r.destination,
    text: r.text, category: r.category, urgent: Boolean(r.urgent), eventId: r.event_id, personId: r.person_id, patient: r.patient,
    sender: r.sender, senderRole: r.sender_role, amended: Boolean(r.amended), enteredInError: r.event_state === 'ENTERED_IN_ERROR',
  }));
}

const ROUTE_ACTIONS: Record<string, string> = { receive: 'RECEIVED', review: 'REVIEWED', accept: 'ACCEPTED', action: 'ACTIONED' };

export function routeAction(store: Store, ctx: WorkContext, routeId: string, action: string, note?: string) {
  const to = ROUTE_ACTIONS[action];
  if (!to) throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
  const r = store.get<{ person_id: string; service_id: string; role_key: string | null; requires_acceptance: number }>(
    'SELECT r.person_id, d.service_id, d.role_key, r.requires_acceptance FROM route r JOIN destination d ON d.id = r.destination_id WHERE r.id = ?', routeId,
  );
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That item no longer exists.');
  enforce(store, ctx, { op: 'RECEIVE', destinationServiceId: r.service_id, destinationRoleKey: r.role_key }, r.person_id);
  if (to === 'ACCEPTED' && !r.requires_acceptance) throw new HttpError(409, 'NO_ACCEPTANCE', 'This destination does not take acceptance; mark it actioned instead.');
  if (to === 'ACTIONED' && r.requires_acceptance) {
    const cur = store.get<{ state: string }>('SELECT state FROM route WHERE id = ?', routeId);
    if (cur?.state !== 'ACCEPTED') throw new HttpError(409, 'ACCEPT_FIRST', 'This destination requires explicit acceptance before it is actioned.');
  }
  return store.tx(() => {
    const from = transition(store, 'route', routeId, to, { actorId: ctx.workerId, workContextId: ctx.id }, note?.trim() || undefined);
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: r.person_id, operation: `ROUTE_${to}`, objectType: 'route', objectId: routeId, decision: 'ALLOW', outcome: 'COMMITTED', reason: `${from} → ${to}`, engines: [13, 264] });
    return { id: routeId, state: to, history: history(store, 'route', routeId) };
  });
}

// Tasks ---------------------------------------------------------------------------------

export function taskList(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'TASK', serviceId: ctx.serviceId });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_TASKS', decision: 'ALLOW', outcome: 'VIEWED', engines: [14] });
  return tasksFor(store, ctx, { openOnly: true });
}

const TASK_ACTIONS: Record<string, string> = { accept: 'ACCEPTED', start: 'IN_PROGRESS', complete: 'COMPLETED', close: 'CLOSED', cancel: 'CANCELLED' };

export function taskAction(store: Store, ctx: WorkContext, taskId: string, action: string, note?: string) {
  const to = TASK_ACTIONS[action];
  if (!to) throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
  const t = store.get<{ person_id: string; service_id: string; assigned_to: string | null; created_by: string; state: string }>(
    'SELECT person_id, service_id, assigned_to, created_by, state FROM task WHERE id = ?', taskId,
  );
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'That task no longer exists.');
  enforce(store, ctx, { op: 'TASK', serviceId: t.service_id }, t.person_id);
  const me = `worker:${ctx.workerId}`;
  const visible = t.assigned_to === null || t.assigned_to === me || t.assigned_to === `role:${ctx.role.roleKey}` || t.created_by === ctx.workerId;
  if (!visible) throw new HttpError(403, 'BLOCK', 'This task is assigned to someone else.');
  if ((to === 'IN_PROGRESS' || to === 'COMPLETED') && t.assigned_to !== me) throw new HttpError(409, 'ACCEPT_FIRST', 'Accept the task before working on it. Responsibility is never taken on silently.');
  if ((to === 'COMPLETED' || to === 'CANCELLED') && (!note || note.trim().length < 2)) throw new HttpError(400, 'OUTCOME_REQUIRED', to === 'COMPLETED' ? 'Record the outcome.' : 'Give a reason for cancelling.');
  return store.tx(() => {
    const actor = { actorId: ctx.workerId, workContextId: ctx.id };
    transition(store, 'task', taskId, to, actor, note?.trim() || undefined);
    if (to === 'ACCEPTED') store.run('UPDATE task SET assigned_to = ? WHERE id = ?', me, taskId);
    if (to === 'COMPLETED' || to === 'CANCELLED') store.run('UPDATE task SET outcome = ? WHERE id = ?', note!.trim(), taskId);
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: t.person_id, operation: `TASK_${to}`, objectType: 'task', objectId: taskId, decision: 'ALLOW', outcome: 'COMMITTED', reason: note ?? null, engines: [14, 217, 282] });
    return { id: taskId, state: to, history: history(store, 'task', taskId) };
  });
}

// Handover: a projection of explicitly marked canonical entries, never a copied summary.
export function handoverBoard(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'TASK', serviceId: ctx.serviceId });
  if (!ctx.role.capabilities.includes('handover.use')) throw new HttpError(403, 'BLOCK', 'Handover is not part of your workstation.');
  const rows = store.all<Record<string, string | number | null>>(
    `SELECT h.id AS mark_id, h.marked_at, m.display_name AS marked_by, p.id AS person_id, p.given_name || ' ' || p.family_name AS patient,
            en.location, e.id AS event_id, e.rendered_text AS text, e.category, e.urgent, e.effective_at,
            (SELECT max(state) FROM handover_receipt hr WHERE hr.mark_id = h.id AND hr.workforce_person_id = ?) AS my_receipt
       FROM handover_mark h
       JOIN clinical_event e ON e.lineage_id = h.event_lineage_id AND e.state = 'CURRENT'
       JOIN person p ON p.id = h.person_id
       JOIN workforce_person m ON m.id = h.marked_by
       LEFT JOIN encounter en ON en.person_id = p.id AND en.service_id = h.service_id AND en.state = 'ACTIVE'
      WHERE h.service_id = ? AND h.cleared_at IS NULL
      ORDER BY en.location, p.family_name, e.effective_at DESC`,
    ctx.workerId, ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_HANDOVER', decision: 'ALLOW', outcome: 'VIEWED', engines: [16, 219] });
  const byPatient = new Map<string, { personId: string; patient: string; location: string | null; items: unknown[] }>();
  for (const r of rows) {
    const key = String(r.person_id);
    if (!byPatient.has(key)) byPatient.set(key, { personId: key, patient: String(r.patient), location: r.location as string | null, items: [] });
    byPatient.get(key)!.items.push({
      markId: r.mark_id, eventId: r.event_id, text: r.text, category: r.category, urgent: Boolean(r.urgent), effectiveAt: r.effective_at,
      markedBy: r.marked_by, markedAt: r.marked_at, myReceipt: r.my_receipt,
    });
  }
  return [...byPatient.values()];
}

export function handoverAction(store: Store, ctx: WorkContext, markId: string, action: 'receive' | 'review' | 'clear') {
  const m = store.get<{ person_id: string; service_id: string; cleared_at: string | null }>('SELECT person_id, service_id, cleared_at FROM handover_mark WHERE id = ?', markId);
  if (!m || m.cleared_at) throw new HttpError(404, 'NOT_FOUND', 'That handover item is no longer active.');
  enforce(store, ctx, { op: 'HANDOVER', personId: m.person_id }, m.person_id);
  if (m.service_id !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'That handover belongs to another service.');
  return store.tx(() => {
    if (action === 'clear') {
      store.run('UPDATE handover_mark SET cleared_by = ?, cleared_at = ? WHERE id = ?', ctx.workerId, now(), markId);
    } else {
      const state = action === 'receive' ? 'RECEIVED' : 'REVIEWED';
      if (state === 'REVIEWED' && !store.get("SELECT 1 FROM handover_receipt WHERE mark_id = ? AND workforce_person_id = ? AND state = 'RECEIVED'", markId, ctx.workerId)) {
        store.insert('handover_receipt', { id: newId(), mark_id: markId, workforce_person_id: ctx.workerId, state: 'RECEIVED', at: now() });
      }
      store.run('INSERT OR IGNORE INTO handover_receipt (id, mark_id, workforce_person_id, state, at) VALUES (?, ?, ?, ?, ?)', newId(), markId, ctx.workerId, state, now());
    }
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: m.person_id, operation: `HANDOVER_${action.toUpperCase()}`, objectType: 'handover_mark', objectId: markId, decision: 'ALLOW', outcome: 'COMMITTED', engines: [16, 219] });
    return { ok: true };
  });
}

export function reviewResult(store: Store, ctx: WorkContext, resultId: string) {
  const r = store.get<{ person_id: string }>('SELECT person_id FROM result WHERE id = ?', resultId);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Result not found.');
  enforce(store, ctx, { op: 'REVIEW_RESULT', personId: r.person_id }, r.person_id);
  return store.tx(() => {
    transition(store, 'result', resultId, 'REVIEWED', { actorId: ctx.workerId, workContextId: ctx.id });
    store.run('UPDATE result SET reviewed_by = ?, reviewed_at = ? WHERE id = ?', ctx.workerId, now(), resultId);
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: r.person_id, operation: 'RESULT_REVIEWED', objectType: 'result', objectId: resultId, decision: 'ALLOW', outcome: 'COMMITTED', engines: [11, 205] });
    return { id: resultId, state: 'REVIEWED' };
  });
}
