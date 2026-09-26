import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Leave / temporary absence (Shared Lifecycle Object 248):
//   leave considered or requested → clinical or legal authority where applicable → leave
//   conditions → authorised → departure → current absence → expected return → return, or
//   failure or delay to return → reassessment.
// The person stays admitted and keeps their bed while away. Who may approve leave is set in
// each workstation (leave.approve), which is organisational configuration. A person under a
// legal order may have leave asked for, but SHIFT does not approve it (RR-LEAVE-001).

type Row = Record<string, string | number | null>;
const KINDS: Record<string, string> = {
  OUTING: 'Outing (a few hours)', DAY: 'Day leave', OVERNIGHT: 'Overnight leave', WEEKEND: 'Weekend leave',
  TRIAL: 'Trial at home before discharge', OTHER: 'Other leave',
};
const LEGAL: Record<string, string> = {
  NONE: 'No legal order', ORDER: 'Under a legal order', UNSURE: 'Not sure yet',
};
const STATE: Record<string, string> = {
  REQUESTED: 'Waiting for approval', APPROVED: 'Approved', DECLINED: 'Not approved', AWAY: 'Away',
  NOT_RETURNED: 'Not back', RETURNED: 'Back', CANCELLED: 'Cancelled',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002'];
const OPEN = "('REQUESTED', 'APPROVED', 'AWAY', 'NOT_RETURNED')";

const SELECT = `
  SELECT l.id, l.state, l.kind, l.purpose, l.destination, l.companion, l.contact, l.conditions, l.legal,
         l.leave_at AS leaveAt, l.return_by AS returnBy, l.person_id AS personId, l.service_id AS serviceId,
         p.given_name || ' ' || p.family_name AS patient, p.preferred_name AS preferredName,
         (SELECT location FROM encounter e WHERE e.person_id = l.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         rb.display_name AS requestedBy, l.requested_by AS requestedById, l.requested_at AS requestedAt,
         ab.display_name AS approvedBy, l.approved_at AS approvedAt,
         db.display_name AS departedBy, l.departed_at AS departedAt, l.departure_note AS departureNote,
         tb.display_name AS returnedBy, l.returned_at AS returnedAt, l.return_note AS returnNote,
         cb.display_name AS closedBy, l.closed_at AS closedAt, l.close_reason AS closeReason
    FROM leave_of_absence l
    JOIN person p ON p.id = l.person_id
    JOIN workforce_person rb ON rb.id = l.requested_by
    LEFT JOIN workforce_person ab ON ab.id = l.approved_by
    LEFT JOIN workforce_person db ON db.id = l.departed_by
    LEFT JOIN workforce_person tb ON tb.id = l.returned_by
    LEFT JOIN workforce_person cb ON cb.id = l.closed_by`;

const may = (store: Store, ctx: WorkContext, personId: string, cap: 'leave.manage' | 'leave.approve') =>
  evaluate(store, ctx, { op: 'LEAVE', personId, cap }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const personId = String(r.personId);
  const manage = may(store, ctx, personId, 'leave.manage');
  const approve = may(store, ctx, personId, 'leave.approve');
  const overdue = r.state === 'AWAY' && String(r.returnBy) < now();
  const actions: string[] = [];
  if (r.state === 'REQUESTED' && approve && r.legal !== 'ORDER') actions.push('approve');
  if (r.state === 'REQUESTED' && approve) actions.push('decline');
  if (r.state === 'APPROVED' && manage) actions.push('depart');
  if (['AWAY', 'NOT_RETURNED'].includes(String(r.state)) && manage) actions.push('return');
  if (r.state === 'AWAY' && manage) actions.push('extend', 'contact');
  if (overdue && manage) actions.push('notReturned');
  if (r.state === 'NOT_RETURNED' && manage) actions.push('contact');
  if (['REQUESTED', 'APPROVED'].includes(String(r.state)) && (manage || r.requestedById === ctx.workerId)) actions.push('cancel');
  const events = store.all<Row>(
    `SELECT v.kind, v.note, v.return_by AS returnBy, w.display_name AS by, v.at FROM leave_event v
       JOIN workforce_person w ON w.id = v.by_id WHERE v.leave_id = ? ORDER BY v.at`, id,
  );
  return {
    ...r, kindLabel: KINDS[String(r.kind)] ?? String(r.kind), legalLabel: LEGAL[String(r.legal)], stateLabel: STATE[String(r.state)],
    overdue, needsLegal: r.legal !== 'NONE', events, actions, history: history(store, 'leave', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string, refs = REFS) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'leave_of_absence', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: refs,
  });
}

const options = () => ({ kinds: KINDS, legal: LEGAL });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const open = store.all<Row>(`${SELECT} WHERE l.person_id = ? AND l.state IN ${OPEN} ORDER BY l.leave_at`, personId);
  const past = store.all<Row>(`${SELECT} WHERE l.person_id = ? AND l.state NOT IN ${OPEN} ORDER BY COALESCE(l.returned_at, l.closed_at) DESC LIMIT 10`, personId);
  return {
    leave: open.map((r) => shape(store, ctx, r)), past: past.map((r) => shape(store, ctx, r)),
    canRequest: may(store, ctx, personId, 'leave.manage'), canApprove: may(store, ctx, personId, 'leave.approve'), options: options(),
  };
}

// For the record header and patient lists: away now, and when they are due back.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(
    `SELECT state, kind, destination, return_by AS returnBy FROM leave_of_absence WHERE person_id = ? AND state IN ('AWAY', 'NOT_RETURNED') ORDER BY departed_at DESC LIMIT 1`, personId,
  );
  if (!r) return null;
  return { state: r.state, kindLabel: KINDS[String(r.kind)], destination: r.destination, returnBy: r.returnBy, late: r.state === 'NOT_RETURNED' || String(r.returnBy) < now() };
}

interface Fields {
  kind?: string; purpose?: string; destination?: string; companion?: string; contact?: string; conditions?: string;
  legal?: string; leaveAt?: string; returnBy?: string;
}

const when = (v: string | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const text = (v: string | undefined, max = 500) => (v ?? '').trim().slice(0, max);

function clean(b: Fields) {
  const kind = String(b.kind);
  if (!KINDS[kind]) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the kind of leave.');
  const purpose = text(b.purpose);
  if (purpose.length < 3) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Write what the leave is for.');
  const legal = LEGAL[String(b.legal)] ? String(b.legal) : '';
  if (!legal) throw new HttpError(400, 'LEGAL_REQUIRED', 'Say whether they are under a legal order.');
  const leaveAt = when(b.leaveAt);
  const returnBy = when(b.returnBy);
  if (!leaveAt) throw new HttpError(400, 'LEAVE_AT_REQUIRED', 'Choose when they will go.');
  if (!returnBy) throw new HttpError(400, 'RETURN_BY_REQUIRED', 'Choose when they are expected back.');
  if (returnBy <= leaveAt) throw new HttpError(400, 'RETURN_BEFORE_LEAVE', 'They must be due back after they leave.');
  const contact = text(b.contact, 200);
  if (contact.length < 3) throw new HttpError(400, 'CONTACT_REQUIRED', 'Write how to reach them while they are away.');
  return {
    kind, purpose, legal, leave_at: leaveAt, return_by: returnBy, contact,
    destination: text(b.destination, 200) || null, companion: text(b.companion, 200) || null, conditions: text(b.conditions, 1000) || null,
  };
}

// A worker who may approve leave and asks for it approves it at the same time, unless a legal
// order applies or might apply.
export function request(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
  const v = clean(b);
  const direct = v.legal === 'NONE' && may(store, ctx, personId, 'leave.approve');
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('leave_of_absence', {
      id, person_id: personId, service_id: ctx.serviceId, ...v, state: direct ? 'APPROVED' : 'REQUESTED',
      requested_by: ctx.workerId, requested_at: at, approved_by: direct ? ctx.workerId : null, approved_at: direct ? at : null,
    });
    recordInitial(store, 'leave', id, 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, `${KINDS[v.kind]}: ${v.purpose}`);
    if (direct) transition(store, 'leave', id, 'APPROVED', { actorId: ctx.workerId, workContextId: ctx.id }, 'Approved when asked for');
    logged(store, ctx, direct ? 'LEAVE_APPROVE' : 'LEAVE_REQUEST', personId, id, `${KINDS[v.kind]}: ${v.purpose}`);
  });
  return { id, state: direct ? 'APPROVED' : 'REQUESTED' };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE l.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That leave no longer exists.');
  return r;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; returnBy?: string; legal?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note, 1000);
  const at = now();
  const need = (states: string[], message: string) => { if (!states.includes(String(r.state))) throw new HttpError(409, 'WRONG_STATE', message); };
  const noted = (message: string) => { if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', message); };
  const event = (kind: string, returnBy: string | null = null) =>
    store.insert('leave_event', { id: newId(), leave_id: id, kind, note, return_by: returnBy, by_id: ctx.workerId, at });
  switch (action) {
    case 'approve': {
      need(['REQUESTED'], 'This leave is not waiting for approval.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.approve' }, personId);
      // The approver confirms the legal position; a legal order leaves it waiting (RR-LEAVE-001).
      const legal = LEGAL[String(b.legal)] ? String(b.legal) : String(r.legal);
      if (legal !== 'NONE') {
        if (legal !== r.legal) store.run('UPDATE leave_of_absence SET legal = ? WHERE id = ?', legal, id);
        audit(store, {
          actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
          operation: 'LEAVE_APPROVE', objectType: 'leave_of_absence', objectId: id, decision: 'UNRESOLVED', outcome: 'BLOCKED',
          reason: 'Leave under a legal order', ruleRefs: ['RR-LEAVE-001', 'RR-MH-001'],
        });
        throw new HttpError(409, 'UNRESOLVED', legal === 'ORDER'
          ? 'SHIFT cannot approve leave for someone under a legal order yet. The rules for this are still being researched (RR-LEAVE-001), so follow your service\'s legal process and record the outcome in their notes.'
          : 'Check whether a legal order applies first. If none does, choose "No legal order" and approve.');
      }
      store.tx(() => {
        if (legal !== r.legal) store.run('UPDATE leave_of_absence SET legal = ? WHERE id = ?', legal, id);
        transition(store, 'leave', id, 'APPROVED', who, note || undefined);
        store.run('UPDATE leave_of_absence SET approved_by = ?, approved_at = ? WHERE id = ?', ctx.workerId, at, id);
        logged(store, ctx, 'LEAVE_APPROVE', personId, id, note || undefined);
      });
      break;
    }
    case 'decline': {
      need(['REQUESTED'], 'This leave is not waiting for approval.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.approve' }, personId);
      noted('Write why it is not approved.');
      store.tx(() => {
        transition(store, 'leave', id, 'DECLINED', who, note);
        store.run('UPDATE leave_of_absence SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'LEAVE_DECLINE', personId, id, note);
      });
      break;
    }
    case 'cancel': {
      need(['REQUESTED', 'APPROVED'], 'This leave can no longer be cancelled.');
      if (r.requestedById !== ctx.workerId) enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      noted('Write why it is cancelled.');
      store.tx(() => {
        transition(store, 'leave', id, 'CANCELLED', who, note);
        store.run('UPDATE leave_of_absence SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'LEAVE_CANCEL', personId, id, note);
      });
      break;
    }
    case 'depart': {
      need(['APPROVED'], 'This leave is not approved.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      noted('Write what was gone through before they left (conditions, medicines, contact).');
      store.tx(() => {
        transition(store, 'leave', id, 'AWAY', who, note);
        store.run('UPDATE leave_of_absence SET departed_by = ?, departed_at = ?, departure_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'LEAVE_DEPART', personId, id, note);
      });
      break;
    }
    case 'extend': {
      need(['AWAY'], 'They are not away on leave.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      const returnBy = when(b.returnBy);
      if (!returnBy || returnBy <= at) throw new HttpError(400, 'RETURN_BY_REQUIRED', 'Choose a new time in the future.');
      noted('Write why the leave is longer.');
      store.tx(() => {
        event('EXTENDED', returnBy);
        store.run('UPDATE leave_of_absence SET return_by = ? WHERE id = ?', returnBy, id);
        logged(store, ctx, 'LEAVE_EXTEND', personId, id, note);
      });
      break;
    }
    case 'contact': {
      need(['AWAY', 'NOT_RETURNED'], 'They are not away on leave.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      noted('Write who was contacted and what was said.');
      store.tx(() => { event('CONTACT'); logged(store, ctx, 'LEAVE_CONTACT', personId, id, note); });
      break;
    }
    case 'notReturned': {
      need(['AWAY'], 'They are not away on leave.');
      if (String(r.returnBy) >= at) throw new HttpError(409, 'NOT_DUE', 'They are not due back yet.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      noted('Write what has been done to find them and who has been told.');
      store.tx(() => {
        event('NOT_RETURNED');
        transition(store, 'leave', id, 'NOT_RETURNED', who, note);
        logged(store, ctx, 'LEAVE_NOT_RETURNED', personId, id, note);
      });
      break;
    }
    case 'return': {
      need(['AWAY', 'NOT_RETURNED'], 'They are not away on leave.');
      enforce(store, ctx, { op: 'LEAVE', personId, cap: 'leave.manage' }, personId);
      noted('Write how they are now they are back.');
      store.tx(() => {
        transition(store, 'leave', id, 'RETURNED', who, note);
        store.run('UPDATE leave_of_absence SET returned_by = ?, returned_at = ?, return_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'LEAVE_RETURN', personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with leave.');
  }
  return shape(store, ctx, load(store, id));
}

// Home → Leave and outings: everyone staying with this service who is away, going, or asking.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('leave.manage')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include leave`);
  }
  const order = "CASE l.state WHEN 'NOT_RETURNED' THEN 0 WHEN 'AWAY' THEN 1 WHEN 'REQUESTED' THEN 2 ELSE 3 END";
  const open = store.all<Row>(`${SELECT} WHERE l.service_id = ? AND l.state IN ${OPEN} ORDER BY ${order}, l.return_by, l.leave_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r));
  const recent = store.all<Row>(
    `${SELECT} WHERE l.service_id = ? AND l.state = 'RETURNED' AND l.returned_at >= ? ORDER BY l.returned_at DESC`, ctx.serviceId,
    new Date(Date.now() - 24 * 3600_000).toISOString(),
  ).map((r) => shape(store, ctx, r));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_LEAVE', decision: 'ALLOW', outcome: 'VIEWED' });
  return { leave: open, recent, options: options() };
}

// For the alert engine: people on leave from this service who are not back on time.
export function overdue(store: Store, serviceId: string) {
  return store.all<Row>(`${SELECT} WHERE l.service_id = ? AND (l.state = 'NOT_RETURNED' OR (l.state = 'AWAY' AND l.return_by < ?))`, serviceId, now())
    .map((r) => ({
      personId: String(r.personId), objectId: String(r.id),
      title: r.state === 'NOT_RETURNED' ? 'Not back from leave' : 'Late back from leave',
      detail: `${KINDS[String(r.kind)]}${r.destination ? ` to ${r.destination}` : ''}. Contact: ${r.contact}`,
    }));
}
