import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Communication (Shared Lifecycle Object 224):
//   communication required → intended recipient → method → attempted → successful or
//   unsuccessful → information conveyed → response → follow-up required / completed.
// An unanswered call is evidence too, so every attempt is kept. Telling whānau or another
// provider is a disclosure: SHIFT records the patient's view on sharing, and the HIPC
// rule 11 mapping remains a research requirement (RR-DISC-001), never an invented rule.

type Row = Record<string, string | number | null>;
const OPEN = "('REQUIRED', 'ATTEMPTED', 'FOLLOW_UP')";
const KINDS: Record<string, string> = { PATIENT: 'Patient', WHANAU: 'Whānau', EXTERNAL_PROVIDER: 'Another provider', TEAM: 'Our team or service' };
const METHODS: Record<string, string> = { PHONE: 'Phone', IN_PERSON: 'In person', VIDEO: 'Video', TEXT: 'Text message', EMAIL: 'Email', LETTER: 'Letter' };
const OUTCOMES: Record<string, string> = { CONVEYED: 'Got through', NO_ANSWER: 'No answer', LEFT_MESSAGE: 'Left a message', WRONG_CONTACT: 'Wrong contact details', NOT_AVAILABLE: 'Not available', DECLINED: 'Did not want to talk' };
const SHARING: Record<string, string> = { AGREED: 'Patient agreed', DECLINED: 'Patient declined', UNABLE: 'Patient unable to say', NOT_ASKED: 'Not asked' };
const DISCLOSURE = ['WHANAU', 'EXTERNAL_PROVIDER'];
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const SELECT = `
  SELECT c.id, c.state, c.purpose, c.recipient_kind AS recipientKind, c.recipient, c.contact, c.method, c.language, c.sharing, c.due_at AS dueAt,
         c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.service_id AS serviceId, s.name AS service, cb.display_name AS createdBy, c.created_at AS createdAt,
         c.conveyed, c.response, c.follow_up AS followUp, cp.display_name AS completedBy, c.completed_at AS completedAt, c.completion_note AS completionNote
    FROM communication c
    JOIN person p ON p.id = c.person_id
    JOIN service s ON s.id = c.service_id
    JOIN workforce_person cb ON cb.id = c.created_by
    LEFT JOIN workforce_person cp ON cp.id = c.completed_by`;

function localNow() {
  const d = new Date();
  return `${todayLocal(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function attempts(store: Store, id: string) {
  return store.all<{ at: string; by: string; method: string; outcome: string; note: string | null }>(
    `SELECT a.attempted_at AS at, w.display_name AS by, a.method, a.outcome, a.note FROM communication_attempt a
       JOIN workforce_person w ON w.id = a.attempted_by WHERE a.communication_id = ? ORDER BY a.attempted_at`, id,
  ).map((a) => ({ ...a, methodLabel: METHODS[a.method], outcomeLabel: OUTCOMES[a.outcome] }));
}

function shape(store: Store, ctx: WorkContext, c: Row) {
  const mine = evaluate(store, ctx, { op: 'COMMUNICATION_ACT', serviceId: String(c.serviceId) }).decision === 'ALLOW';
  const state = String(c.state);
  const actions: string[] = [];
  if (mine && (state === 'REQUIRED' || state === 'ATTEMPTED')) actions.push('attempt', 'cancel');
  if (mine && state === 'FOLLOW_UP') actions.push('complete');
  return {
    ...c, kindLabel: KINDS[String(c.recipientKind)], methodLabel: METHODS[String(c.method)], sharingLabel: c.sharing ? SHARING[String(c.sharing)] : null,
    disclosure: DISCLOSURE.includes(String(c.recipientKind)),
    overdue: Boolean(c.dueAt) && ['REQUIRED', 'ATTEMPTED'].includes(state) && String(c.dueAt) < localNow(),
    attempts: attempts(store, String(c.id)), actions, history: history(store, 'communication', String(c.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string, refs: string[] = ['ORG-SYN-001 v1']) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'communication', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: refs, engines: [42, 252],
  });
}

const options = { kinds: KINDS, methods: METHODS, outcomes: OUTCOMES, sharing: SHARING };

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(
    `${SELECT} WHERE c.person_id = ? AND (c.state IN ${OPEN} OR c.completed_at > datetime('now', '-14 days'))
      ORDER BY CASE WHEN c.state IN ${OPEN} THEN 0 ELSE 1 END, COALESCE(c.due_at, '9999'), c.created_at DESC`, personId,
  );
  const canCreate = evaluate(store, ctx, { op: 'COMMUNICATION', personId }).decision === 'ALLOW';
  return { communications: rows.map((r) => shape(store, ctx, r)), canCreate, options };
}

export function create(store: Store, ctx: WorkContext, personId: string, b: {
  purpose?: string; kind?: string; recipient?: string; contact?: string; method?: string; language?: string; sharing?: string; due?: string;
}) {
  enforce(store, ctx, { op: 'COMMUNICATION', personId }, personId);
  const purpose = (b.purpose ?? '').trim().slice(0, 1000);
  if (purpose.length < 5) throw new HttpError(400, 'PURPOSE_REQUIRED', 'Write what needs to be communicated.');
  const kind = String(b.kind);
  if (!KINDS[kind]) throw new HttpError(400, 'KIND_REQUIRED', 'Choose who it is for.');
  const recipient = (b.recipient ?? '').trim().slice(0, 120);
  if (recipient.length < 2) throw new HttpError(400, 'RECIPIENT_REQUIRED', 'Name who it is for.');
  const method = METHODS[String(b.method)] ? String(b.method) : 'PHONE';
  const disclosure = DISCLOSURE.includes(kind);
  const sharing = disclosure ? String(b.sharing) : null;
  if (disclosure && !SHARING[String(sharing)]) throw new HttpError(400, 'SHARING_REQUIRED', "Record the patient's view on sharing this information.");
  const due = WHEN.test(String(b.due)) ? String(b.due) : null;
  const id = newId();
  store.tx(() => {
    store.insert('communication', {
      id, person_id: personId, service_id: ctx.serviceId, purpose, recipient_kind: kind, recipient, contact: (b.contact ?? '').trim().slice(0, 120) || null,
      method, language: (b.language ?? '').trim().slice(0, 60) || null, sharing, due_at: due, state: 'REQUIRED', created_by: ctx.workerId, created_at: now(),
    });
    recordInitial(store, 'communication', id, 'REQUIRED', { actorId: ctx.workerId, workContextId: ctx.id }, `${KINDS[kind]}: ${recipient}`);
    logged(store, ctx, 'COMMUNICATION_REQUIRED', personId, id, `${KINDS[kind]}: ${recipient}`, disclosure ? ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-DISC-001'] : undefined);
  });
  return { id };
}

const load = (store: Store, id: string) => {
  const c = store.get<Row>(`${SELECT} WHERE c.id = ?`, id);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'That communication no longer exists.');
  return c;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: {
  outcome?: string; method?: string; note?: string; conveyed?: string; response?: string; followUp?: string;
}) {
  const c = load(store, id);
  const personId = String(c.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  enforce(store, ctx, { op: 'COMMUNICATION_ACT', serviceId: String(c.serviceId) }, personId);
  const note = b.note?.trim().slice(0, 1000) || '';
  store.tx(() => {
    switch (action) {
      case 'attempt': {
        const outcome = String(b.outcome);
        if (!OUTCOMES[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what happened.');
        const method = METHODS[String(b.method)] ? String(b.method) : String(c.method);
        store.insert('communication_attempt', { id: newId(), communication_id: id, attempted_by: ctx.workerId, attempted_at: now(), method, outcome, note: note || null });
        if (outcome !== 'CONVEYED') {
          transition(store, 'communication', id, 'ATTEMPTED', who, `${OUTCOMES[outcome]}${note ? `: ${note}` : ''}`);
          break;
        }
        // Getting through is not the end: what was conveyed and how they responded are
        // recorded, and any follow-up keeps the communication open.
        const conveyed = (b.conveyed ?? '').trim().slice(0, 2000);
        if (conveyed.length < 5) throw new HttpError(400, 'CONVEYED_REQUIRED', 'Record what you told them.');
        const response = (b.response ?? '').trim().slice(0, 2000) || null;
        const followUp = (b.followUp ?? '').trim().slice(0, 1000) || null;
        transition(store, 'communication', id, 'CONVEYED', who, `${METHODS[method]}`);
        store.run('UPDATE communication SET conveyed = ?, response = ?, follow_up = ? WHERE id = ?', conveyed, response, followUp, id);
        if (followUp) transition(store, 'communication', id, 'FOLLOW_UP', who, followUp);
        else {
          transition(store, 'communication', id, 'COMPLETED', who);
          store.run('UPDATE communication SET completed_by = ?, completed_at = ? WHERE id = ?', ctx.workerId, now(), id);
        }
        break;
      }
      case 'complete':
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Record what was done about the follow-up.');
        transition(store, 'communication', id, 'COMPLETED', who, note);
        store.run('UPDATE communication SET completed_by = ?, completed_at = ?, completion_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      case 'cancel':
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Give the reason it is no longer needed.');
        transition(store, 'communication', id, 'CANCELLED', who, note);
        store.run('UPDATE communication SET completed_by = ?, completed_at = ?, completion_note = ? WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `COMMUNICATION_${action.toUpperCase()}`, personId, id, note || b.outcome || undefined,
      DISCLOSURE.includes(String(c.recipientKind)) ? ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-DISC-001'] : undefined);
  });
  return shape(store, ctx, load(store, id));
}

// This service's communications still to make or follow up, and those finished today.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('communication.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include communications`);
  const rows = store.all<Row>(
    `${SELECT} WHERE c.service_id = ? AND (c.state IN ${OPEN} OR c.completed_at > datetime('now', '-1 day'))
      ORDER BY CASE WHEN c.state IN ${OPEN} THEN 0 ELSE 1 END, COALESCE(c.due_at, '9999'), c.created_at`,
    ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_COMMUNICATIONS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42, 252] });
  return { communications: rows.map((r) => shape(store, ctx, r)), options };
}
