import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { KINDS, PATTERNS, WHO_RATED, OUTCOMES, REASSESS_MINS, SEVERE } from '../config/symptoms.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Symptom (Shared Lifecycle Object 274):
//   symptom → onset → location/context → severity → pattern → associated features →
//   assessment → intervention → reassessment → outcome.
// Anyone caring for the person records a symptom with how bad it is. A nurse, doctor or
// therapist assesses it. Anyone can record what was done for it and SHIFT then shows when to
// look again; each reassessment adds a rating so the trend is visible. It closes with an
// outcome, or becomes a clinical problem (Object 273). A .pain entry feeds the open pain
// symptom, or starts one.

type Row = Record<string, string | number | null>;
type Cap = 'symptom.record' | 'symptom.manage';
const STATES: Record<string, string> = {
  RECORDED: 'Not yet assessed', ASSESSED: 'Assessed', INTERVENTION: 'Waiting to reassess', REASSESSED: 'Reassessed', CLOSED: 'Closed', ENTERED_IN_ERROR: 'Entered in error',
};
const STEPS: Record<string, string> = {
  RECORDED: 'Recorded', ASSESSED: 'Assessed', INTERVENTION: 'Done for it', REASSESSED: 'Reassessed', CLOSED: 'Closed', ERROR: 'Entered in error', ENTRY: 'From a .pain entry',
};
const OPEN = ['RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005'];

const Q = `
  SELECT s.id, s.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = s.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         s.service_id AS serviceId, s.kind, s.name, s.onset, s.site, s.context, s.pattern, s.associated, s.state, s.assessment,
         s.reassess_due AS reassessDue, s.outcome, s.outcome_note AS outcomeNote, s.problem_id AS problemId,
         rb.display_name AS recordedBy, s.recorded_at AS recordedAt, ab.display_name AS assessedBy, s.assessed_at AS assessedAt,
         cb.display_name AS closedBy, s.closed_at AS closedAt
    FROM symptom s
    JOIN person p ON p.id = s.person_id
    JOIN workforce_person rb ON rb.id = s.recorded_by
    LEFT JOIN workforce_person ab ON ab.id = s.assessed_by
    LEFT JOIN workforce_person cb ON cb.id = s.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'SYMPTOM', personId, cap }).decision === 'ALLOW';
const options = () => ({ kinds: KINDS, patterns: PATTERNS, whoRated: WHO_RATED, outcomes: OUTCOMES, reassessMins: REASSESS_MINS });
const score = (v: unknown) => {
  const n = Number(v);
  if (v === '' || v === undefined || v === null || !Number.isInteger(n) || n < 0 || n > 10) throw new HttpError(400, 'SCORE_REQUIRED', 'Give how bad it is from 0 (none) to 10 (worst imaginable).');
  return n;
};
const label = (r: Row) => (r.kind === 'OTHER' ? String(r.name) : KINDS[String(r.kind)] ?? String(r.kind));

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'symptom', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addStep = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('symptom_step', { id: newId(), symptom_id: id, kind, body, by_id: ctx.workerId, at: now() });
const addScore = (store: Store, ctx: WorkContext, id: string, value: number, rated: string) =>
  store.insert('symptom_score', { id: newId(), symptom_id: id, score: value, rated_by: rated, by_id: ctx.workerId, at: now() });

function shape(store: Store, r: Row, canRecord: boolean, canManage: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const scores = store.all<Row>(`SELECT c.score, c.rated_by AS rated, w.display_name AS "by", c.at FROM symptom_score c JOIN workforce_person w ON w.id = c.by_id
    WHERE c.symptom_id = ? ORDER BY c.at, c.rowid`, id).map((c) => ({ score: Number(c.score), rated: String(c.rated), by: String(c.by), at: String(c.at) }));
  const latest = scores[scores.length - 1] ?? null;
  const first = scores[0] ?? null;
  const open = OPEN.includes(state);
  const can: string[] = [];
  if (open) {
    if (canManage && state === 'RECORDED') can.push('assess');
    if (canRecord) can.push('intervention', 'reassess');
    if (canManage) can.push('close', 'problem');
  }
  if (canManage && state !== 'ENTERED_IN_ERROR' && state !== 'CLOSED') can.push('error');
  return {
    ...r, id, state, label: label(r), stateLabel: STATES[state], patternLabel: r.pattern ? PATTERNS[String(r.pattern)] ?? null : null,
    outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] : null, reassessDue: r.reassessDue === null ? null : String(r.reassessDue),
    reassessOverdue: state === 'INTERVENTION' && !!r.reassessDue && String(r.reassessDue) < now(),
    scores, latest: latest?.score ?? null, change: latest && first && scores.length > 1 ? latest.score - first.score : null,
    severe: open && (latest?.score ?? 0) >= SEVERE, can,
    steps: store.all<Row>(`SELECT s.kind, s.body, w.display_name AS "by", s.at FROM symptom_step s JOIN workforce_person w ON w.id = s.by_id
      WHERE s.symptom_id = ? ORDER BY s.at, s.rowid`, id).map((s) => ({ ...s, kindLabel: STEPS[String(s.kind)] ?? String(s.kind) })),
    history: history(store, 'symptom', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE s.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That symptom is no longer in SHIFT.');
  return r;
};

export function record(store: Store, ctx: WorkContext, personId: string,
  b: { kind?: string; name?: string; onset?: string; site?: string; context?: string; pattern?: string; associated?: string; score?: unknown; rated?: string; note?: string }) {
  enforce(store, ctx, { op: 'SYMPTOM', personId, cap: 'symptom.record' }, personId);
  const kind = KINDS[String(b.kind)] ? String(b.kind) : '';
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the symptom.');
  const name = text(b.name, 120);
  if (kind === 'OTHER' && name.length < 3) throw new HttpError(400, 'NAME_REQUIRED', 'Name the symptom, e.g. "Hiccups".');
  const value = score(b.score);
  const rated = WHO_RATED[String(b.rated)] ? String(b.rated) : 'SELF';
  const onset = b.onset ? Date.parse(String(b.onset)) : NaN;
  if (b.onset && (!Number.isFinite(onset) || onset > Date.now() + 5 * 60_000)) throw new HttpError(400, 'ONSET', 'When it started cannot be in the future.');
  const pattern = PATTERNS[String(b.pattern)] ? String(b.pattern) : null;
  const site = text(b.site, 200) || null;
  const context = text(b.context, 500) || null;
  const associated = text(b.associated, 500) || null;
  const title = kind === 'OTHER' ? name : KINDS[kind];
  if (store.get(`SELECT 1 FROM symptom WHERE person_id = ? AND kind = ? AND COALESCE(name, '') = ? AND COALESCE(lower(site), '') = ? AND state IN ('RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED')`,
    personId, kind, kind === 'OTHER' ? name : '', (site ?? '').toLowerCase())) {
    throw new HttpError(409, 'ALREADY_OPEN', `${title}${site ? ` (${site})` : ''} is already being followed. Reassess it instead.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('symptom', {
      id, person_id: personId, service_id: ctx.serviceId, kind, name: kind === 'OTHER' ? name : null, onset: Number.isFinite(onset) ? new Date(onset).toISOString() : null,
      site, context, pattern, associated, state: 'RECORDED', recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'symptom', id, 'RECORDED', { actorId: ctx.workerId, workContextId: ctx.id }, `${title} ${value}/10`);
    addScore(store, ctx, id, value, rated);
    addStep(store, ctx, id, 'RECORDED', [`${title}${site ? `, ${site}` : ''}: ${value}/10 (${WHO_RATED[rated].toLowerCase()}).`,
      pattern ? `${PATTERNS[pattern]}.` : '', context ? `Brought on by: ${context}.` : '', associated ? `Also: ${associated}.` : '', text(b.note, 500)].filter(Boolean).join(' '));
    logged(store, ctx, 'SYMPTOM_RECORD', personId, id, `${title} ${value}/10`);
  });
  return forPerson(store, ctx, personId);
}

// A .pain entry feeds the open pain symptom at that site (or the only open one), or starts one.
export function fromPainEntry(store: Store, ctx: WorkContext, personId: string, fields: Record<string, unknown>) {
  const value = Number(fields.score);
  if (!Number.isInteger(value) || value < 0 || value > 10) return;
  const site = text(fields.site, 200);
  const open = store.all<{ id: string; site: string | null; state: string }>(
    "SELECT id, site, state FROM symptom WHERE person_id = ? AND kind = 'PAIN' AND state IN ('RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED') ORDER BY recorded_at DESC", personId);
  const match = open.find((o) => (o.site ?? '').toLowerCase() === site.toLowerCase()) ?? (open.length === 1 && !site ? open[0] : undefined);
  const action = text(fields.action, 500);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const body = [`${site || 'Pain'}: ${value}/10.`, fields.character ? `${text(fields.character, 200)}.` : '', action ? `Done: ${action}.` : ''].filter(Boolean).join(' ');
  if (match) {
    addScore(store, ctx, match.id, value, 'SELF');
    addStep(store, ctx, match.id, 'ENTRY', body);
    if (action) {
      if (match.state !== 'INTERVENTION') transition(store, 'symptom', match.id, 'INTERVENTION', who, action.slice(0, 200));
      store.run('UPDATE symptom SET reassess_due = ? WHERE id = ?', new Date(Date.now() + REASSESS_MINS * 60_000).toISOString(), match.id);
    } else if (match.state === 'INTERVENTION') {
      transition(store, 'symptom', match.id, 'REASSESSED', who, `${value}/10`);
      store.run('UPDATE symptom SET reassess_due = NULL WHERE id = ?', match.id);
    }
    return;
  }
  const id = newId();
  store.insert('symptom', {
    id, person_id: personId, service_id: ctx.serviceId, kind: 'PAIN', site: site || null, context: text(fields.character, 500) || null,
    state: action ? 'INTERVENTION' : 'RECORDED', reassess_due: action ? new Date(Date.now() + REASSESS_MINS * 60_000).toISOString() : null,
    recorded_by: ctx.workerId, recorded_at: now(),
  });
  recordInitial(store, 'symptom', id, action ? 'INTERVENTION' : 'RECORDED', who, 'From a .pain entry');
  addScore(store, ctx, id, value, 'SELF');
  addStep(store, ctx, id, 'ENTRY', body);
  logged(store, ctx, 'SYMPTOM_FROM_ENTRY', personId, id, `Pain ${value}/10`);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; score?: unknown; rated?: string; mins?: unknown; outcome?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const recordOnly = action === 'intervention' || action === 'reassess';
  enforce(store, ctx, { op: 'SYMPTOM', personId, cap: recordOnly ? 'symptom.record' : 'symptom.manage' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = text(b.note);
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  if (!OPEN.includes(state) && action !== 'error') throw new HttpError(409, 'WRONG_STATE', `This symptom is ${STATES[state].toLowerCase()}.`);
  const title = label(r);
  switch (action) {
    case 'assess': {
      if (state !== 'RECORDED') throw new HttpError(409, 'WRONG_STATE', 'It has already been assessed.');
      need(10, 'Write your assessment, e.g. "Pleuritic pain from her pneumonia; no new signs; chest clear on the left".');
      store.tx(() => {
        transition(store, 'symptom', id, 'ASSESSED', who, note.slice(0, 200));
        store.run('UPDATE symptom SET assessment = ?, assessed_by = ?, assessed_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        addStep(store, ctx, id, 'ASSESSED', note);
        logged(store, ctx, 'SYMPTOM_ASSESS', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'intervention': {
      need(3, 'Write what was done, e.g. "Paracetamol 1 g as charted; repositioned on her left side".');
      const mins = b.mins === '' || b.mins === undefined ? REASSESS_MINS : Number(b.mins);
      if (!Number.isInteger(mins) || mins < 5 || mins > 24 * 60) throw new HttpError(400, 'MINS', 'Look again between 5 minutes and 24 hours from now.');
      const due = new Date(Date.now() + mins * 60_000).toISOString();
      store.tx(() => {
        if (state !== 'INTERVENTION') transition(store, 'symptom', id, 'INTERVENTION', who, note.slice(0, 200));
        store.run('UPDATE symptom SET reassess_due = ? WHERE id = ?', due, id);
        addStep(store, ctx, id, 'INTERVENTION', `${note} Look again in ${mins} minutes.`);
        logged(store, ctx, 'SYMPTOM_INTERVENTION', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'reassess': {
      const value = score(b.score);
      const rated = WHO_RATED[String(b.rated)] ? String(b.rated) : 'SELF';
      const prev = store.get<{ score: number }>('SELECT score FROM symptom_score WHERE symptom_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', id)?.score;
      store.tx(() => {
        if (state !== 'REASSESSED') transition(store, 'symptom', id, 'REASSESSED', who, `${value}/10`);
        store.run('UPDATE symptom SET reassess_due = NULL WHERE id = ?', id);
        addScore(store, ctx, id, value, rated);
        addStep(store, ctx, id, 'REASSESSED', `${value}/10${prev !== undefined ? ` (was ${prev})` : ''}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'SYMPTOM_REASSESS', personId, id, `${value}/10`);
      });
      break;
    }
    case 'close': {
      const outcome = OUTCOMES[String(b.outcome)] && b.outcome !== 'PROBLEM' ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose how it ended.');
      if (outcome === 'OTHER') need(5, 'Write how it ended.');
      store.tx(() => {
        transition(store, 'symptom', id, 'CLOSED', who, OUTCOMES[outcome]);
        store.run('UPDATE symptom SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ?, reassess_due = NULL WHERE id = ?', outcome, note || null, ctx.workerId, now(), id);
        addStep(store, ctx, id, 'CLOSED', `${OUTCOMES[outcome]}${note ? `: ${note}` : ''}`);
        logged(store, ctx, 'SYMPTOM_CLOSE', personId, id, OUTCOMES[outcome]);
      });
      break;
    }
    case 'problem': {
      // Hand it on to the problem list as a concern, with the symptom's story as evidence.
      need(5, 'Write why it needs following as a problem, e.g. "Breathless on minimal exertion for a week; needs working up".');
      const pid = newId();
      const scores = store.all<{ score: number }>('SELECT score FROM symptom_score WHERE symptom_id = ? ORDER BY at, rowid', id).map((s) => s.score);
      store.tx(() => {
        store.insert('clinical_problem', {
          id: pid, person_id: personId, service_id: ctx.serviceId, title: `${title}${r.site ? ` (${r.site})` : ''}`, state: 'CONCERN', recurrences: 0,
          raised_by: ctx.workerId, raised_at: now(), onset: r.onset ? String(r.onset).slice(0, 10) : null,
        });
        recordInitial(store, 'problem', pid, 'CONCERN', who, `From the symptom ${title}`);
        store.insert('problem_step', { id: newId(), problem_id: pid, kind: 'RAISED', body: `${note} Ratings so far: ${scores.join(', ')} out of 10.`, by_id: ctx.workerId, at: now() });
        transition(store, 'symptom', id, 'CLOSED', who, OUTCOMES.PROBLEM);
        store.run("UPDATE symptom SET outcome = 'PROBLEM', outcome_note = ?, problem_id = ?, closed_by = ?, closed_at = ?, reassess_due = NULL WHERE id = ?", note, pid, ctx.workerId, now(), id);
        addStep(store, ctx, id, 'CLOSED', `${OUTCOMES.PROBLEM}: ${note}`);
        logged(store, ctx, 'SYMPTOM_TO_PROBLEM', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      if (state === 'ENTERED_IN_ERROR' || state === 'CLOSED') throw new HttpError(409, 'WRONG_STATE', `This symptom is ${STATES[state].toLowerCase()}.`);
      need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".');
      store.tx(() => {
        transition(store, 'symptom', id, 'ENTERED_IN_ERROR', who, note.slice(0, 200));
        store.run('UPDATE symptom SET outcome_note = ?, closed_by = ?, closed_at = ?, reassess_due = NULL WHERE id = ?', note, ctx.workerId, now(), id);
        addStep(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'SYMPTOM_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return shape(store, load(store, id), true, true);
}

// The person's Symptoms view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'symptom.record');
  const canManage = may(store, ctx, personId, 'symptom.manage');
  const all = store.all<Row>(`${Q} WHERE s.person_id = ? ORDER BY s.recorded_at DESC`, personId).map((r) => shape(store, r, canRecord, canManage));
  return {
    open: all.filter((s) => OPEN.includes(s.state)), closed: all.filter((s) => !OPEN.includes(s.state)),
    canRecord, canManage, options: options(),
  };
}

// For the record header: open symptoms with their latest rating.
export function current(store: Store, personId: string) {
  return store.all<Row>(`${Q} WHERE s.person_id = ? AND s.state IN ('RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED') ORDER BY s.recorded_at`, personId).map((r) => {
    const latest = store.get<{ score: number }>('SELECT score FROM symptom_score WHERE symptom_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', String(r.id))?.score;
    return { label: `${label(r)}${r.site ? ` (${r.site})` : ''}`, score: latest ?? null, overdue: r.state === 'INTERVENTION' && !!r.reassessDue && String(r.reassessDue) < now() };
  });
}

// Home → Symptoms: reassessments due, severe ones, and those not yet assessed, in this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('symptom.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include managing symptoms`);
  const inService = `EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = s.person_id AND e.service_id = ? AND e.state = 'ACTIVE')
     OR EXISTS (SELECT 1 FROM care_relationship c WHERE c.person_id = s.person_id AND c.service_id = ? AND c.ended_at IS NULL)`;
  const rows = store.all<Row>(`${Q} WHERE s.state IN ('RECORDED', 'ASSESSED', 'INTERVENTION', 'REASSESSED') AND (${inService}) ORDER BY s.recorded_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => shape(store, r, false, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_SYMPTOMS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    reassess: rows.filter((r) => r.state === 'INTERVENTION').sort((a, b) => String(a.reassessDue).localeCompare(String(b.reassessDue))),
    severe: rows.filter((r) => r.severe && r.state !== 'INTERVENTION'),
    notAssessed: rows.filter((r) => r.state === 'RECORDED' && !r.severe),
    followed: rows.length,
  };
}
