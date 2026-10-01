import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, TOOK_PART, AGREED, REFS } from '../config/decisions.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Clinical decision (Shared Lifecycle Object 238):
//   the question and why it needs deciding now → the options, each with its benefits and risks →
//   what the person wants, in their words, and whether they could take part → decided: the option
//   chosen, why, whether they agree, and when to look at it again → still right, or think again.
// Doctors raise and make decisions. Nurses see them, so the whole team works to the same plan.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'DECISION', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'clinical_decision', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [238],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('clinical_decision_step', { id: newId(), decision_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT d.id, d.person_id AS personId, d.question, d.background, d.state, rb.display_name AS raisedBy, d.raised_at AS raisedAt,
         d.their_view AS theirView, d.took_part AS tookPart, d.took_part_note AS tookPartNote, d.others,
         d.chosen_id AS chosenId, d.reason, d.agreed, db.display_name AS decidedBy, d.decided_at AS decidedAt, d.review_on AS reviewOn, d.closed_note AS closedNote
    FROM clinical_decision d
    JOIN workforce_person rb ON rb.id = d.raised_by
    LEFT JOIN workforce_person db ON db.id = d.decided_by`;

function shape(store: Store, r: Row, doctor: boolean): Record<string, any> {
  const state = String(r.state);
  const options = store.all<Row>(
    'SELECT o.id, o.option, o.benefits, o.risks, w.display_name AS "by" FROM clinical_decision_option o JOIN workforce_person w ON w.id = o.added_by WHERE o.decision_id = ? ORDER BY o.added_at, o.rowid', String(r.id));
  const acts: string[] = [];
  if (doctor && state === 'OPEN') acts.push('option', 'view', 'decide');
  if (doctor && state === 'DECIDED') acts.push('review');
  if (doctor && state !== 'CLOSED') acts.push('close');
  const missing: string[] = [];
  if (state === 'OPEN') {
    if (options.length < 2) missing.push('at least two options (doing nothing can be one)');
    if (!r.tookPart) missing.push('what they want');
  }
  return {
    ...r, state, stateLabel: STATES[state], options, chosen: options.find((o) => o.id === r.chosenId)?.option ?? null,
    tookPartLabel: r.tookPart ? TOOK_PART[String(r.tookPart)] : null, agreedLabel: r.agreed ? AGREED[String(r.agreed)] : null,
    reviewDue: state === 'DECIDED' && !!r.reviewOn && String(r.reviewOn) <= todayLocal(), missing, acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM clinical_decision_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.decision_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

// Doctors' Review / Medical Assessment, and the nurses' Care Plan / Medical Assessment.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  const manages = caps.includes('decision.manage');
  if (!manages && !caps.includes('decision.view')) return null;
  const doctor = manages && may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.raised_at DESC`, personId).map((r) => shape(store, r, doctor));
  if (!manages && !all.length) return null;
  return {
    current: all.filter((x) => x.state !== 'CLOSED'),
    past: all.filter((x) => x.state === 'CLOSED'),
    canRaise: doctor,
    options: doctor ? { tookPart: TOOK_PART, agreed: AGREED } : null,
  };
}

interface Body {
  question?: string; background?: string; option?: string; benefits?: string; risks?: string; theirView?: string; tookPart?: string; tookPartNote?: string; others?: string;
  chosen?: string; reason?: string; agreed?: string; reviewOn?: string; still?: string; note?: string;
}

export function raise(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'DECISION', personId }, personId);
  const question = text(b.question, 200);
  if (question.length < 5) throw new HttpError(400, 'QUESTION_REQUIRED', 'Write what needs deciding, e.g. "Whether to have a gastroscopy for the bleeding".');
  const background = text(b.background, 1500);
  if (background.length < 5) throw new HttpError(400, 'BACKGROUND_REQUIRED', 'Write why it needs deciding now, and what we know.');
  const id = newId();
  store.tx(() => {
    store.insert('clinical_decision', { id, person_id: personId, service_id: ctx.serviceId, question, background, state: 'OPEN', raised_by: ctx.workerId, raised_at: now() });
    recordInitial(store, 'clinical_decision', id, 'OPEN', { actorId: ctx.workerId, workContextId: ctx.id }, question);
    step(store, id, 'RAISED', `${sentence(question)} ${sentence(background)}`, ctx.workerId);
    logged(store, ctx, 'DECISION_RAISE', personId, id, question);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That decision is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'DECISION', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  const must = (ok: boolean) => { if (!ok) throw new HttpError(409, 'STATE', `This decision is ${STATES[state].toLowerCase()}; that cannot be done now.`); };
  store.tx(() => {
    switch (action) {
      case 'option': {
        must(state === 'OPEN');
        const option = text(b.option, 200);
        if (option.length < 2) throw new HttpError(400, 'OPTION_REQUIRED', 'Write the option, e.g. "Gastroscopy today".');
        const benefits = text(b.benefits, 800);
        const risks = text(b.risks, 800);
        if (benefits.length < 3 || risks.length < 3) throw new HttpError(400, 'BENEFITS_RISKS', 'Write the benefits and the risks of this option, as you explained them.');
        store.insert('clinical_decision_option', { id: newId(), decision_id: id, option, benefits, risks, added_by: ctx.workerId, added_at: now() });
        step(store, id, 'OPTION', `Option: ${option}. Benefits: ${sentence(benefits)} Risks: ${sentence(risks)}`, ctx.workerId);
        logged(store, ctx, 'DECISION_OPTION', personId, id, option);
        break;
      }
      case 'view': {
        must(state === 'OPEN');
        const tookPart = pick(TOOK_PART, b.tookPart);
        if (!tookPart) throw new HttpError(400, 'TOOK_PART_REQUIRED', 'Say whether they could take part.');
        const view = text(b.theirView, 1000);
        if (tookPart !== 'NO' && view.length < 5) throw new HttpError(400, 'VIEW_REQUIRED', 'Write what they want, in their words where you can.');
        const note = text(b.tookPartNote, 500);
        if (tookPart !== 'YES' && note.length < 5) throw new HttpError(400, 'TOOK_PART_NOTE', 'Write why they could not fully take part.');
        const others = text(b.others, 500);
        store.run('UPDATE clinical_decision SET their_view = ?, took_part = ?, took_part_note = ?, others = ? WHERE id = ?', view || null, tookPart, note || null, others || null, id);
        step(store, id, 'THEIR_VIEW', `${TOOK_PART[tookPart]}.${note ? ` ${sentence(note)}` : ''}${view ? ` What they want: ${sentence(view)}` : ''}${others ? ` Also involved: ${sentence(others)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'DECISION_VIEW', personId, id, TOOK_PART[tookPart]);
        break;
      }
      case 'decide': {
        must(state === 'OPEN');
        const shaped = shape(store, r, true);
        if (shaped.missing.length) throw new HttpError(409, 'NOT_READY', `Before deciding, add ${shaped.missing.join(' and ')}.`);
        const chosen = store.get<Row>('SELECT id, option FROM clinical_decision_option WHERE id = ? AND decision_id = ?', text(b.chosen, 60), id);
        if (!chosen) throw new HttpError(400, 'CHOSEN_REQUIRED', 'Choose the option decided on.');
        const reason = text(b.reason, 1000);
        if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write why this option.');
        const agreed = pick(AGREED, b.agreed);
        if (!agreed) throw new HttpError(400, 'AGREED_REQUIRED', 'Say whether they agree.');
        if (agreed === 'NOT_AGREED' && reason.length < 20) throw new HttpError(400, 'NOT_AGREED_NOTE', 'They do not agree: write how their view was weighed, and what happens next. If they are refusing treatment, record that under Consent and capacity too.');
        const reviewOn = text(b.reviewOn, 10);
        if (reviewOn && (!DAY.test(reviewOn) || reviewOn <= todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'Choose a date after today to look at it again, or leave it empty.');
        transition(store, 'clinical_decision', id, 'DECIDED', who, String(chosen.option));
        store.run('UPDATE clinical_decision SET chosen_id = ?, reason = ?, agreed = ?, decided_by = ?, decided_at = ?, review_on = ? WHERE id = ?', chosen.id, reason, agreed, ctx.workerId, now(), reviewOn || null, id);
        step(store, id, 'DECIDED', `Decided: ${chosen.option}. ${sentence(reason)} ${AGREED[agreed]}.${reviewOn ? ` Look again on ${reviewOn}.` : ''}`, ctx.workerId);
        logged(store, ctx, 'DECISION_DECIDE', personId, id, `${r.question}: ${chosen.option}`);
        break;
      }
      case 'review': {
        must(state === 'DECIDED');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what has changed, or why it still stands.');
        if (b.still === 'yes') {
          const reviewOn = text(b.reviewOn, 10);
          if (reviewOn && (!DAY.test(reviewOn) || reviewOn <= todayLocal())) throw new HttpError(400, 'REVIEW_DATE', 'Choose a date after today to look at it again, or leave it empty.');
          store.run('UPDATE clinical_decision SET review_on = ? WHERE id = ?', reviewOn || null, id);
          step(store, id, 'REVIEWED', `Still right: ${sentence(say)}${reviewOn ? ` Look again on ${reviewOn}.` : ''}`, ctx.workerId);
          logged(store, ctx, 'DECISION_STILL_RIGHT', personId, id, say);
        } else if (b.still === 'no') {
          transition(store, 'clinical_decision', id, 'OPEN', who, say);
          store.run('UPDATE clinical_decision SET chosen_id = NULL, reason = NULL, agreed = NULL, decided_by = NULL, decided_at = NULL, review_on = NULL WHERE id = ?', id);
          const was = store.get<Row>('SELECT option FROM clinical_decision_option WHERE id = ?', String(r.chosenId))?.option;
          step(store, id, 'REOPENED', `Thinking again: ${sentence(say)}${was ? ` It had been: ${was}.` : ''}`, ctx.workerId);
          logged(store, ctx, 'DECISION_REOPEN', personId, id, say);
        } else throw new HttpError(400, 'STILL_REQUIRED', 'Say whether the decision still stands.');
        break;
      }
      case 'close': {
        must(state !== 'CLOSED');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is closed, e.g. "Done", or "No longer needed: went home".');
        transition(store, 'clinical_decision', id, 'CLOSED', who, say);
        store.run('UPDATE clinical_decision SET closed_note = ? WHERE id = ?', say, id);
        step(store, id, 'CLOSED', `Closed: ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'DECISION_CLOSE', personId, id, say);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
