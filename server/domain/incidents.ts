import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { CATEGORIES, HARMS, HARM_BY_ID, NOTIFY, DISCLOSURE } from '../config/incidents.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Incident / adverse clinical event (Shared Lifecycle Object 269):
//   event/concern → immediate clinical response → incident notification where required →
//   safety review → investigation linkage → findings → actions → closure.
// Anyone caring for the person reports what happened and what was done straight away. Someone
// other than the reporter reviews it: confirms the harm, records whether it must be notified
// and to whom, and whether it has been talked through with the person or their whānau (Code
// of Rights, LAW-NZ-005). It may be linked to an investigation; findings lead to actions with
// owners, and it closes only when every action is done and any required notification is
// recorded. The national rating and notification rules are research requirements (RR-INC-001).

type Row = Record<string, string | number | null>;
type Cap = 'incident.report' | 'incident.review';
const STATES: Record<string, string> = {
  REPORTED: 'Waiting for review', REVIEWED: 'Reviewed', INVESTIGATING: 'Being investigated', ACTIONS: 'Actions under way', CLOSED: 'Closed',
};
const KINDS: Record<string, string> = {
  REPORTED: 'Reported', REVIEWED: 'Safety review', NOTIFIED: 'Notified', NOTIFY_DECIDED: 'Notification decided', DISCLOSURE: 'Open disclosure', INVESTIGATING: 'Investigation',
  FINDINGS: 'Findings', ACTION: 'Action added', ACTION_DONE: 'Action done', CLOSED: 'Closed',
};
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-INC-001'];

const Q = `
  SELECT i.id, i.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = i.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         i.service_id AS serviceId, i.category, i.occurred_at AS occurredAt, i.place, i.what, i.immediate, i.reported_harm AS reportedHarm,
         i.harm, i.state, rb.display_name AS reportedBy, i.reported_by AS reportedById, i.reported_at AS reportedAt,
         vb.display_name AS reviewedBy, i.reviewed_at AS reviewedAt, i.notify, i.notify_note AS notifyNote, i.notified_at AS notifiedAt,
         i.disclosure, i.disclosure_note AS disclosureNote, i.investigation_ref AS investigationRef, i.investigation_lead AS investigationLead,
         i.findings, cb.display_name AS closedBy, i.closed_at AS closedAt, i.close_note AS closeNote
    FROM incident i
    JOIN person p ON p.id = i.person_id
    JOIN workforce_person rb ON rb.id = i.reported_by
    LEFT JOIN workforce_person vb ON vb.id = i.reviewed_by
    LEFT JOIN workforce_person cb ON cb.id = i.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'INCIDENT', personId, cap }).decision === 'ALLOW';
const options = () => ({ categories: CATEGORIES, harms: HARMS.map((h) => ({ id: h.id, label: h.label })), notify: NOTIFY, disclosure: DISCLOSURE });

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'incident', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('incident_step', { id: newId(), incident_id: id, kind, body, by_id: ctx.workerId, at: now() });

function shape(store: Store, ctx: WorkContext, r: Row, canReview: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const harm = HARM_BY_ID.get(String(r.harm ?? r.reportedHarm));
  const actions = store.all<Row>(`SELECT a.id, a.what, a.owner, a.due, a.done_at AS doneAt, a.done_note AS doneNote, w.display_name AS doneBy
      FROM incident_action a LEFT JOIN workforce_person w ON w.id = a.done_by WHERE a.incident_id = ? ORDER BY a.created_at`, id)
    .map((a) => ({ ...a, overdue: !a.doneAt && String(a.due) < todayLocal() }));
  const own = r.reportedById === ctx.workerId;
  const can: string[] = [];
  if (canReview && state === 'REPORTED' && !own) can.push('review');
  if (canReview && !['REPORTED', 'CLOSED'].includes(state)) {
    if (r.notify === 'REQUIRED' && !r.notifiedAt) can.push('notified');
    if (r.notify === 'UNSURE') can.push('notify-decide');
    if (r.disclosure !== 'DONE' && r.disclosure !== 'NOT_NEEDED') can.push('disclosure');
    if (state === 'REVIEWED') can.push('investigate');
    if (state === 'REVIEWED' || state === 'INVESTIGATING') can.push('findings');
    if (state === 'ACTIONS') can.push('action-add', 'close');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], categoryLabel: CATEGORIES[String(r.category)] ?? String(r.category),
    harmLabel: harm?.label ?? '', harmTone: harm?.tone ?? 'muted', harmConfirmed: r.harm !== null,
    notifyLabel: r.notify ? NOTIFY[String(r.notify)] : null, disclosureLabel: r.disclosure ? DISCLOSURE[String(r.disclosure)] : null,
    actions, can, canActOnActions: canReview && state === 'ACTIONS', own,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM incident_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.incident_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: KINDS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'incident', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That incident is no longer in SHIFT.');
  return r;
};

export function report(store: Store, ctx: WorkContext, personId: string,
  b: { category?: string; occurredAt?: string; place?: string; what?: string; harm?: string; immediate?: string }) {
  enforce(store, ctx, { op: 'INCIDENT', personId, cap: 'incident.report' }, personId);
  const category = CATEGORIES[String(b.category)] ? String(b.category) : '';
  if (!category) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose what kind of incident this was.');
  const occurred = Date.parse(String(b.occurredAt ?? ''));
  if (!Number.isFinite(occurred) || occurred > Date.now() + 5 * 60_000) throw new HttpError(400, 'WHEN_REQUIRED', 'Give when it happened. It cannot be in the future.');
  const what = text(b.what);
  if (what.length < 10) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what happened, in plain words and facts, e.g. "Found on the floor beside her bed at 02:10".');
  const harm = HARM_BY_ID.get(String(b.harm));
  if (!harm) throw new HttpError(400, 'HARM_REQUIRED', 'Choose whether it reached them and any harm you can see.');
  const immediate = text(b.immediate);
  if (immediate.length < 5) throw new HttpError(400, 'IMMEDIATE_REQUIRED', 'Say what was done straight away, e.g. "Checked for injury, obs, nurse in charge told".');
  const id = newId();
  store.tx(() => {
    store.insert('incident', {
      id, person_id: personId, service_id: ctx.serviceId, category, occurred_at: new Date(occurred).toISOString(), place: text(b.place, 200) || null,
      what, immediate, reported_harm: harm.id, state: 'REPORTED', reported_by: ctx.workerId, reported_at: now(),
    });
    recordInitial(store, 'incident', id, 'REPORTED', { actorId: ctx.workerId, workContextId: ctx.id }, `${CATEGORIES[category]}: ${what.slice(0, 200)}`);
    addStep(store, ctx, id, 'REPORTED', `${CATEGORIES[category]}. ${what} Straight away: ${immediate}`);
    logged(store, ctx, 'INCIDENT_REPORT', personId, id, `${CATEGORIES[category]}, ${harm.label}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { harm?: string; notify?: string; notifyNote?: string; disclosure?: string; disclosureNote?: string; note?: string;
    lead?: string; ref?: string; findings?: string; what?: string; owner?: string; due?: string; actionId?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'INCIDENT', personId, cap: 'incident.review' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This incident is ${STATES[state].toLowerCase()}.`); };
  const note = text(b.note);
  const disclosureCheck = (harmId: string, disclosure: string, dnote: string) => {
    if (!DISCLOSURE[disclosure]) throw new HttpError(400, 'DISCLOSURE_REQUIRED', 'Record whether it has been talked through with them or their whānau.');
    if (disclosure === 'NOT_NEEDED' && harmId !== 'NEAR_MISS') throw new HttpError(400, 'DISCLOSURE_NEEDED', 'It reached them, so it needs talking through with them or their whānau.');
    if (disclosure !== 'NOT_NEEDED' && dnote.length < 5) throw new HttpError(400, 'DISCLOSURE_NOTE', disclosure === 'DONE' ? 'Write who talked with whom and when.' : 'Write what is planned, or why it is not possible yet.');
  };
  switch (action) {
    case 'review': {
      inState('REPORTED');
      if (r.reportedById === ctx.workerId) throw new HttpError(403, 'SAME_PERSON', 'Someone other than the person who reported it must review it.');
      const harm = HARM_BY_ID.get(String(b.harm));
      if (!harm) throw new HttpError(400, 'HARM_REQUIRED', 'Confirm the level of harm.');
      const notify = NOTIFY[String(b.notify)] ? String(b.notify) : '';
      if (!notify) throw new HttpError(400, 'NOTIFY_REQUIRED', 'Record whether this must be notified outside the service.');
      const notifyNote = text(b.notifyNote, 500);
      if (notify !== 'NOT_REQUIRED' && notifyNote.length < 3) throw new HttpError(400, 'NOTIFY_NOTE', notify === 'REQUIRED' ? 'Write who must be told.' : 'Write who you asked for advice.');
      const disclosure = String(b.disclosure ?? '');
      const dnote = text(b.disclosureNote, 500);
      disclosureCheck(harm.id, disclosure, dnote);
      store.tx(() => {
        transition(store, 'incident', id, 'REVIEWED', who, `${harm.label}; ${NOTIFY[notify].toLowerCase()}`);
        store.run(`UPDATE incident SET harm = ?, notify = ?, notify_note = ?, disclosure = ?, disclosure_note = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
          harm.id, notify, notifyNote || null, disclosure, dnote || null, ctx.workerId, at, note || null, id);
        addStep(store, ctx, id, 'REVIEWED', [`Harm: ${harm.label}.`, `${NOTIFY[notify]}${notifyNote ? `: ${notifyNote}` : ''}.`, `Open disclosure: ${DISCLOSURE[disclosure]}${dnote ? `: ${dnote}` : ''}.`, note].filter(Boolean).join(' '));
        logged(store, ctx, 'INCIDENT_REVIEW', personId, id, `${harm.label}; ${NOTIFY[notify]}`);
      });
      break;
    }
    case 'notified': {
      inState('REVIEWED', 'INVESTIGATING', 'ACTIONS');
      if (r.notify !== 'REQUIRED') throw new HttpError(409, 'NOT_REQUIRED', 'The review did not record a notification as required.');
      const ref = text(b.ref, 300);
      if (ref.length < 3) throw new HttpError(400, 'REF_REQUIRED', 'Write who was told, how, and any reference number.');
      store.tx(() => {
        store.run('UPDATE incident SET notified_at = ? WHERE id = ?', at, id);
        addStep(store, ctx, id, 'NOTIFIED', ref);
        logged(store, ctx, 'INCIDENT_NOTIFIED', personId, id, ref);
      });
      break;
    }
    case 'notify-decide': {
      inState('REVIEWED', 'INVESTIGATING', 'ACTIONS');
      if (r.notify !== 'UNSURE') throw new HttpError(409, 'ALREADY_DECIDED', 'Whether to notify has already been decided.');
      const notify = b.notify === 'REQUIRED' || b.notify === 'NOT_REQUIRED' ? b.notify : '';
      if (!notify) throw new HttpError(400, 'NOTIFY_REQUIRED', 'Choose whether it must be notified.');
      const notifyNote = text(b.notifyNote, 500);
      if (notifyNote.length < 3) throw new HttpError(400, 'NOTIFY_NOTE', notify === 'REQUIRED' ? 'Write who must be told.' : 'Write who advised that it is not required.');
      store.tx(() => {
        store.run('UPDATE incident SET notify = ?, notify_note = ? WHERE id = ?', notify, notifyNote, id);
        addStep(store, ctx, id, 'NOTIFY_DECIDED', `${NOTIFY[notify]}: ${notifyNote}`);
        logged(store, ctx, 'INCIDENT_NOTIFY_DECIDED', personId, id, NOTIFY[notify]);
      });
      break;
    }
    case 'disclosure': {
      inState('REVIEWED', 'INVESTIGATING', 'ACTIONS');
      const disclosure = String(b.disclosure ?? '');
      const dnote = text(b.disclosureNote, 500);
      disclosureCheck(String(r.harm), disclosure, dnote);
      store.tx(() => {
        store.run('UPDATE incident SET disclosure = ?, disclosure_note = ? WHERE id = ?', disclosure, dnote || null, id);
        addStep(store, ctx, id, 'DISCLOSURE', `${DISCLOSURE[disclosure]}${dnote ? `: ${dnote}` : ''}`);
        logged(store, ctx, 'INCIDENT_DISCLOSURE', personId, id, DISCLOSURE[disclosure]);
      });
      break;
    }
    case 'investigate': {
      inState('REVIEWED');
      const lead = text(b.lead, 200);
      if (lead.length < 3) throw new HttpError(400, 'LEAD_REQUIRED', 'Write who is leading the investigation.');
      const ref = text(b.ref, 200) || null;
      store.tx(() => {
        transition(store, 'incident', id, 'INVESTIGATING', who, `Led by ${lead}`);
        store.run('UPDATE incident SET investigation_lead = ?, investigation_ref = ? WHERE id = ?', lead, ref, id);
        addStep(store, ctx, id, 'INVESTIGATING', `Led by ${lead}${ref ? ` (reference ${ref})` : ''}`);
        logged(store, ctx, 'INCIDENT_INVESTIGATE', personId, id, lead);
      });
      break;
    }
    case 'findings': {
      inState('REVIEWED', 'INVESTIGATING');
      const findings = text(b.findings);
      if (findings.length < 10) throw new HttpError(400, 'FINDINGS_REQUIRED', 'Write what was found, including anything about the system and not just the people, e.g. "Bed alarm was off after cleaning".');
      store.tx(() => {
        transition(store, 'incident', id, 'ACTIONS', who, 'Findings recorded');
        store.run('UPDATE incident SET findings = ? WHERE id = ?', findings, id);
        addStep(store, ctx, id, 'FINDINGS', findings);
        logged(store, ctx, 'INCIDENT_FINDINGS', personId, id, findings.slice(0, 200));
      });
      break;
    }
    case 'action-add': {
      inState('ACTIONS');
      const what = text(b.what, 500);
      const owner = text(b.owner, 200);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : '';
      if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Write the action, e.g. "Check bed alarms are back on after every clean".');
      if (owner.length < 3) throw new HttpError(400, 'OWNER_REQUIRED', 'Write who is responsible for it.');
      if (!due) throw new HttpError(400, 'DUE_REQUIRED', 'Give the date it is due.');
      store.tx(() => {
        store.insert('incident_action', { id: newId(), incident_id: id, what, owner, due, created_by: ctx.workerId, created_at: at });
        addStep(store, ctx, id, 'ACTION', `${what} (${owner}, due ${due})`);
        logged(store, ctx, 'INCIDENT_ACTION', personId, id, what);
      });
      break;
    }
    case 'action-done': {
      inState('ACTIONS');
      const a = store.get<{ id: string; what: string; done_at: string | null }>('SELECT id, what, done_at FROM incident_action WHERE id = ? AND incident_id = ?', String(b.actionId), id);
      if (!a) throw new HttpError(404, 'NOT_FOUND', 'That action is no longer on this incident.');
      if (a.done_at) throw new HttpError(409, 'ALREADY_DONE', 'That action is already done.');
      if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done.');
      store.tx(() => {
        store.run('UPDATE incident_action SET done_at = ?, done_by = ?, done_note = ? WHERE id = ?', at, ctx.workerId, note, a.id);
        addStep(store, ctx, id, 'ACTION_DONE', `${a.what}: ${note}`);
        logged(store, ctx, 'INCIDENT_ACTION_DONE', personId, id, a.what);
      });
      break;
    }
    case 'close': {
      inState('ACTIONS');
      const open = store.all<{ what: string }>('SELECT what FROM incident_action WHERE incident_id = ? AND done_at IS NULL', id);
      if (open.length) throw new HttpError(409, 'ACTIONS_OPEN', `Every action must be done first. Still open: ${open.map((a) => a.what).join('; ')}.`);
      if (!store.get('SELECT 1 FROM incident_action WHERE incident_id = ?', id) && note.length < 10) {
        throw new HttpError(400, 'NO_ACTIONS', 'There are no actions. Write why none are needed.');
      }
      if (r.notify === 'UNSURE') throw new HttpError(409, 'NOTIFY_UNDECIDED', 'Whether this must be notified is still not decided. Record the decision first.');
      if (r.notify === 'REQUIRED' && !r.notifiedAt) throw new HttpError(409, 'NOT_NOTIFIED', 'The review said this must be notified. Record the notification first.');
      if (r.disclosure === 'PLANNED' || r.disclosure === 'NOT_POSSIBLE') throw new HttpError(409, 'DISCLOSURE_OPEN', 'Open disclosure is not recorded as done. Update it first.');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write a closing summary.');
      store.tx(() => {
        transition(store, 'incident', id, 'CLOSED', who, note.slice(0, 200));
        store.run('UPDATE incident SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addStep(store, ctx, id, 'CLOSED', note);
        logged(store, ctx, 'INCIDENT_CLOSE', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, ctx, load(store, id), true);
}

export function get(store: Store, ctx: WorkContext, id: string) {
  const r = load(store, id);
  enforce(store, ctx, { op: 'INCIDENT', personId: String(r.personId), cap: 'incident.report' }, String(r.personId));
  return { ...shape(store, ctx, r, may(store, ctx, String(r.personId), 'incident.review')), options: options() };
}

// The person's Incidents view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canReport = may(store, ctx, personId, 'incident.report');
  const canReview = may(store, ctx, personId, 'incident.review');
  const all = store.all<Row>(`${Q} WHERE i.person_id = ? ORDER BY i.occurred_at DESC`, personId).map((r) => shape(store, ctx, r, canReview));
  return { open: all.filter((i) => i.state !== 'CLOSED'), closed: all.filter((i) => i.state === 'CLOSED'), canReport, canReview, options: options() };
}

// Home → Incidents: waiting for review, open, actions overdue, recently closed.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('incident.review')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include reviewing incidents`);
  const rows = store.all<Row>(`${Q} WHERE i.service_id = ? AND (i.state != 'CLOSED' OR i.closed_at >= ?) ORDER BY i.occurred_at DESC`,
    ctx.serviceId, new Date(Date.now() - 30 * 24 * 3600_000).toISOString()).map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_INCIDENTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toReview: rows.filter((r) => r.state === 'REPORTED'),
    open: rows.filter((r) => !['REPORTED', 'CLOSED'].includes(r.state)),
    closed: rows.filter((r) => r.state === 'CLOSED'),
    overdueActions: rows.filter((r) => r.actions.some((a) => a.overdue)).length,
    options: options(),
  };
}
