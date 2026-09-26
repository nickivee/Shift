import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Patient-reported information (Shared Lifecycle Object 256):
//   patient report → source/time/context → structured or narrative information → clinical
//   review where applicable → incorporated into assessment/decision where appropriate →
//   updated/corrected by source.
// Kept in the person's own words, with who said it, how and when. Anyone caring for them can
// record it; a nurse, doctor or physio reviews what needs clinical eyes. When the person (or
// whoever spoke for them) says it has changed or was wrong, a new version becomes current and
// the earlier one is kept with it (HIPC 2020 rule 7, LAW-NZ-002).

type Row = Record<string, string | number | null>;
const TOPICS: Record<string, string> = {
  SYMPTOM: 'A symptom', PAIN: 'Pain', SLEEP: 'Sleep', MOOD: 'Mood and feelings', EATING: 'Eating and drinking', TOILETING: 'Bladder and bowels',
  MOBILITY: 'Getting about', MEDICINES: 'Medicines', GOALS: 'What matters to them', WORRIES: 'Worries', OTHER: 'Other',
};
const RATED = ['SYMPTOM', 'PAIN'];
const SOURCES: Record<string, string> = { PATIENT: 'The person themselves', WHANAU: 'Whānau or support person, for them', FORM: 'A form they filled in' };
const HOW: Record<string, string> = { IN_PERSON: 'In person', PHONE: 'Phone', VIDEO: 'Video', WRITTEN: 'Written by them', INTERPRETER: 'Through an interpreter' };
const STATES: Record<string, string> = { RECORDED: 'Recorded', REVIEWED: 'Reviewed', SUPERSEDED: 'Replaced' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005'];

const REPORT = `
  SELECT r.id, r.lineage_id AS lineageId, r.version, r.supersedes, r.change_kind AS changeKind, r.person_id AS personId,
         p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         s.name AS service, r.source, r.source_name AS sourceName, r.how, r.topic, r.words, r.rating, r.about_when AS aboutWhen,
         r.reported_at AS reportedAt, rb.display_name AS recordedBy, r.recorded_at AS recordedAt, r.needs_review AS needsReview, r.state,
         vb.display_name AS reviewedBy, r.reviewed_at AS reviewedAt, r.review_outcome AS reviewOutcome, r.review_note AS reviewNote
    FROM patient_report r
    JOIN person p ON p.id = r.person_id
    JOIN service s ON s.id = r.service_id
    JOIN workforce_person rb ON rb.id = r.recorded_by
    LEFT JOIN workforce_person vb ON vb.id = r.reviewed_by`;

const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: 'report.record' | 'report.review') =>
  evaluate(store, ctx, { op: 'REPORT', personId, cap }).decision === 'ALLOW';
const options = () => ({ topics: TOPICS, rated: RATED, sources: SOURCES, how: HOW });

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'patient_report', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}

function shape(store: Store, r: Row, canRecord: boolean, canReview: boolean) {
  const actions: string[] = [];
  if (canReview && r.state === 'RECORDED') actions.push('review');
  if (canRecord && r.state !== 'SUPERSEDED') actions.push('update', 'correct');
  return {
    ...r, needsReview: !!r.needsReview, topicLabel: TOPICS[String(r.topic)], sourceLabel: SOURCES[String(r.source)], howLabel: HOW[String(r.how)],
    stateLabel: r.state === 'RECORDED' && r.needsReview ? 'To review' : STATES[String(r.state)], actions, history: history(store, 'report', String(r.id)),
  };
}

interface Fields { source?: string; sourceName?: string; how?: string; topic?: string; words?: string; rating?: string | number; aboutWhen?: string; reportedAt?: string; needsReview?: boolean | string }

function clean(b: Fields, topic: string) {
  const words = text(b.words, 2000);
  if (words.length < 3) throw new HttpError(400, 'WORDS_REQUIRED', 'Write what they said, in their words.');
  const how = HOW[String(b.how)] ? String(b.how) : 'IN_PERSON';
  let rating: number | null = null;
  if (RATED.includes(topic) && b.rating !== undefined && b.rating !== '') {
    rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) throw new HttpError(400, 'RATING_RANGE', 'The score is a whole number from 0 to 10.');
  }
  const at = b.reportedAt ? new Date(String(b.reportedAt)) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'WHEN_INVALID', 'Choose when they said it.');
  if (at.getTime() > Date.now() + 5 * 60_000) throw new HttpError(400, 'WHEN_FUTURE', 'When they said it cannot be in the future.');
  // A high score always goes to a clinician, whatever the recorder chose.
  const needsReview = b.needsReview === true || b.needsReview === 'true' || (rating !== null && rating >= 7);
  return { how, words, rating, about_when: text(b.aboutWhen, 100) || null, reported_at: at.toISOString(), needs_review: needsReview ? 1 : 0 };
}

export function record(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'REPORT', personId, cap: 'report.record' }, personId);
  const topic = TOPICS[String(b.topic)] ? String(b.topic) : '';
  if (!topic) throw new HttpError(400, 'TOPIC_REQUIRED', 'Choose what it is about.');
  const source = SOURCES[String(b.source)] ? String(b.source) : 'PATIENT';
  const sourceName = text(b.sourceName, 200);
  if (source === 'WHANAU' && sourceName.length < 3) throw new HttpError(400, 'SOURCE_NAME_REQUIRED', 'Write who told you, and how they are related.');
  const v = clean(b, topic);
  const id = newId();
  store.tx(() => {
    store.insert('patient_report', {
      id, lineage_id: id, version: 1, supersedes: null, change_kind: null, person_id: personId, service_id: ctx.serviceId,
      source, source_name: source === 'PATIENT' ? null : sourceName || null, topic, ...v, recorded_by: ctx.workerId, recorded_at: now(), state: 'RECORDED',
    });
    recordInitial(store, 'report', id, 'RECORDED', { actorId: ctx.workerId, workContextId: ctx.id }, v.words.slice(0, 200));
    logged(store, ctx, 'REPORT_RECORD', personId, id, TOPICS[topic]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Fields & { outcome?: string; note?: string }) {
  const r = store.get<Row>(`${REPORT} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That report is no longer in SHIFT.');
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  switch (action) {
    case 'review': {
      enforce(store, ctx, { op: 'REPORT', personId, cap: 'report.review' }, personId);
      if (r.state !== 'RECORDED') throw new HttpError(409, 'WRONG_STATE', 'This has already been reviewed or replaced.');
      const outcome = b.outcome === 'INCORPORATED' ? 'INCORPORATED' : b.outcome === 'NOTED' ? 'NOTED' : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose whether it changed their care.');
      const note = text(b.note, 1000);
      if (outcome === 'INCORPORATED' && note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what it changed, e.g. "Night-time pain relief added to the chart".');
      store.tx(() => {
        transition(store, 'report', id, 'REVIEWED', who, note || 'Read; no change to care');
        store.run('UPDATE patient_report SET reviewed_by = ?, reviewed_at = ?, review_outcome = ?, review_note = ? WHERE id = ?', ctx.workerId, at, outcome, note || null, id);
        logged(store, ctx, `REPORT_${outcome}`, personId, id, note);
      });
      break;
    }
    case 'update':
    case 'correct': {
      enforce(store, ctx, { op: 'REPORT', personId, cap: 'report.record' }, personId);
      if (r.state === 'SUPERSEDED') throw new HttpError(409, 'WRONG_STATE', 'Only the current version can be changed.');
      const v = clean(b, String(r.topic));
      const kind = action === 'update' ? 'UPDATE' : 'CORRECTION';
      const nid = newId();
      store.tx(() => {
        store.insert('patient_report', {
          id: nid, lineage_id: r.lineageId, version: Number(r.version) + 1, supersedes: id, change_kind: kind, person_id: personId, service_id: ctx.serviceId,
          source: r.source, source_name: r.sourceName, topic: r.topic, ...v, recorded_by: ctx.workerId, recorded_at: at, state: 'RECORDED',
        });
        recordInitial(store, 'report', nid, 'RECORDED', who, kind === 'UPDATE' ? 'Things have changed' : 'Corrected by them');
        transition(store, 'report', id, 'SUPERSEDED', who, kind === 'UPDATE' ? 'Replaced by an update' : 'Replaced by their correction');
        logged(store, ctx, `REPORT_${kind}`, personId, nid, v.words.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's "In their words" view: current reports, each with its earlier versions.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = may(store, ctx, personId, 'report.record');
  const canReview = may(store, ctx, personId, 'report.review');
  const rows = store.all<Row>(`${REPORT} WHERE r.person_id = ? ORDER BY r.reported_at DESC`, personId);
  const current = rows.filter((r) => r.state !== 'SUPERSEDED').map((r) => ({
    ...shape(store, r, canRecord, canReview),
    earlier: rows.filter((e) => e.lineageId === r.lineageId && e.id !== r.id).sort((a, b) => Number(b.version) - Number(a.version)).map((e) => shape(store, e, false, false)),
  }));
  return { reports: current, canRecord, canReview, options: options() };
}

// Home → In their own words: what patients in this service have said that a clinician should read.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('report.review')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include reviewing what patients report`);
  const inService = "r.person_id IN (SELECT person_id FROM encounter WHERE service_id = ? AND state = 'ACTIVE' UNION SELECT person_id FROM care_relationship WHERE service_id = ? AND ended_at IS NULL)";
  const toReview = store.all<Row>(`${REPORT} WHERE ${inService} AND r.state = 'RECORDED' AND r.needs_review = 1 ORDER BY r.rating DESC, r.reported_at`, ctx.serviceId, ctx.serviceId)
    .map((r) => ({
      ...shape(store, r, true, true),
      earlier: store.all<Row>(`${REPORT} WHERE r.lineage_id = ? AND r.id != ? ORDER BY r.version DESC`, String(r.lineageId), String(r.id)).map((e) => shape(store, e, false, false)),
    }));
  const reviewed = store.all<Row>(`${REPORT} WHERE ${inService} AND r.state = 'REVIEWED' AND r.reviewed_at >= ? ORDER BY r.reviewed_at DESC`, ctx.serviceId, ctx.serviceId,
    new Date(Date.now() - 3 * 24 * 3600_000).toISOString()).map((r) => shape(store, r, false, false));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_PATIENT_REPORTS', decision: 'ALLOW', outcome: 'VIEWED' });
  return { toReview, reviewed, options: options() };
}
