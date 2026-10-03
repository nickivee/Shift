import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, KIND, WHO, DECISION, DECISIONS_FOR, REFS } from '../config/privacy.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Consumer access, correction and disclosure requests (entries 29, 30, 31):
//   received → identity (and authority) checked → decided with reasons → answer sent → closed.
// The privacy officer sees the request and who it is about, not the clinical record. When a
// correction is not made, the person's statement stays with the record where clinicians see it.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const mayManage = (ctx: WorkContext) => (ctx.role.capabilities as string[]).includes('privacy.manage');

const Q = `
  SELECT r.id, r.organisation_id AS organisationId, r.state, r.kind, r.person_id AS personId, p.given_name || ' ' || p.family_name AS person,
         (SELECT value FROM external_identifier WHERE person_id = r.person_id AND system = 'NHI') AS nhi,
         r.who, r.requester_name AS requester, r.asked, r.received_on AS receivedOn, r.due_on AS dueOn,
         r.identity_check AS identityCheck, r.authority_check AS authorityCheck, cb.display_name AS checkedBy, r.checked_at AS checkedAt,
         r.decision, r.decision_note AS decisionNote, r.statement, db.display_name AS decidedBy, r.decided_at AS decidedAt,
         r.sent_note AS sentNote, sb.display_name AS closedBy, r.closed_at AS closedAt, r.withdrawn_note AS withdrawnNote,
         lb.display_name AS loggedBy, r.logged_at AS loggedAt
    FROM privacy_request r
    JOIN person p ON p.id = r.person_id
    JOIN workforce_person lb ON lb.id = r.logged_by
    LEFT JOIN workforce_person cb ON cb.id = r.checked_by
    LEFT JOIN workforce_person db ON db.id = r.decided_by
    LEFT JOIN workforce_person sb ON sb.id = r.closed_by`;

const today = () => new Date().toISOString().slice(0, 10);
const shape = (r: Row): Record<string, any> => {
  const open = ['RECEIVED', 'CHECKED', 'DECIDED'].includes(String(r.state));
  const actions = r.state === 'RECEIVED' ? ['check', 'withdraw'] : r.state === 'CHECKED' ? ['decide', 'withdraw'] : r.state === 'DECIDED' ? ['send'] : [];
  return {
    ...r, stateLabel: STATES[String(r.state)], kindLabel: KIND[String(r.kind)], whoLabel: WHO[String(r.who)],
    decisionLabel: r.decision ? DECISION[String(r.decision)] : null,
    overdue: open && !!r.dueOn && String(r.dueOn) < today(), actions,
    decisions: (DECISIONS_FOR[String(r.kind)] ?? []).map((d) => [d, DECISION[d]]),
  };
};

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'privacy_request', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}

// Home → Privacy requests.
export function list(store: Store, ctx: WorkContext) {
  if (!mayManage(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include privacy requests`);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const rows = (where: string, ...a: unknown[]) => store.all<Row>(`${Q} WHERE r.organisation_id = ? AND ${where}`, ctx.organisationId, ...a).map(shape);
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PRIVACY_REQUESTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toCheck: rows("r.state = 'RECEIVED' ORDER BY COALESCE(r.due_on, '9999'), r.received_on"),
    toDecide: rows("r.state = 'CHECKED' ORDER BY COALESCE(r.due_on, '9999'), r.received_on"),
    toSend: rows("r.state = 'DECIDED' ORDER BY COALESCE(r.due_on, '9999'), r.received_on"),
    closed: rows("r.state IN ('CLOSED', 'WITHDRAWN') AND COALESCE(r.closed_at, r.withdrawn_at) >= ? ORDER BY COALESCE(r.closed_at, r.withdrawn_at) DESC", since),
    options: { kind: KIND, who: WHO },
  };
}

// For the record header: statements the person asked to keep with their record.
export function statements(store: Store, personId: string) {
  return store.all<Row>(
    "SELECT statement, decided_at AS at FROM privacy_request WHERE person_id = ? AND kind = 'CORRECTION' AND decision = 'NOT_CORRECTED' AND state IN ('DECIDED', 'CLOSED') AND statement IS NOT NULL ORDER BY decided_at",
    personId);
}

interface Body {
  nhi?: string; kind?: string; who?: string; requester?: string; asked?: string; receivedOn?: string; dueOn?: string;
  identity?: string; authority?: string; decision?: string; note?: string; statement?: string;
}

const day = (v: unknown, label: string, future: boolean) => {
  const s = text(v, 10);
  if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, 'DATE', `Choose the ${label}.`);
  if (!future && s > today()) throw new HttpError(400, 'DATE', `The ${label} cannot be in the future.`);
  return s;
};

export function log(store: Store, ctx: WorkContext, b: Body) {
  if (!mayManage(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include privacy requests`);
  enforce(store, ctx, { op: 'PRIVACY', organisationId: ctx.organisationId });
  const nhi = text(b.nhi, 20).toUpperCase().replace(/\s/g, '');
  const person = nhi && store.get<{ id: string }>("SELECT person_id AS id FROM external_identifier WHERE system = 'NHI' AND value = ?", nhi);
  if (!nhi) throw new HttpError(400, 'NHI_REQUIRED', 'Write the NHI of the person the information is about.');
  if (!person) throw new HttpError(404, 'NOT_FOUND', 'No one in SHIFT has that NHI. Check it with the person.');
  const kind = KIND[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what is being asked for.');
  const who = WHO[String(b.who)] ? String(b.who) : '';
  if (!who) throw new HttpError(400, 'WHO_REQUIRED', 'Choose who is asking.');
  const requester = text(b.requester, 120);
  if (who !== 'SELF' && requester.length < 2) throw new HttpError(400, 'REQUESTER_REQUIRED', 'Write who is asking and, if they are acting for the person, how they are connected.');
  const asked = text(b.asked);
  if (asked.length < 5) throw new HttpError(400, 'ASKED_REQUIRED', 'Write what they asked for, in their words if you can.');
  const receivedOn = day(b.receivedOn, 'date it was received', false);
  const dueOn = text(b.dueOn) ? day(b.dueOn, 'date the answer is due', true) : null;
  if (dueOn && dueOn < receivedOn) throw new HttpError(400, 'DATE', 'The answer cannot be due before it was received.');
  const id = newId();
  store.tx(() => {
    store.insert('privacy_request', {
      id, organisation_id: ctx.organisationId, person_id: person.id, kind, who, requester_name: requester || null, asked, received_on: receivedOn, due_on: dueOn,
      state: 'RECEIVED', logged_by: ctx.workerId, logged_at: now(),
    });
    recordInitial(store, 'privacy_request', id, 'RECEIVED', { actorId: ctx.workerId, workContextId: ctx.id }, asked);
    logged(store, ctx, 'PRIVACY_REQUEST_LOG', person.id, id, `${KIND[kind]}: ${asked}`);
  });
  return list(store, ctx);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  if (!mayManage(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include privacy requests`);
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That request is no longer in SHIFT.');
  enforce(store, ctx, { op: 'PRIVACY', organisationId: String(r.organisationId) });
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const wrong = (msg: string) => { throw new HttpError(409, 'WRONG_STATE', msg); };
  store.tx(() => {
    switch (action) {
      case 'check': {
        if (r.state !== 'RECEIVED') wrong('This request has already been checked.');
        const identity = text(b.identity);
        if (identity.length < 5) throw new HttpError(400, 'IDENTITY_REQUIRED', 'Say how you confirmed who is asking, e.g. "Photo ID seen at reception".');
        const authority = text(b.authority);
        if (r.who !== 'SELF' && authority.length < 5) throw new HttpError(400, 'AUTHORITY_REQUIRED', 'Say what shows they may ask for this on the person\'s behalf, e.g. "Signed authority from Mrs Ngata, 2 Oct".');
        transition(store, 'privacy_request', id, 'CHECKED', who, identity.slice(0, 160));
        store.run('UPDATE privacy_request SET identity_check = ?, authority_check = ?, checked_by = ?, checked_at = ? WHERE id = ?', identity, authority || null, ctx.workerId, now(), id);
        logged(store, ctx, 'PRIVACY_REQUEST_CHECK', personId, id, identity);
        break;
      }
      case 'decide': {
        if (r.state !== 'CHECKED') wrong(r.state === 'RECEIVED' ? 'Check who is asking first.' : 'This request has already been decided.');
        const decision = (DECISIONS_FOR[String(r.kind)] ?? []).includes(String(b.decision)) ? String(b.decision) : '';
        if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose what has been decided.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', decision === 'REFUSED' || decision === 'PARTLY' ? 'Say what is being held back and why.' : 'Say what is being done, e.g. what is being sent or what was changed.');
        const statement = text(b.statement);
        if (decision === 'NOT_CORRECTED' && statement.length < 5) throw new HttpError(400, 'STATEMENT_REQUIRED', 'Write the person\'s statement of what they say is wrong, to keep with their record.');
        transition(store, 'privacy_request', id, 'DECIDED', who, `${DECISION[decision]}: ${note.slice(0, 140)}`);
        store.run('UPDATE privacy_request SET decision = ?, decision_note = ?, statement = ?, decided_by = ?, decided_at = ? WHERE id = ?',
          decision, note, decision === 'NOT_CORRECTED' ? statement : null, ctx.workerId, now(), id);
        logged(store, ctx, 'PRIVACY_REQUEST_DECIDE', personId, id, `${DECISION[decision]}: ${note}`);
        break;
      }
      case 'send': {
        if (r.state !== 'DECIDED') wrong('Decide the request before closing it.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say what was sent and how, e.g. "Copy posted to the person, signed for".');
        transition(store, 'privacy_request', id, 'CLOSED', who, note.slice(0, 160));
        store.run('UPDATE privacy_request SET sent_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        logged(store, ctx, 'PRIVACY_REQUEST_SEND', personId, id, note);
        break;
      }
      case 'withdraw': {
        if (!['RECEIVED', 'CHECKED'].includes(String(r.state))) wrong('Only a request that has not been decided can be withdrawn.');
        if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why it is withdrawn, e.g. "Person no longer wants it".');
        transition(store, 'privacy_request', id, 'WITHDRAWN', who, note.slice(0, 160));
        store.run('UPDATE privacy_request SET withdrawn_note = ?, withdrawn_at = ? WHERE id = ?', note, now(), id);
        logged(store, ctx, 'PRIVACY_REQUEST_WITHDRAW', personId, id, note);
        break;
      }
      default: throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return list(store, ctx);
}
