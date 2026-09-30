import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { KINDS, CATEGORIES, SEVERITY, CERTAINTY, SOURCES, ASKED, END, REFS } from '../config/allergies.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Allergy / intolerance / adverse reaction (Shared Lifecycle Object 233):
//   reaction reported or seen → recorded where it happened → suspected or confirmed →
//   changed as more is known → ended with a reason (checked and not an allergy, no longer applies,
//   recorded in error).
// Nurses and doctors record, confirm, change and end allergies. Caregivers and therapists, who are
// often the ones who see a reaction, can report one: it is recorded as suspected at once, so it
// shows on the record and in medicine checks straight away, and a task asks a nurse to check it.
// "No known allergies" is recorded only after asking, and never while an allergy is recorded.
// An ended allergy leaves the banner but stays in the record with who ended it and why.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');

const mayRecord = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ALLERGY', personId }).decision === 'ALLOW';
const mayReport = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'ALLERGY_REPORT', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'allergy', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('allergy_log', { id: newId(), allergy_id: id, kind, body, by_id: by, at: now() });

const A = `
  SELECT a.id, a.person_id AS personId, a.kind, a.category, a.substance, a.reaction, a.severity, a.certainty, a.state, a.source, a.onset,
         a.recorded_at AS recordedAt, rb.display_name AS recordedBy, a.reconciliation_id AS reconciliationId,
         a.ended_at AS endedAt, eb.display_name AS endedBy, a.end_reason AS endReason, a.end_note AS endNote
    FROM allergy a
    LEFT JOIN workforce_person rb ON rb.id = a.recorded_by
    LEFT JOIN workforce_person eb ON eb.id = a.ended_by`;

// Older rows hold severity as free text ("Moderate"); show them as they were written.
const severityLabel = (v: unknown) => (v ? SEVERITY[String(v).toUpperCase()] ?? String(v) : null);

function shape(store: Store, r: Row, can: boolean) {
  const state = String(r.state);
  const nka = r.kind === 'NO_KNOWN_ALLERGIES';
  const actions: string[] = [];
  if (can && state === 'ACTIVE') {
    if (!nka && r.certainty === 'SUSPECTED') actions.push('confirm');
    if (!nka) actions.push('change');
    actions.push('end');
  }
  return {
    ...r, state, nka, certainty: r.certainty as string | null,
    kindLabel: nka ? 'No known allergies' : KINDS[String(r.kind)] ?? r.kind,
    categoryLabel: r.category ? CATEGORIES[String(r.category)] : null,
    severityCode: r.severity ? String(r.severity).toUpperCase() : null,
    severityLabel: severityLabel(r.severity),
    certaintyLabel: r.certainty ? CERTAINTY[String(r.certainty)] ?? r.certainty : null,
    endLabel: r.endReason ? END[String(r.endReason)] : null,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM allergy_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.allergy_id = ? ORDER BY l.at, l.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canRecord = mayRecord(store, ctx, personId);
  const canReport = canRecord || mayReport(store, ctx, personId);
  const all = store.all<Row>(`${A} WHERE a.person_id = ? ORDER BY a.recorded_at DESC`, personId).map((r) => shape(store, r, canRecord));
  const current = all.filter((x) => x.state === 'ACTIVE' && !x.nka);
  return {
    current,
    noKnown: all.find((x) => x.state === 'ACTIVE' && x.nka) ?? null,
    ended: all.filter((x) => x.state !== 'ACTIVE'),
    toCheck: current.filter((x) => x.certainty === 'SUSPECTED').length,
    canRecord, canReport,
    options: { kinds: KINDS, categories: CATEGORIES, severity: SEVERITY, certainty: { SUSPECTED: CERTAINTY.SUSPECTED, CONFIRMED: CERTAINTY.CONFIRMED }, sources: SOURCES, asked: ASKED, end: END },
  };
}

export function record(store: Store, ctx: WorkContext, personId: string, b: {
  kind?: string; category?: string; substance?: string; reaction?: string; severity?: string; certainty?: string; source?: string; onset?: string;
}) {
  const full = mayRecord(store, ctx, personId);
  if (!full) enforce(store, ctx, { op: 'ALLERGY_REPORT', personId }, personId);
  else enforce(store, ctx, { op: 'ALLERGY', personId }, personId);
  const kind = pick(KINDS, b.kind);
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose whether it is an allergy or an intolerance.');
  const substance = text(b.substance, 120);
  if (substance.length < 2) throw new HttpError(400, 'SUBSTANCE_REQUIRED', 'Write what they reacted to, e.g. "Amoxicillin".');
  const reaction = text(b.reaction, 300);
  if (reaction.length < 3) throw new HttpError(400, 'REACTION_REQUIRED', 'Write what happened, e.g. "Itchy red rash on chest and arms".');
  const severity = pick(SEVERITY, b.severity);
  if (!severity) throw new HttpError(400, 'SEVERITY_REQUIRED', 'Choose how bad the reaction was.');
  const source = pick(SOURCES, b.source);
  if (!source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose where this came from.');
  // Someone who can only report a reaction records it as suspected; a nurse or doctor checks it.
  const certainty = full ? pick({ SUSPECTED: '', CONFIRMED: '' }, b.certainty) || 'SUSPECTED' : 'SUSPECTED';
  const category = pick(CATEGORIES, b.category) || null;
  const onset = text(b.onset, 120) || null;
  const dup = store.get<Row>("SELECT substance FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind <> 'NO_KNOWN_ALLERGIES' AND lower(substance) = lower(?)", personId, substance);
  if (dup) throw new HttpError(409, 'ALREADY', `${dup.substance} is already on their allergy list. Change that entry instead.`);
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = `${KINDS[kind]}: ${substance}. ${reaction} (${SEVERITY[severity].toLowerCase()}). ${SOURCES[source]}${onset ? `, ${onset}` : ''}. ${CERTAINTY[certainty]}.`;
  store.tx(() => {
    store.insert('allergy', {
      id, person_id: personId, kind, category, substance, reaction, severity, certainty, state: 'ACTIVE', source: SOURCES[source], onset,
      recorded_by: ctx.workerId, recorded_at: now(), data_source: 'SHIFT',
    });
    recordInitial(store, 'allergy', id, 'ACTIVE', who, say);
    note(store, id, 'RECORDED', say, ctx.workerId);
    // An allergy now recorded means "no known allergies" is no longer true.
    for (const n of store.all<Row>("SELECT id FROM allergy WHERE person_id = ? AND kind = 'NO_KNOWN_ALLERGIES' AND state = 'ACTIVE'", personId)) {
      transition(store, 'allergy', String(n.id), 'INACTIVE', who, `${substance} recorded`);
      store.run("UPDATE allergy SET ended_by = ?, ended_at = ?, end_reason = 'RESOLVED', end_note = ? WHERE id = ?", ctx.workerId, now(), `${substance} recorded`, n.id);
      note(store, String(n.id), 'ENDED', `No longer true: ${substance} recorded.`, ctx.workerId);
    }
    if (!full) {
      const taskId = newId();
      store.insert('task', {
        id: taskId, person_id: personId, source_event_id: null, service_id: ctx.serviceId, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: now(), due_at: null,
        description: `Check a reported reaction to ${substance}: ${reaction}. Confirm it, change it, or end it on their allergy list.`.slice(0, 500),
      });
      recordInitial(store, 'task', taskId, 'CREATED', who, 'Reaction reported at the bedside');
    }
    logged(store, ctx, full ? 'ALLERGY_RECORD' : 'ALLERGY_REPORT', personId, id, say);
  });
  return forPerson(store, ctx, personId);
}

export function noKnown(store: Store, ctx: WorkContext, personId: string, b: { asked?: string; note?: string }) {
  enforce(store, ctx, { op: 'ALLERGY', personId }, personId);
  const asked = pick(ASKED, b.asked);
  if (!asked) throw new HttpError(400, 'ASKED_REQUIRED', 'Choose how you found out they have no known allergies.');
  const say = text(b.note);
  const listed = store.all<Row>("SELECT substance FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind <> 'NO_KNOWN_ALLERGIES'", personId);
  if (listed.length) {
    throw new HttpError(409, 'HAS_ALLERGIES', `${listed.map((x) => x.substance).join(', ')} ${listed.length > 1 ? 'are' : 'is'} on their allergy list. If that is wrong, end it with the reason first.`);
  }
  if (store.get("SELECT 1 FROM allergy WHERE person_id = ? AND state = 'ACTIVE' AND kind = 'NO_KNOWN_ALLERGIES'", personId)) {
    throw new HttpError(409, 'ALREADY', 'No known allergies is already recorded.');
  }
  const id = newId();
  const body = `${ASKED[asked]}${say ? `. ${say}` : ''}`;
  store.tx(() => {
    store.insert('allergy', {
      id, person_id: personId, kind: 'NO_KNOWN_ALLERGIES', substance: null, reaction: null, severity: null, certainty: null, state: 'ACTIVE', source: body.slice(0, 300),
      recorded_by: ctx.workerId, recorded_at: now(), data_source: 'SHIFT',
    });
    recordInitial(store, 'allergy', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, body);
    note(store, id, 'RECORDED', `No known allergies. ${body}`, ctx.workerId);
    logged(store, ctx, 'ALLERGY_NONE_KNOWN', personId, id, body);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; kind?: string; severity?: string; reaction?: string; category?: string; reason?: string }) {
  const r = store.get<Row>(`${A} WHERE a.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That allergy entry is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'ALLERGY', personId }, personId);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'ENDED', 'That entry has already ended. Record it again if it applies.');
  const nka = r.kind === 'NO_KNOWN_ALLERGIES';
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  const name = nka ? 'No known allergies' : String(r.substance);
  store.tx(() => {
    switch (action) {
      case 'confirm': {
        if (nka || r.certainty !== 'SUSPECTED') throw new HttpError(409, 'NOT_SUSPECTED', 'Only a suspected allergy can be confirmed.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write how it was confirmed, e.g. "Rash seen by me; same reaction in 2019 per GP letter".');
        revise(store, 'allergy', id, { certainty: r.certainty }, { certainty: 'CONFIRMED' }, { certainty: ['Certainty', CERTAINTY] }, who, say);
        store.run("UPDATE allergy SET certainty = 'CONFIRMED' WHERE id = ?", id);
        note(store, id, 'CONFIRMED', say, ctx.workerId);
        logged(store, ctx, 'ALLERGY_CONFIRM', personId, id, `${name}: ${say}`);
        break;
      }
      case 'change': {
        if (nka) throw new HttpError(409, 'NKA', 'No known allergies cannot be changed. Record the allergy instead.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is changing, e.g. "Swelling of the lips too; now severe".');
        const after = {
          kind: pick(KINDS, b.kind) || String(r.kind),
          severity: pick(SEVERITY, b.severity) || String(r.severity ?? ''),
          reaction: text(b.reaction, 300) || String(r.reaction ?? ''),
          category: pick(CATEGORIES, b.category) || String(r.category ?? ''),
        };
        const before = { kind: r.kind, severity: r.severity ? String(r.severity).toUpperCase() : '', reaction: r.reaction ?? '', category: r.category ?? '' };
        const changed = revise(store, 'allergy', id, before, after,
          { kind: ['Type', KINDS], severity: ['Severity', SEVERITY], reaction: 'Reaction', category: ['What it is', CATEGORIES] }, who, say);
        if (!changed) throw new HttpError(409, 'UNCHANGED', 'Nothing was changed.');
        store.run('UPDATE allergy SET kind = ?, severity = ?, reaction = ?, category = ? WHERE id = ?', after.kind, after.severity || null, after.reaction || null, after.category || null, id);
        note(store, id, 'CHANGED', `${changed}. ${say}`, ctx.workerId);
        logged(store, ctx, 'ALLERGY_CHANGE', personId, id, `${name}: ${changed}`);
        break;
      }
      case 'end': {
        const reason = pick(END, b.reason);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why this is ending.');
        if (nka && reason === 'REFUTED') throw new HttpError(400, 'REASON_REQUIRED', 'Choose why no known allergies no longer applies.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the decision was based on, e.g. "Had amoxicillin in 2024 with no reaction, per GP".');
        transition(store, 'allergy', id, reason === 'ERROR' ? 'ENTERED_IN_ERROR' : 'INACTIVE', who, say);
        store.run('UPDATE allergy SET ended_by = ?, ended_at = ?, end_reason = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), reason, say, id);
        if (reason === 'REFUTED') store.run("UPDATE allergy SET certainty = 'REFUTED' WHERE id = ?", id);
        note(store, id, 'ENDED', `${END[reason]}. ${say}`, ctx.workerId);
        logged(store, ctx, 'ALLERGY_END', personId, id, `${name}: ${END[reason]}. ${say}`);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
