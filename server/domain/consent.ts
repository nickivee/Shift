import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { KINDS, DECISIONS, FORMS, STATES, REFS } from '../config/consent.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Informed consent and refusal (workstation entry 20):
//   decision proposed → information given (what, why, risks, benefits, other options including doing
//   nothing) → understanding checked, with the support used → the person's own decision (agreed or
//   said no), verbal or written → checked again before it happens → done, or withdrawn at any time.
// Consent is for one decision. It is the person's own: capacity is presumed, and when a capacity
// assessment named for this decision is still open or found they cannot decide, SHIFT records no
// consent, because who may decide for them is RR-CAP-001 / RR-TP-001. A "no" or a withdrawal shows on
// the record for everyone until the person changes their mind. A preference is not consent
// (preferences.ts), and consent is not an advance directive (RR-ADVDIR-001).

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'CONSENT', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'consent', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('consent_log', { id: newId(), consent_id: id, kind, body, by_id: by, at: now() });

const C = `
  SELECT c.id, c.person_id AS personId, c.what, c.kind, c.capacity_id AS capacityId, ca.decision AS capacityDecision, ca.determination AS capacityFinding,
         c.decision, c.state, c.information, c.understood, c.support, c.form, c.form_ref AS formRef, c.their_words AS theirWords,
         rb.display_name AS recordedBy, c.recorded_at AS recordedAt, eb.display_name AS endedBy, c.ended_at AS endedAt, c.end_note AS endNote
    FROM consent c
    LEFT JOIN capacity_assessment ca ON ca.id = c.capacity_id
    JOIN workforce_person rb ON rb.id = c.recorded_by
    LEFT JOIN workforce_person eb ON eb.id = c.ended_by`;

function shape(store: Store, r: Row, can: boolean) {
  const state = String(r.state);
  const actions: string[] = [];
  if (can && state === 'CONSENTED') actions.push('check', 'done', 'withdraw');
  if (can && (state === 'REFUSED' || state === 'WITHDRAWN')) actions.push('reconsider');
  return {
    ...r, state,
    kindLabel: KINDS[String(r.kind)] ?? r.kind, stateLabel: STATES[state], formLabel: FORMS[String(r.form)] ?? r.form,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM consent_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.consent_id = ? ORDER BY l.at, l.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${C} WHERE c.person_id = ? ORDER BY c.recorded_at DESC`, personId).map((r) => shape(store, r, can));
  return {
    current: all.filter((x) => ['CONSENTED', 'REFUSED', 'WITHDRAWN'].includes(x.state)),
    past: all.filter((x) => ['DONE', 'RECONSIDERED'].includes(x.state)),
    canRecord: can,
    // Assessments a consent can name: capacity is about one decision, so the clinician chooses.
    assessments: store.all<Row>(
      "SELECT id, decision, state, determination FROM capacity_assessment WHERE person_id = ? AND state IN ('RAISED', 'DETERMINED') ORDER BY raised_at DESC", personId),
    options: { kinds: KINDS, decisions: DECISIONS, forms: FORMS },
  };
}

// For the record header: a "no" or a withdrawal everyone must know about before going ahead.
export function current(store: Store, personId: string) {
  return store.all<{ what: string; state: string; at: string }>(
    "SELECT what, state, COALESCE(ended_at, recorded_at) AS at FROM consent WHERE person_id = ? AND state IN ('REFUSED', 'WITHDRAWN') ORDER BY at DESC", personId);
}

function capacityCheck(store: Store, personId: string, capacityId: string | null) {
  if (!capacityId) return;
  const a = store.get<Row>('SELECT decision, state, determination, assessed_at AS at FROM capacity_assessment WHERE id = ? AND person_id = ?', capacityId, personId);
  if (!a) throw new HttpError(400, 'BAD_CAPACITY', 'That capacity assessment is not in their record.');
  const law = 'Who may decide for them is still being researched (RR-CAP-001, RR-TP-001), so SHIFT does not record anyone else\'s decision as consent.';
  if (a.state === 'RAISED') throw new HttpError(409, 'CAPACITY_OPEN', `Their capacity to decide "${a.decision}" is still waiting to be assessed. Assess it first. ${law}`);
  if (a.state === 'DETERMINED' && a.determination !== 'HAS') {
    throw new HttpError(409, 'CAPACITY_LACKS', `They were assessed as not able to make the decision "${a.decision}", so their own consent or refusal cannot be recorded for it. ${law}`);
  }
}

export function record(store: Store, ctx: WorkContext, personId: string, b: {
  what?: string; kind?: string; decision?: string; information?: string; understood?: string; support?: string; form?: string; formRef?: string; theirWords?: string; capacityId?: string;
}) {
  enforce(store, ctx, { op: 'CONSENT', personId }, personId);
  const what = text(b.what, 200);
  if (what.length < 4) throw new HttpError(400, 'WHAT_REQUIRED', 'Write what the decision is about, e.g. "Colonoscopy under sedation".');
  const kind = pick(KINDS, b.kind);
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of decision it is.');
  const decision = pick(DECISIONS, b.decision);
  if (!decision) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose whether they agreed or said no.');
  const information = text(b.information);
  if (information.length < 15) {
    throw new HttpError(400, 'INFORMATION_REQUIRED', 'Write what you explained: what it is, why, the risks and benefits, and the other options including doing nothing.');
  }
  const understood = text(b.understood);
  if (understood.length < 5) throw new HttpError(400, 'UNDERSTOOD_REQUIRED', 'Write how you checked they understood, and any questions they asked.');
  const form = pick(FORMS, b.form);
  if (!form) throw new HttpError(400, 'FORM_REQUIRED', 'Choose whether they said it out loud or signed a form.');
  const formRef = text(b.formRef, 120) || null;
  if (form === 'WRITTEN' && !formRef) throw new HttpError(400, 'FORM_REF_REQUIRED', 'Write which form they signed, e.g. "Procedure consent form, filed in the paper notes".');
  const capacityId = text(b.capacityId, 64) || null;
  capacityCheck(store, personId, capacityId);
  const support = text(b.support, 300) || null;
  const theirWords = text(b.theirWords, 500) || null;
  if (store.get("SELECT 1 FROM consent WHERE person_id = ? AND state IN ('CONSENTED', 'REFUSED', 'WITHDRAWN') AND lower(what) = lower(?)", personId, what)) {
    throw new HttpError(409, 'ALREADY', `Their decision about "${what}" is already recorded. Record a change of mind on that entry instead.`);
  }
  const id = newId();
  const say = `${DECISIONS[decision]}: ${what}. ${FORMS[form]}${formRef ? ` (${formRef})` : ''}.${theirWords ? ` In their words: "${theirWords}".` : ''}`;
  store.tx(() => {
    store.insert('consent', {
      id, person_id: personId, service_id: ctx.serviceId, what, kind, capacity_id: capacityId, decision, state: decision, information, understood, support,
      form, form_ref: formRef, their_words: theirWords, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'consent', id, decision, { actorId: ctx.workerId, workContextId: ctx.id }, say);
    note(store, id, decision, `${say} Explained: ${information} Understanding: ${understood}${support ? ` Support: ${support}` : ''}`, ctx.workerId);
    logged(store, ctx, decision === 'CONSENTED' ? 'CONSENT_GIVEN' : 'CONSENT_REFUSED', personId, id, say);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const r = store.get<Row>(`${C} WHERE c.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That consent is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'CONSENT', personId }, personId);
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const state = String(r.state);
  const end = (to: string, kind: string, op: string) => {
    transition(store, 'consent', id, to, who, say);
    store.run('UPDATE consent SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), say, id);
    note(store, id, kind, say, ctx.workerId);
    logged(store, ctx, op, personId, id, `${r.what}: ${say}`);
  };
  store.tx(() => {
    switch (action) {
      case 'check': {
        if (state !== 'CONSENTED') throw new HttpError(409, 'NOT_AGREED', 'Only an agreement can be checked again.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what they said when you checked, e.g. "Still happy to go ahead; no new questions".');
        note(store, id, 'CHECKED', say, ctx.workerId);
        logged(store, ctx, 'CONSENT_CHECKED', personId, id, `${r.what}: ${say}`);
        break;
      }
      case 'done': {
        if (state !== 'CONSENTED') throw new HttpError(409, 'NOT_AGREED', 'Only something they agreed to can be marked done.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was done and when, e.g. "Colonoscopy done 10:30, no problems".');
        end('DONE', 'DONE', 'CONSENT_DONE');
        break;
      }
      case 'withdraw': {
        if (state !== 'CONSENTED') throw new HttpError(409, 'NOT_AGREED', 'Only an agreement can be withdrawn.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what they said, in their words if you can.');
        end('WITHDRAWN', 'WITHDRAWN', 'CONSENT_WITHDRAWN');
        break;
      }
      case 'reconsider': {
        if (state !== 'REFUSED' && state !== 'WITHDRAWN') throw new HttpError(409, 'NOT_REFUSED', 'Only a "no" or a withdrawal can change.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what they said. If they now agree, record their consent as a new decision.');
        end('RECONSIDERED', 'RECONSIDERED', 'CONSENT_RECONSIDERED');
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
