import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { relationship } from './authority.ts';
import { KINDS, CONSENT, OUTCOMES } from '../config/breakglass.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { VIEW_BY_CODE } from '../config/keys.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Break-Glass / Exceptional Access (Cross-System Capability 307):
//   access unavailable under ordinary authority → exceptional clinical need → authorised
//   exceptional-access pathway → reason → required approval/context → time-limited access →
//   activity audit → review.
// A clinician with no care relationship can still open a record when care needs it. What is
// needed depends on the pathway: an emergency opens at once; a person in front of them needs
// their agreement recorded, or why they cannot give it; anything else needs a named senior to
// approve first. Access ends on its own. Everything done under it is listed from the audit
// trail, and a senior in the clinician's service reviews every use.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  REQUESTED: 'Waiting for approval', ACTIVE: 'Open', DECLINED: 'Not approved', WITHDRAWN: 'Withdrawn', ENDED: 'Ended, to review', REVIEWED: 'Reviewed',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'RR-BREAKGLASS-001'];
const LOG_LABELS: Record<string, string> = {
  REQUESTED: 'Asked for approval', OPENED: 'Access opened', APPROVED: 'Approved', DECLINED: 'Not approved', WITHDRAWN: 'Withdrawn',
  ENDED: 'Access ended', EXPIRED: 'Time limit reached', REVIEWED: 'Reviewed',
};

const Q = `
  SELECT x.id, x.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, x.workforce_person_id AS workerId,
         w.display_name AS worker, x.service_id AS serviceId, s.name AS service, x.kind, x.consent, x.reason, x.state,
         x.granted_at AS requestedAt, x.expires_at AS expiresAt, x.work_context_id AS workContextId,
         x.approver_id AS approverId, ab.display_name AS approver, x.decided_at AS decidedAt, x.decided_note AS decidedNote,
         x.ended_at AS endedAt, eb.display_name AS endedBy, x.ended_note AS endedNote,
         rb.display_name AS reviewedBy, x.reviewed_at AS reviewedAt, x.review_outcome AS reviewOutcome, x.review_note AS reviewNote
    FROM exceptional_access x
    JOIN person p ON p.id = x.person_id
    JOIN workforce_person w ON w.id = x.workforce_person_id
    LEFT JOIN service s ON s.id = x.service_id
    LEFT JOIN workforce_person ab ON ab.id = x.approver_id
    LEFT JOIN workforce_person eb ON eb.id = x.ended_by
    LEFT JOIN workforce_person rb ON rb.id = x.review_by`;

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const canApprove = (ctx: WorkContext) => ctx.role.capabilities.includes('access.approve');
const log = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('exceptional_access_log', { id: newId(), access_id: id, kind, body, by_id: by, at: now() });
function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'exceptional_access', objectId: id, purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [26],
  });
}
const plus = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false });

// Access that has passed its time limit ends; nobody has to remember to close it.
function sweep(store: Store) {
  const due = store.all<{ id: string; w: string; e: string }>("SELECT id, workforce_person_id AS w, expires_at AS e FROM exceptional_access WHERE state = 'ACTIVE' AND expires_at <= ?", now());
  for (const r of due) {
    store.tx(() => {
      transition(store, 'exceptional_access', r.id, 'ENDED', { actorId: r.w, workContextId: null as unknown as string }, 'Time limit reached');
      store.run('UPDATE exceptional_access SET ended_at = ? WHERE id = ?', r.e, r.id);
      store.insert('exceptional_access_log', { id: newId(), access_id: r.id, kind: 'EXPIRED', body: 'Access closed at the end of its time limit.', by_id: r.w, at: r.e });
    });
  }
}

// Seniors who can approve: anyone in the worker's service whose role approves exceptional access.
export function approvers(store: Store, ctx: WorkContext) {
  const rows = store.all<{ id: string; name: string; role: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name, p.role_key AS role FROM position p
       JOIN employment e ON e.id = p.employment_id JOIN workforce_person w ON w.id = e.workforce_person_id
      WHERE p.service_id = ? AND w.id != ? AND w.status = 'ACTIVE' AND (p.end_date IS NULL OR p.end_date >= date('now'))`,
    ctx.serviceId, ctx.workerId,
  );
  const seen = new Set<string>();
  return rows.filter((r) => ROLE_BY_KEY.get(r.role)?.capabilities.includes('access.approve') && !seen.has(r.id) && seen.add(r.id))
    .map(({ id, name }) => ({ id, name }));
}

// Everything the worker did on this record while access was open, straight from the audit trail.
function activity(store: Store, r: Row) {
  const from = String(r.decidedAt ?? r.requestedAt);
  const to = String(r.endedAt ?? r.expiresAt);
  return store.all<Row>(
    `SELECT at, operation, object_type AS objectType, outcome, reason FROM audit_event
      WHERE actor_id = ? AND subject_person_id = ? AND at >= ? AND at <= ? AND operation NOT LIKE 'BREAK_GLASS%' ORDER BY seq LIMIT 200`,
    r.workerId, r.personId, from, to,
  ).map((a) => {
    const op = String(a.operation);
    const obj = String(a.objectType ?? '');
    const label = op === 'VIEW_RECORD' ? 'Opened the record'
      : op === 'RETRIEVE' && obj.startsWith('?') ? `Looked at ${VIEW_BY_CODE.get(obj.slice(1))?.label ?? obj.slice(1)}`
      : `${op.toLowerCase().replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())}${obj ? ` (${obj.replaceAll('_', ' ')})` : ''}`;
    return { ...a, label: a.outcome === 'BLOCKED' ? `${label}: refused` : label };
  });
}

function shape(store: Store, ctx: WorkContext, r: Row, forReview: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const actions: string[] = [];
  const mine = r.workerId === ctx.workerId;
  if (state === 'REQUESTED' && r.approverId === ctx.workerId) actions.push('approve', 'decline');
  if (state === 'REQUESTED' && mine) actions.push('withdraw');
  if (state === 'ACTIVE' && mine) actions.push('end');
  if (state === 'ENDED' && !mine && canApprove(ctx) && ctx.serviceId === r.serviceId) actions.push('review');
  const { workContextId: _w, ...rest } = r;
  return {
    ...rest, id, state, stateLabel: STATES[state], kindLabel: KINDS[String(r.kind)]?.label ?? String(r.kind),
    consentLabel: r.consent ? CONSENT[String(r.consent)] : null, outcomeLabel: r.reviewOutcome ? OUTCOMES[String(r.reviewOutcome)] : null,
    actions,
    activity: forReview || state === 'REVIEWED' || state === 'ENDED' ? activity(store, r) : [],
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM exceptional_access_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.access_id = ? ORDER BY l.at, l.rowid', id)
      .map((l) => ({ ...l, kindLabel: LOG_LABELS[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'exceptional_access', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE x.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That access request is no longer in SHIFT.');
  return r;
};

// Ask for break-glass access to a record the worker has no care relationship with.
export function request(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; reason?: string; consent?: string; approverId?: string }) {
  sweep(store);
  if (!ctx.role.capabilities.includes('record.view') || !ctx.role.profession) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot use break-glass access`);
  if (!ctx.authority?.current) throw new HttpError(403, 'BLOCK', `Break-glass access needs a current ${ctx.role.profession} practising authority`);
  if (!store.get('SELECT 1 FROM person WHERE id = ? AND merged_into IS NULL', personId)) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const rel = relationship(store, ctx, personId);
  if (rel) throw new HttpError(409, 'NOT_NEEDED', 'You already have access to this record through your care of them. Open it directly.');
  if (store.get("SELECT 1 FROM exceptional_access WHERE workforce_person_id = ? AND person_id = ? AND state = 'REQUESTED'", ctx.workerId, personId)) {
    throw new HttpError(409, 'ALREADY_ASKED', 'You have already asked for access to this record. Wait for the answer, or withdraw it.');
  }
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose why you need access.');
  const reason = text(b.reason);
  if (reason.length < 10) throw new HttpError(400, 'REASON_REQUIRED', 'Say what you need the record for, e.g. "Unconscious in ED, need allergies and medicines".');
  let consent: string | null = null;
  let approver: { id: string; name: string } | undefined;
  if (kind === 'PRESENT') {
    consent = CONSENT[String(b.consent)] ? String(b.consent) : '';
    if (!consent) throw new HttpError(400, 'CONSENT_REQUIRED', 'Say whether the person agreed to you looking at their record.');
    if (consent === 'DECLINED') throw new HttpError(409, 'DECLINED', 'The person has said no. Only an emergency can override that; if it is one, choose Emergency.');
  }
  if (kind === 'APPROVAL') {
    approver = approvers(store, ctx).find((a) => a.id === String(b.approverId ?? ''));
    if (!approver) throw new HttpError(400, 'APPROVER_REQUIRED', 'Choose the senior clinician who will approve this.');
  }
  const id = newId();
  const at = now();
  const open = kind !== 'APPROVAL';
  store.tx(() => {
    store.insert('exceptional_access', {
      id, work_context_id: ctx.id, workforce_person_id: ctx.workerId, person_id: personId, reason, granted_at: at,
      expires_at: open ? plus(KINDS[kind].minutes) : at, kind, consent, service_id: ctx.serviceId, state: open ? 'ACTIVE' : 'REQUESTED',
      approver_id: approver?.id ?? null, decided_at: open ? at : null,
    });
    recordInitial(store, 'exceptional_access', id, open ? 'ACTIVE' : 'REQUESTED', { actorId: ctx.workerId, workContextId: ctx.id }, reason.slice(0, 200));
    if (open) log(store, id, 'OPENED', `${KINDS[kind].label}. ${reason}${consent ? ` ${CONSENT[consent]}.` : ''} Open for ${KINDS[kind].minutes} minutes.`, ctx.workerId);
    else log(store, id, 'REQUESTED', `${reason} Asked ${approver!.name} to approve.`, ctx.workerId);
    logged(store, ctx, open ? 'BREAK_GLASS_OPEN' : 'BREAK_GLASS_REQUEST', personId, id, reason.slice(0, 200));
  });
  return { id, state: open ? 'ACTIVE' : 'REQUESTED', expiresAt: open ? plus(KINDS[kind].minutes) : null, approver: approver?.name ?? null };
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; outcome?: string }) {
  sweep(store);
  const r = load(store, id);
  const state = String(r.state);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const at = now();
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const wrong = () => new HttpError(409, 'WRONG_STATE', `This access is ${STATES[state].toLowerCase()}.`);
  switch (action) {
    case 'approve':
    case 'decline': {
      if (r.approverId !== ctx.workerId) throw new HttpError(403, 'BLOCK', `This request was sent to ${r.approver}.`);
      if (state !== 'REQUESTED') throw wrong();
      if (action === 'decline') need(5, 'Say why not, so they know what to do instead.');
      const minutes = KINDS[String(r.kind)].minutes;
      store.tx(() => {
        transition(store, 'exceptional_access', id, action === 'approve' ? 'ACTIVE' : 'DECLINED', who, note.slice(0, 200) || undefined);
        store.run('UPDATE exceptional_access SET decided_at = ?, decided_note = ?, expires_at = ? WHERE id = ?', at, note || null, action === 'approve' ? plus(minutes) : at, id);
        log(store, id, action === 'approve' ? 'APPROVED' : 'DECLINED', action === 'approve' ? `Open for ${minutes} minutes.${note ? ` ${note}` : ''}` : note, ctx.workerId);
        logged(store, ctx, action === 'approve' ? 'BREAK_GLASS_APPROVE' : 'BREAK_GLASS_DECLINE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'withdraw':
    case 'end': {
      if (r.workerId !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who asked can do that.');
      if (state !== (action === 'end' ? 'ACTIVE' : 'REQUESTED')) throw wrong();
      store.tx(() => {
        transition(store, 'exceptional_access', id, action === 'end' ? 'ENDED' : 'WITHDRAWN', who, note.slice(0, 200) || undefined);
        store.run('UPDATE exceptional_access SET ended_at = ?, ended_by = ?, ended_note = ?, expires_at = ? WHERE id = ?', at, ctx.workerId, note || null, at, id);
        log(store, id, action === 'end' ? 'ENDED' : 'WITHDRAWN', note || (action === 'end' ? 'Ended before the time limit.' : 'No longer needed.'), ctx.workerId);
        logged(store, ctx, action === 'end' ? 'BREAK_GLASS_END' : 'BREAK_GLASS_WITHDRAW', personId, id);
      });
      break;
    }
    case 'review': {
      if (state !== 'ENDED') throw wrong();
      if (r.workerId === ctx.workerId) throw new HttpError(403, 'BLOCK', 'Someone else must review your own break-glass access.');
      if (!canApprove(ctx) || ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `A senior clinician in ${r.service} reviews this.`);
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome of your review.');
      if (outcome !== 'APPROPRIATE') need(10, 'Say what was not right, and what happens next.');
      store.tx(() => {
        transition(store, 'exceptional_access', id, 'REVIEWED', who, OUTCOMES[outcome]);
        store.run('UPDATE exceptional_access SET review_by = ?, reviewed_at = ?, review_outcome = ?, review_note = ? WHERE id = ?', ctx.workerId, at, outcome, note || null, id);
        log(store, id, 'REVIEWED', `${OUTCOMES[outcome]}.${note ? ` ${note}` : ''}${outcome === 'INAPPROPRIATE' ? ' Report it as a privacy incident.' : ''}`, ctx.workerId);
        logged(store, ctx, 'BREAK_GLASS_REVIEW', personId, id, outcome);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, ctx, load(store, id), true);
}

// For the record header: the worker's own open access to this record, and when it ends.
export function current(store: Store, ctx: WorkContext, personId: string) {
  sweep(store);
  const r = store.get<Row>("SELECT id, kind, expires_at AS expiresAt FROM exceptional_access WHERE workforce_person_id = ? AND service_id = ? AND person_id = ? AND state = 'ACTIVE' ORDER BY expires_at DESC LIMIT 1", ctx.workerId, ctx.serviceId, personId);
  return r ? { ...r, kindLabel: KINDS[String(r.kind)]?.label ?? '', until: time(String(r.expiresAt)) } : null;
}

// For search results: a request of the worker's that is waiting.
export function pending(store: Store, ctx: WorkContext, personId: string) {
  return store.get<Row>("SELECT x.id, w.display_name AS approver FROM exceptional_access x JOIN workforce_person w ON w.id = x.approver_id WHERE x.workforce_person_id = ? AND x.person_id = ? AND x.state = 'REQUESTED'", ctx.workerId, personId) ?? null;
}

export function options(store: Store, ctx: WorkContext) {
  return { kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v])), consent: CONSENT, approvers: approvers(store, ctx) };
}

// Home → Break-glass access: requests to approve, uses to review, and the worker's own.
export function list(store: Store, ctx: WorkContext) {
  sweep(store);
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const toApprove = store.all<Row>(`${Q} WHERE x.approver_id = ? AND x.state = 'REQUESTED' ORDER BY x.granted_at`, ctx.workerId).map((r) => shape(store, ctx, r, false));
  const toReview = canApprove(ctx)
    ? store.all<Row>(`${Q} WHERE x.service_id = ? AND x.state = 'ENDED' AND x.workforce_person_id != ? ORDER BY x.ended_at`, ctx.serviceId, ctx.workerId).map((r) => shape(store, ctx, r, true))
    : [];
  const reviewed = canApprove(ctx)
    ? store.all<Row>(`${Q} WHERE x.service_id = ? AND x.state = 'REVIEWED' AND x.reviewed_at >= ? ORDER BY x.reviewed_at DESC`, ctx.serviceId, since).map((r) => shape(store, ctx, r, true))
    : [];
  const mine = store.all<Row>(`${Q} WHERE x.workforce_person_id = ? AND x.granted_at >= ? ORDER BY x.granted_at DESC`, ctx.workerId, since).map((r) => shape(store, ctx, r, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_BREAK_GLASS', decision: 'ALLOW', outcome: 'VIEWED' });
  return { toApprove, toReview, reviewed, mine, canApprove: canApprove(ctx), outcomes: OUTCOMES };
}
