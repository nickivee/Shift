import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Clinical restriction / precaution (Shared Lifecycle Object 243):
//   clinical need identified → authorised restriction → parameters → effective time →
//   communication → implementation → review → modification / cessation.
// A restriction belongs to the person, so every service caring for them sees it on the record.
// Who may authorise each kind is organisational configuration (ORG-SYN-001), not law. When the
// person proposing it may not authorise it, it waits as a proposal. Restraint and anything else
// that limits a person's freedom of movement without their agreement is a research
// requirement (RR-RESTRAINT-001) and is not recorded here.

type Row = Record<string, string | number | null>;
const MP = 'Medical Practitioner';
const RN = 'Registered Nurse';
const PT = 'Physiotherapist';
export const KINDS: Record<string, { label: string; side: boolean; authorisers: string[] }> = {
  NBM: { label: 'Nil by mouth', side: false, authorisers: [MP] },
  FLUIDS: { label: 'Fluid restriction', side: false, authorisers: [MP] },
  WEIGHT_BEARING: { label: 'Weight-bearing limit', side: true, authorisers: [MP, PT] },
  LIMB: { label: 'Limb precaution', side: true, authorisers: [MP, RN] },
  SPINAL: { label: 'Spinal or positioning precaution', side: false, authorisers: [MP, PT] },
  ACTIVITY: { label: 'Bed rest or activity limit', side: false, authorisers: [MP, PT] },
  OTHER: { label: 'Other precaution', side: false, authorisers: [MP, RN, PT] },
};
const SIDES: Record<string, string> = { LEFT: 'Left', RIGHT: 'Right', BOTH: 'Both sides' };
const VIEWS: Record<string, string> = {
  AGREED: 'Discussed and agreed', NOT_AGREED: 'Discussed, not agreed', UNABLE: 'Not able to discuss', NOT_YET: 'Not discussed yet',
};
const OUTCOMES: Record<string, string> = { CONTINUE: 'Continue', CHANGED: 'Changed', STOPPED: 'Stopped' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002'];

const SELECT = `
  SELECT r.id, r.state, r.kind, r.side, r.detail, r.instructions, r.reason, r.patient_view AS patientView,
         r.effective_from AS effectiveFrom, r.effective_until AS effectiveUntil, r.review_date AS reviewDate,
         r.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         r.service_id AS serviceId, s.name AS service, pb.display_name AS proposedBy, r.proposed_by AS proposedById, r.proposed_at AS proposedAt,
         ab.display_name AS authorisedBy, r.authorised_at AS authorisedAt, r.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, r.closed_at AS closedAt, r.close_reason AS closeReason
    FROM restriction r
    JOIN person p ON p.id = r.person_id
    JOIN service s ON s.id = r.service_id
    JOIN workforce_person pb ON pb.id = r.proposed_by
    LEFT JOIN workforce_person ab ON ab.id = r.authorised_by
    LEFT JOIN workforce_person cb ON cb.id = r.closed_by`;

const label = (r: Row) => `${KINDS[String(r.kind)].label}${r.side ? ` (${SIDES[String(r.side)].toLowerCase()})` : ''}`;

// A restriction set to end at a time ends then, without anyone having to remember.
function expire(store: Store) {
  for (const r of store.all<{ id: string }>("SELECT id FROM restriction WHERE state = 'ACTIVE' AND effective_until IS NOT NULL AND effective_until <= ?", now())) {
    store.tx(() => {
      transition(store, 'restriction', r.id, 'CEASED', { actorId: null, workContextId: null }, 'Ended at the time set');
      store.run('UPDATE restriction SET closed_at = effective_until, close_reason = ? WHERE id = ?', 'Ended at the time set', r.id);
    });
  }
}

// May this worker authorise, change or stop this kind? Their profession must be one the
// organisation allows for it, their practising authority current, and their service caring
// for the person.
function mayAuthorise(store: Store, ctx: WorkContext, kind: string, personId: string) {
  return !!ctx.authority?.current && KINDS[kind].authorisers.includes(ctx.authority.profession)
    && evaluate(store, ctx, { op: 'RESTRICTION', personId }).decision === 'ALLOW';
}

function shape(store: Store, ctx: WorkContext, r: Row) {
  const id = String(r.id);
  const personId = String(r.personId);
  const kind = KINDS[String(r.kind)];
  const acks = store.all<{ by: string; at: string; workerId: string }>(
    `SELECT w.display_name AS by, a.at, a.worker_id AS workerId FROM restriction_ack a JOIN workforce_person w ON w.id = a.worker_id
      WHERE a.restriction_id = ? ORDER BY a.at`, id,
  );
  const checks = store.all<Row>(
    `SELECT c.checked_at AS at, w.display_name AS by, c.followed, c.note FROM restriction_check c JOIN workforce_person w ON w.id = c.checked_by
      WHERE c.restriction_id = ? ORDER BY c.checked_at DESC LIMIT 5`, id,
  );
  const reviews: Row[] = [];
  for (let at: string | null = id, guard = 0; at && guard < 20; guard++) {
    reviews.push(...store.all<Row>(
      `SELECT v.reviewed_at AS at, w.display_name AS by, v.outcome, v.finding FROM restriction_review v
         JOIN workforce_person w ON w.id = v.reviewed_by WHERE v.restriction_id = ? ORDER BY v.reviewed_at DESC`, at,
    ));
    at = store.get<{ s: string | null }>('SELECT supersedes_id AS s FROM restriction WHERE id = ?', at)?.s ?? null;
  }
  const active = r.state === 'ACTIVE';
  const started = active && String(r.effectiveFrom) <= now();
  const manage = evaluate(store, ctx, { op: 'RESTRICTION', personId }).decision === 'ALLOW';
  const check = evaluate(store, ctx, { op: 'RESTRICTION_CHECK', personId }).decision === 'ALLOW';
  const authorise = mayAuthorise(store, ctx, String(r.kind), personId);
  const read = acks.some((a) => a.workerId === ctx.workerId);
  const actions: string[] = [];
  if (r.state === 'PROPOSED' && authorise) actions.push('authorise');
  if (r.state === 'PROPOSED' && (authorise || r.proposedById === ctx.workerId)) actions.push('decline');
  if (active && check && !read) actions.push('read');
  if (started && check) actions.push('check');
  if (active && manage) actions.push('review');
  return {
    ...r, label: label(r), kindLabel: kind.label, sideLabel: r.side ? SIDES[String(r.side)] : null, patientViewLabel: VIEWS[String(r.patientView)],
    status: r.state === 'PROPOSED' ? 'PROPOSED' : active ? (started ? 'CURRENT' : 'UPCOMING') : String(r.state),
    reviewDue: active && !!r.reviewDate && String(r.reviewDate) <= todayLocal(),
    authorisers: kind.authorisers, canChange: active && authorise,
    acks: acks.map(({ by, at }) => ({ by, at })), read, checks: checks.map((c) => ({ ...c, followed: !!c.followed })),
    reviews: reviews.map((v) => ({ ...v, outcomeLabel: OUTCOMES[String(v.outcome)] })),
    actions, history: history(store, 'restriction', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'restriction', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [42],
  });
}

const options = () => ({
  kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, side: v.side, authorisers: v.authorisers }])),
  sides: SIDES, views: VIEWS, outcomes: OUTCOMES,
});

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  expire(store);
  const open = store.all<Row>(`${SELECT} WHERE r.person_id = ? AND r.state IN ('PROPOSED', 'ACTIVE') ORDER BY r.state = 'ACTIVE' DESC, r.effective_from`, personId);
  const past = store.all<Row>(`${SELECT} WHERE r.person_id = ? AND r.state IN ('CEASED', 'DECLINED') ORDER BY r.closed_at DESC LIMIT 10`, personId);
  const canPropose = evaluate(store, ctx, { op: 'RESTRICTION', personId }).decision === 'ALLOW';
  return {
    restrictions: open.map((r) => shape(store, ctx, r)), past: past.map((r) => shape(store, ctx, r)), canPropose,
    profession: ctx.authority?.current ? ctx.authority.profession : null, options: options(),
  };
}

// For the record header: what is in force now, on every page of the record.
export function current(store: Store, personId: string) {
  expire(store);
  return store.all<Row>(`${SELECT} WHERE r.person_id = ? AND r.state = 'ACTIVE' AND r.effective_from <= ? ORDER BY r.effective_from`, personId, now())
    .map((r) => ({ id: r.id, label: label(r), detail: r.detail }));
}

interface Fields {
  kind?: string; side?: string; detail?: string; instructions?: string; reason?: string; patientView?: string;
  effectiveFrom?: string; effectiveUntil?: string; reviewDate?: string;
}

const when = (v: string | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function clean(b: Fields) {
  const kind = String(b.kind);
  if (!KINDS[kind]) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the kind of restriction.');
  const side = KINDS[kind].side ? (SIDES[String(b.side)] ? String(b.side) : null) : null;
  if (KINDS[kind].side && !side) throw new HttpError(400, 'SIDE_REQUIRED', 'Choose which side.');
  const detail = (b.detail ?? '').trim().slice(0, 500);
  if (detail.length < 2) throw new HttpError(400, 'DETAIL_REQUIRED', 'Write the restriction itself.');
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why it is needed.');
  const from = when(b.effectiveFrom) ?? now();
  const until = when(b.effectiveUntil);
  if (until && until <= from) throw new HttpError(400, 'UNTIL_BEFORE_FROM', 'The end must be after the start.');
  return {
    kind, side, detail, reason, instructions: (b.instructions ?? '').trim().slice(0, 1000) || null,
    patient_view: VIEWS[String(b.patientView)] ? String(b.patientView) : 'NOT_YET',
    effective_from: from, effective_until: until, review_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null,
  };
}

// Proposing a restriction the worker may authorise puts it straight into effect.
export function propose(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'RESTRICTION', personId }, personId);
  const v = clean(b);
  const direct = mayAuthorise(store, ctx, v.kind, personId);
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('restriction', {
      id, person_id: personId, service_id: ctx.serviceId, ...v, state: direct ? 'ACTIVE' : 'PROPOSED',
      proposed_by: ctx.workerId, proposed_at: at, authorised_by: direct ? ctx.workerId : null, authorised_at: direct ? at : null,
    });
    recordInitial(store, 'restriction', id, direct ? 'ACTIVE' : 'PROPOSED', { actorId: ctx.workerId, workContextId: ctx.id }, `${KINDS[v.kind].label}: ${v.detail}`);
    if (direct) store.insert('restriction_ack', { restriction_id: id, worker_id: ctx.workerId, at });
    logged(store, ctx, direct ? 'RESTRICTION_AUTHORISE' : 'RESTRICTION_PROPOSE', personId, id, `${KINDS[v.kind].label}: ${v.detail}`);
  });
  return { id, state: direct ? 'ACTIVE' : 'PROPOSED' };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That restriction no longer exists.');
  return r;
};

const needAuthority = (store: Store, ctx: WorkContext, r: Row) => {
  enforce(store, ctx, { op: 'RESTRICTION', personId: String(r.personId) }, String(r.personId));
  if (!mayAuthorise(store, ctx, String(r.kind), String(r.personId))) {
    const who = KINDS[String(r.kind)].authorisers.map((p) => p.toLowerCase()).join(' or ');
    throw new HttpError(403, 'BLOCK', `${KINDS[String(r.kind)].label} is authorised, changed or stopped by a ${who} in this organisation.`);
  }
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Fields & { note?: string; followed?: string | boolean; outcome?: string }) {
  expire(store);
  const r = load(store, id);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = (b.note ?? '').trim().slice(0, 1000);
  let result = id;
  switch (action) {
    case 'authorise': {
      if (r.state !== 'PROPOSED') throw new HttpError(409, 'NOT_PROPOSED', 'This restriction is not waiting for authorisation.');
      needAuthority(store, ctx, r);
      store.tx(() => {
        transition(store, 'restriction', id, 'ACTIVE', who, note || undefined);
        store.run('UPDATE restriction SET authorised_by = ?, authorised_at = ? WHERE id = ?', ctx.workerId, now(), id);
        store.run('INSERT OR IGNORE INTO restriction_ack (restriction_id, worker_id, at) VALUES (?, ?, ?)', id, ctx.workerId, now());
        logged(store, ctx, 'RESTRICTION_AUTHORISE', personId, id, note || undefined);
      });
      break;
    }
    case 'decline': {
      if (r.state !== 'PROPOSED') throw new HttpError(409, 'NOT_PROPOSED', 'This restriction is not waiting for authorisation.');
      const own = r.proposedById === ctx.workerId;
      if (!own) needAuthority(store, ctx, r);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', own ? 'Write why you are withdrawing it.' : 'Write why it is not authorised.');
      store.tx(() => {
        transition(store, 'restriction', id, 'DECLINED', who, note);
        store.run('UPDATE restriction SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        logged(store, ctx, own ? 'RESTRICTION_WITHDRAW' : 'RESTRICTION_DECLINE', personId, id, note);
      });
      break;
    }
    case 'read': {
      if (r.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This restriction is no longer in force.');
      enforce(store, ctx, { op: 'RESTRICTION_CHECK', personId }, personId);
      store.run('INSERT OR IGNORE INTO restriction_ack (restriction_id, worker_id, at) VALUES (?, ?, ?)', id, ctx.workerId, now());
      logged(store, ctx, 'RESTRICTION_READ', personId, id);
      break;
    }
    case 'check': {
      if (r.state !== 'ACTIVE' || String(r.effectiveFrom) > now()) throw new HttpError(409, 'NOT_IN_FORCE', 'This restriction is not in force now.');
      enforce(store, ctx, { op: 'RESTRICTION_CHECK', personId }, personId);
      const followed = b.followed === true || b.followed === 'true';
      if (!followed && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what happened and what was done.');
      store.tx(() => {
        store.insert('restriction_check', { id: newId(), restriction_id: id, checked_by: ctx.workerId, checked_at: now(), followed: followed ? 1 : 0, note: note || null });
        store.run('INSERT OR IGNORE INTO restriction_ack (restriction_id, worker_id, at) VALUES (?, ?, ?)', id, ctx.workerId, now());
        logged(store, ctx, followed ? 'RESTRICTION_CHECK' : 'RESTRICTION_NOT_FOLLOWED', personId, id, note || undefined);
      });
      break;
    }
    case 'review': {
      if (r.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This restriction is no longer in force.');
      const outcome = String(b.outcome);
      if (!OUTCOMES[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose continue, change or stop.');
      if (outcome === 'CONTINUE') enforce(store, ctx, { op: 'RESTRICTION', personId }, personId);
      else needAuthority(store, ctx, r);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the review found.');
      store.tx(() => {
        store.insert('restriction_review', { id: newId(), restriction_id: id, reviewed_by: ctx.workerId, reviewed_at: now(), outcome, finding: note });
        if (outcome === 'CONTINUE') {
          const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null;
          store.run('UPDATE restriction SET review_date = ? WHERE id = ?', reviewDate, id);
        } else if (outcome === 'CHANGED') {
          const v = clean({ ...b, kind: String(r.kind), effectiveFrom: b.effectiveFrom || now() });
          transition(store, 'restriction', id, 'SUPERSEDED', who, note);
          store.run('UPDATE restriction SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
          result = newId();
          store.insert('restriction', {
            id: result, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', proposed_by: ctx.workerId, proposed_at: now(),
            authorised_by: ctx.workerId, authorised_at: now(), supersedes_id: id,
          });
          recordInitial(store, 'restriction', result, 'ACTIVE', who, `Changed: ${v.detail}`);
          store.insert('restriction_ack', { restriction_id: result, worker_id: ctx.workerId, at: now() });
        } else {
          transition(store, 'restriction', id, 'CEASED', who, note);
          store.run('UPDATE restriction SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), note, id);
        }
        logged(store, ctx, `RESTRICTION_${outcome}`, personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with a restriction.');
  }
  return shape(store, ctx, load(store, result));
}

// Home → Restrictions: restrictions for everyone this service is caring for, whichever
// service set them.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('restriction.check')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include restrictions`);
  }
  expire(store);
  const rows = store.all<Row>(
    `${SELECT} WHERE r.state IN ('PROPOSED', 'ACTIVE') AND (r.service_id = ?
       OR r.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE')
       OR r.person_id IN (SELECT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL))
     ORDER BY r.effective_from`, ctx.serviceId, ctx.serviceId, ctx.serviceId,
  ).map((r) => shape(store, ctx, r));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_RESTRICTIONS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { restrictions: rows, options: options() };
}

// For the alert engine: this service's restrictions whose review date has passed.
export function reviewOverdue(store: Store, serviceId: string) {
  return store.all<Row>(`${SELECT} WHERE r.service_id = ? AND r.state = 'ACTIVE' AND r.review_date < ?`, serviceId, todayLocal())
    .map((r) => ({ personId: String(r.personId), objectId: String(r.id), title: `Restriction review overdue: ${label(r)}`, detail: `Review was due ${r.reviewDate}` }));
}
