import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Decision-making capacity assessment (Shared Lifecycle Object 251):
//   decision requiring assessment → reason for concern → functional assessment →
//   communication / support measures → determination within the applicable framework →
//   decision and context covered → time → reassessment requirement.
// Capacity is presumed (Code of Rights Right 7(2)) and is about one decision at one time, so
// every assessment names its decision and a finding never spreads to other decisions. Who
// may assess is organisational configuration (capacity.assess). What follows in law from a
// finding that a person lacks capacity, including who then decides, is RR-CAP-001, and SHIFT
// records nothing about it.

type Row = Record<string, string | number | null>;
const KINDS: Record<string, string> = {
  TREATMENT: 'Treatment or care', LIVING: 'Where to live', DISCHARGE: 'Going home or discharge plan',
  PERSONAL_CARE: 'Personal care', MONEY: 'Money or property', OTHER: 'Other',
};
const ABILITIES: Record<string, string> = {
  understand: 'Understands the information about this decision',
  retain: 'Holds on to it long enough to decide',
  weigh: 'Uses or weighs it to reach a decision',
  communicate: 'Communicates a decision, by any means',
};
const ANSWERS: Record<string, string> = { YES: 'Yes', NO: 'No', UNSURE: 'Not sure' };
const DETERMINATIONS: Record<string, string> = {
  HAS: 'Has capacity for this decision', LACKS: 'Lacks capacity for this decision', NOT_YET: 'Not able to decide yet',
};
const STATES: Record<string, string> = { RAISED: 'Waiting for assessment', DETERMINED: 'Assessed', WITHDRAWN: 'Concern withdrawn', SUPERSEDED: 'Reassessed' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-005'];

const SELECT = `
  SELECT c.id, c.state, c.decision, c.decision_kind AS kind, c.concern, c.person_id AS personId,
         p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = c.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         c.service_id AS serviceId, s.name AS service, rb.display_name AS raisedBy, c.raised_by AS raisedById, c.raised_at AS raisedAt,
         c.understand, c.retain, c.weigh, c.communicate, c.findings, c.supports, c.present,
         c.determination, c.determination_note AS determinationNote, ab.display_name AS assessedBy, c.assessed_at AS assessedAt,
         c.reassess_by AS reassessBy, c.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, c.closed_at AS closedAt, c.close_reason AS closeReason
    FROM capacity_assessment c
    JOIN person p ON p.id = c.person_id
    JOIN service s ON s.id = c.service_id
    JOIN workforce_person rb ON rb.id = c.raised_by
    LEFT JOIN workforce_person ab ON ab.id = c.assessed_by
    LEFT JOIN workforce_person cb ON cb.id = c.closed_by`;

const may = (store: Store, ctx: WorkContext, personId: string, cap: 'capacity.concern' | 'capacity.assess') =>
  evaluate(store, ctx, { op: 'CAPACITY', personId, cap }).decision === 'ALLOW';

function shape(store: Store, ctx: WorkContext, r: Row) {
  const personId = String(r.personId);
  const assess = may(store, ctx, personId, 'capacity.assess');
  const actions: string[] = [];
  if (r.state === 'RAISED' && assess) actions.push('assess');
  if (r.state === 'RAISED' && (assess || r.raisedById === ctx.workerId)) actions.push('withdraw');
  if (r.state === 'DETERMINED' && assess) actions.push('reassess');
  return {
    ...r, kindLabel: KINDS[String(r.kind)] ?? String(r.kind), stateLabel: STATES[String(r.state)],
    determinationLabel: r.determination ? DETERMINATIONS[String(r.determination)] : null,
    abilities: Object.entries(ABILITIES).map(([k, label]) => ({ key: k, label, answer: r[k] ? ANSWERS[String(r[k])] : null, value: r[k] })),
    reassessDue: r.state === 'DETERMINED' && !!r.reassessBy && String(r.reassessBy) <= todayLocal(),
    actions, history: history(store, 'capacity', String(r.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'capacity_assessment', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const options = () => ({ kinds: KINDS, abilities: ABILITIES, answers: ANSWERS, determinations: DETERMINATIONS });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const open = store.all<Row>(`${SELECT} WHERE c.person_id = ? AND c.state IN ('RAISED', 'DETERMINED') ORDER BY c.state = 'RAISED' DESC, c.raised_at DESC`, personId);
  const past = store.all<Row>(`${SELECT} WHERE c.person_id = ? AND c.state IN ('WITHDRAWN', 'SUPERSEDED') ORDER BY COALESCE(c.closed_at, c.raised_at) DESC LIMIT 10`, personId);
  return {
    assessments: open.map((r) => shape(store, ctx, r)), past: past.map((r) => shape(store, ctx, r)),
    canRaise: may(store, ctx, personId, 'capacity.concern'), canAssess: may(store, ctx, personId, 'capacity.assess'), options: options(),
  };
}

// For the record header: current findings that the person lacks capacity for a decision, each
// named, because capacity for one decision says nothing about another.
export function current(store: Store, personId: string) {
  return store.all<{ decision: string; assessedAt: string }>(
    "SELECT decision, assessed_at AS assessedAt FROM capacity_assessment WHERE person_id = ? AND state = 'DETERMINED' AND determination = 'LACKS' ORDER BY assessed_at DESC",
    personId,
  );
}

const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);

export function raise(store: Store, ctx: WorkContext, personId: string, b: { decision?: string; kind?: string; concern?: string }) {
  enforce(store, ctx, { op: 'CAPACITY', personId, cap: 'capacity.concern' }, personId);
  const decision = text(b.decision, 300);
  if (decision.length < 5) throw new HttpError(400, 'DECISION_REQUIRED', 'Write the specific decision, e.g. "whether to have the hip operation".');
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of decision it is.');
  const concern = text(b.concern);
  if (concern.length < 5) throw new HttpError(400, 'CONCERN_REQUIRED', 'Write why their capacity for this decision is in question.');
  const id = newId();
  store.tx(() => {
    store.insert('capacity_assessment', { id, person_id: personId, service_id: ctx.serviceId, decision, decision_kind: kind, concern, state: 'RAISED', raised_by: ctx.workerId, raised_at: now() });
    recordInitial(store, 'capacity', id, 'RAISED', { actorId: ctx.workerId, workContextId: ctx.id }, decision);
    logged(store, ctx, 'CAPACITY_CONCERN', personId, id, decision);
  });
  return { id };
}

interface Assessment {
  understand?: string; retain?: string; weigh?: string; communicate?: string; findings?: string; supports?: string; present?: string;
  determination?: string; note?: string; reassessBy?: string;
}

// The finding must follow from the functional assessment, and support must have been tried
// before a person is found to lack capacity.
function assessment(b: Assessment) {
  const answers: Record<string, string> = {};
  for (const k of Object.keys(ABILITIES)) {
    const v = String((b as Record<string, unknown>)[k] ?? '');
    if (!ANSWERS[v]) throw new HttpError(400, 'ABILITY_REQUIRED', `Answer: ${ABILITIES[k].toLowerCase()}.`);
    answers[k] = v;
  }
  const findings = text(b.findings);
  if (findings.length < 10) throw new HttpError(400, 'FINDINGS_REQUIRED', 'Write what you asked and how they answered.');
  const supports = text(b.supports);
  const determination = DETERMINATIONS[String(b.determination)] ? String(b.determination) : '';
  if (!determination) throw new HttpError(400, 'DETERMINATION_REQUIRED', 'Choose the finding.');
  const values = Object.values(answers);
  if (determination === 'HAS' && values.includes('NO')) {
    throw new HttpError(400, 'FINDING_MISMATCH', 'One of the abilities is "No", so "Has capacity" does not follow. Choose another finding or recheck the answers.');
  }
  if (determination === 'LACKS' && !values.includes('NO')) {
    throw new HttpError(400, 'FINDING_MISMATCH', 'Capacity is presumed. Lacking capacity needs at least one ability answered "No".');
  }
  if (determination === 'LACKS' && supports.length < 10) {
    throw new HttpError(400, 'SUPPORTS_REQUIRED', 'Write what was done to help them decide (e.g. time of day, hearing aids, interpreter, whānau, simpler information) before finding they lack capacity.');
  }
  const reassessBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.reassessBy)) ? String(b.reassessBy) : null;
  if (determination !== 'HAS' && !reassessBy) throw new HttpError(400, 'REASSESS_REQUIRED', 'Choose when to assess again.');
  return {
    understand: answers.understand, retain: answers.retain, weigh: answers.weigh, communicate: answers.communicate, findings, supports: supports || null, present: text(b.present, 300) || null,
    determination, determination_note: text(b.note) || null, reassess_by: reassessBy,
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${SELECT} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That assessment no longer exists.');
  return r;
};

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Assessment) {
  const r = load(store, id);
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  let result = id;
  switch (action) {
    case 'assess': {
      if (r.state !== 'RAISED') throw new HttpError(409, 'WRONG_STATE', 'This is not waiting for assessment.');
      enforce(store, ctx, { op: 'CAPACITY', personId, cap: 'capacity.assess' }, personId);
      const v = assessment(b);
      store.tx(() => {
        transition(store, 'capacity', id, 'DETERMINED', who, DETERMINATIONS[v.determination]);
        store.run(
          `UPDATE capacity_assessment SET understand = ?, retain = ?, weigh = ?, communicate = ?, findings = ?, supports = ?, present = ?,
             determination = ?, determination_note = ?, reassess_by = ?, assessed_by = ?, assessed_at = ? WHERE id = ?`,
          v.understand, v.retain, v.weigh, v.communicate, v.findings, v.supports, v.present, v.determination, v.determination_note, v.reassess_by, ctx.workerId, at, id,
        );
        logged(store, ctx, `CAPACITY_${v.determination}`, personId, id, String(r.decision));
      });
      break;
    }
    case 'reassess': {
      if (r.state !== 'DETERMINED') throw new HttpError(409, 'WRONG_STATE', 'Only an assessed decision can be reassessed.');
      enforce(store, ctx, { op: 'CAPACITY', personId, cap: 'capacity.assess' }, personId);
      const v = assessment(b);
      result = newId();
      store.tx(() => {
        transition(store, 'capacity', id, 'SUPERSEDED', who, 'Reassessed');
        store.run('UPDATE capacity_assessment SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, at, 'Reassessed', id);
        store.insert('capacity_assessment', {
          id: result, person_id: personId, service_id: ctx.serviceId, decision: r.decision, decision_kind: r.kind, concern: `Reassessment. ${r.concern}`,
          state: 'DETERMINED', raised_by: ctx.workerId, raised_at: at, ...v, assessed_by: ctx.workerId, assessed_at: at, supersedes_id: id,
        });
        recordInitial(store, 'capacity', result, 'DETERMINED', who, `Reassessed: ${DETERMINATIONS[v.determination]}`);
        logged(store, ctx, `CAPACITY_${v.determination}`, personId, result, `Reassessed: ${r.decision}`);
      });
      break;
    }
    case 'withdraw': {
      if (r.state !== 'RAISED') throw new HttpError(409, 'WRONG_STATE', 'This is not waiting for assessment.');
      if (r.raisedById !== ctx.workerId) enforce(store, ctx, { op: 'CAPACITY', personId, cap: 'capacity.assess' }, personId);
      const note = text(b.note);
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why an assessment is no longer needed.');
      store.tx(() => {
        transition(store, 'capacity', id, 'WITHDRAWN', who, note);
        store.run('UPDATE capacity_assessment SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, at, note, id);
        logged(store, ctx, 'CAPACITY_WITHDRAW', personId, id, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do with a capacity assessment.');
  }
  return shape(store, ctx, load(store, result));
}

// Home → Capacity assessments: concerns waiting in this service, and reassessments due.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('capacity.assess')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include capacity assessment`);
  }
  const rows = store.all<Row>(
    `${SELECT} WHERE c.state IN ('RAISED', 'DETERMINED') AND (c.service_id = ?
       OR c.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE'))
     ORDER BY c.state = 'RAISED' DESC, c.reassess_by, c.raised_at`, ctx.serviceId, ctx.serviceId,
  ).map((r) => shape(store, ctx, r));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_CAPACITY', decision: 'ALLOW', outcome: 'VIEWED' });
  return { assessments: rows, options: options() };
}

// For the alert engine: findings in this service whose reassessment date has passed.
export function reassessDue(store: Store, serviceId: string) {
  return store.all<Row>(`${SELECT} WHERE c.service_id = ? AND c.state = 'DETERMINED' AND c.reassess_by < ?`, serviceId, todayLocal())
    .map((r) => ({ personId: String(r.personId), objectId: String(r.id), title: `Capacity reassessment due: ${r.decision}`, detail: `Was due ${r.reassessBy}` }));
}
