import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { KINDS, KIND_BY_ID, CHANNELS, FINDINGS, OUTCOMES, EXIT_REASONS, OFFER_SOON_DAYS } from '../config/screening.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Screening Episode (Shared Lifecycle Object 286):
//   eligibility → invitation/offer → participation decision → screening action → result → review →
//   communication → recall OR diagnostic escalation OR programme exit.
// Someone records why a person is eligible for a screen and when it is due. The screen is offered;
// the person accepts, declines, or wants time to think. If they accept, the screen is done and the
// result recorded. Someone who can review screening looks at the result, the person is told, and
// the episode closes with a next screen, further tests or referral, or no more screening. Declining
// is the person's right: it is recorded in their words, and the offer can be made again later.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  ELIGIBLE: 'Not offered yet', OFFERED: 'Offered, waiting for their decision', ACCEPTED: 'Accepted, to be screened', DECLINED: 'Declined',
  SCREENED: 'Screened, waiting for the result', RESULTED: 'Result to review', REVIEWED: 'Reviewed, to tell them', COMMUNICATED: 'Told, to close',
  CLOSED: 'Closed', EXITED: 'Ended', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  ELIGIBLE: 'Eligible', OFFERED: 'Offered', LATER: 'Wants time to decide', ACCEPTED: 'Accepted', DECLINED: 'Declined', SCREENED: 'Screened',
  RESULT: 'Result', REVIEWED: 'Reviewed', TOLD: 'Told', CLOSED: 'Closed', NEXT: 'Next screen set', EXITED: 'Ended', ERROR: 'Entered in error',
};
const OPEN = ['ELIGIBLE', 'OFFERED', 'ACCEPTED', 'SCREENED', 'RESULTED', 'REVIEWED', 'COMMUNICATED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-SCREEN-001'];

const Q = `
  SELECT x.id, x.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = x.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         x.service_id AS serviceId, s.name AS service, x.kind, x.what, x.test, x.eligibility, x.due_date AS dueDate, x.state,
         x.previous_id AS previousId, x.next_id AS nextId, sb.display_name AS setBy, x.set_by AS setById, x.set_at AS setAt,
         ob.display_name AS offeredBy, x.offered_at AS offeredAt, x.channel, x.offer_note AS offerNote,
         db.display_name AS decidedBy, x.decided_at AS decidedAt, x.decision_note AS decisionNote,
         kb.display_name AS screenedBy, x.screened_at AS screenedAt, x.screen_note AS screenNote,
         rb.display_name AS resultBy, x.result_at AS resultAt, x.result, x.finding,
         vb.display_name AS reviewedBy, x.reviewed_at AS reviewedAt, x.review_note AS reviewNote,
         tb.display_name AS toldBy, x.told_at AS toldAt, x.told_channel AS toldChannel, x.told_note AS toldNote,
         x.outcome, x.outcome_note AS outcomeNote, cb.display_name AS closedBy, x.closed_at AS closedAt,
         x.exit_reason AS exitReason, eb.display_name AS endedBy, x.ended_at AS endedAt, x.ended_note AS endedNote
    FROM screening x
    JOIN person p ON p.id = x.person_id
    JOIN service s ON s.id = x.service_id
    JOIN workforce_person sb ON sb.id = x.set_by
    LEFT JOIN workforce_person ob ON ob.id = x.offered_by
    LEFT JOIN workforce_person db ON db.id = x.decided_by
    LEFT JOIN workforce_person kb ON kb.id = x.screened_by
    LEFT JOIN workforce_person rb ON rb.id = x.result_by
    LEFT JOIN workforce_person vb ON vb.id = x.reviewed_by
    LEFT JOIN workforce_person tb ON tb.id = x.told_by
    LEFT JOIN workforce_person cb ON cb.id = x.closed_by
    LEFT JOIN workforce_person eb ON eb.id = x.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'SCREENING', personId }).decision === 'ALLOW';
const reviewer = (ctx: WorkContext) => ctx.role.capabilities.includes('screening.review');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'screening', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('screening_log', { id: newId(), screening_id: id, kind, body, by_id: ctx.workerId, at: now() });

function create(store: Store, ctx: WorkContext, x: { personId: string; kind: string; what: string; test: string; eligibility: string; dueDate: string; previousId: string | null }) {
  const id = newId();
  store.insert('screening', {
    id, person_id: x.personId, service_id: ctx.serviceId, kind: x.kind, what: x.what, test: x.test, eligibility: x.eligibility, due_date: x.dueDate,
    state: 'ELIGIBLE', previous_id: x.previousId, set_by: ctx.workerId, set_at: now(),
  });
  recordInitial(store, 'screening', id, 'ELIGIBLE', { actorId: ctx.workerId, workContextId: ctx.id }, `${x.what} due ${x.dueDate}`);
  addLog(store, ctx, id, 'ELIGIBLE', `${x.eligibility} Due ${x.dueDate}.`);
  return id;
}

function shape(ctx: WorkContext, store: Store, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const today = todayLocal();
  const due = String(r.dueDate);
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (state === 'ELIGIBLE') actions.push('offer');
    if (state === 'OFFERED') actions.push('decide');
    if (state === 'ACCEPTED') actions.push('screen', 'decline');
    if (state === 'SCREENED') actions.push('result');
    if (state === 'RESULTED' && reviewer(ctx)) actions.push('review');
    if (state === 'REVIEWED') actions.push('tell');
    if (state === 'COMMUNICATED' && reviewer(ctx)) actions.push('close');
    if (['ELIGIBLE', 'OFFERED', 'ACCEPTED'].includes(state)) actions.push('exit');
    if (OPEN.includes(state)) actions.push('error');
  }
  const kind = KIND_BY_ID.get(String(r.kind));
  return {
    ...r, id, state, stateLabel: STATES[state], dueDate: due, finding: r.finding as string | null,
    kindLabel: kind?.label ?? String(r.kind),
    channelLabel: r.channel ? CHANNELS[String(r.channel)] ?? String(r.channel) : null,
    toldLabel: r.toldChannel ? CHANNELS[String(r.toldChannel)] ?? String(r.toldChannel) : null,
    findingLabel: r.finding ? FINDINGS[String(r.finding)] ?? String(r.finding) : null,
    outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] ?? String(r.outcome) : null,
    exitLabel: r.exitReason ? EXIT_REASONS[String(r.exitReason)] ?? String(r.exitReason) : null,
    overdue: state === 'ELIGIBLE' && due < today,
    offerSoon: state === 'ELIGIBLE' && due <= addDays(today, OFFER_SOON_DAYS),
    abnormal: ['RESULTED', 'REVIEWED', 'COMMUNICATED'].includes(state) && r.finding === 'ABNORMAL',
    nextDue: kind?.everyDays ? addDays(today, kind.everyDays) : null,
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM screening_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.screening_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'screening', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE x.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That screening episode is no longer in SHIFT.');
  return r;
};

export function start(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; what?: string; test?: string; eligibility?: string; dueDate?: string }) {
  enforce(store, ctx, { op: 'SCREENING', personId }, personId);
  const kind = KIND_BY_ID.get(String(b.kind));
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the screen.');
  const what = text(b.what, 200) || (kind.id === 'OTHER' ? '' : kind.label);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what the screen is for.');
  const test = text(b.test, 300) || kind.test;
  if (test.length < 3) throw new HttpError(400, 'TEST_REQUIRED', 'Say what the screen involves.');
  const eligibility = text(b.eligibility, 1000);
  if (eligibility.length < 5) throw new HttpError(400, 'ELIGIBILITY_REQUIRED', 'Say why they are eligible, e.g. "Type 2 diabetes; last eye screen over two years ago".');
  const dueDate = date(b.dueDate);
  if (!dueDate || dueDate < addDays(todayLocal(), -365) || dueDate > addDays(todayLocal(), 3 * 365)) throw new HttpError(400, 'DATE', 'Choose when the screen is due.');
  store.tx(() => {
    const id = create(store, ctx, { personId, kind: kind.id, what, test, eligibility, dueDate, previousId: null });
    logged(store, ctx, 'SCREENING_START', personId, id, what);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; channel?: string; decision?: string; when?: string; result?: string; finding?: string; outcome?: string; nextDue?: string; reason?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'SCREENING', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This screening belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This screening is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const mustReview = () => { if (!reviewer(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot review screening. Ask the doctor or registered nurse responsible.`); };
  const channel = () => {
    const c = CHANNELS[String(b.channel)] ? String(b.channel) : '';
    if (!c) throw new HttpError(400, 'CHANNEL', 'Choose how.');
    if (c === 'WHANAU') need(5, 'Say who you spoke to.');
    return c;
  };
  const again = (due: string, eligibility: string) => {
    const nextId = create(store, ctx, { personId, kind: String(r.kind), what: String(r.what), test: String(r.test), eligibility, dueDate: due, previousId: id });
    store.run('UPDATE screening SET next_id = ? WHERE id = ?', nextId, id);
    addLog(store, ctx, id, 'NEXT', `Next screen due ${due}.`);
  };
  const end = (to: 'EXITED' | 'ENTERED_IN_ERROR', reason: string | null) => {
    transition(store, 'screening', id, to, who, note.slice(0, 200));
    store.run('UPDATE screening SET exit_reason = ?, ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', reason, ctx.workerId, at, note, id);
  };
  switch (action) {
    case 'offer': {
      inState('ELIGIBLE');
      const c = channel();
      store.tx(() => {
        transition(store, 'screening', id, 'OFFERED', who, CHANNELS[c]);
        store.run('UPDATE screening SET offered_by = ?, offered_at = ?, channel = ?, offer_note = ? WHERE id = ?', ctx.workerId, at, c, note || null, id);
        addLog(store, ctx, id, 'OFFERED', `${CHANNELS[c]}.${note ? ` ${note}` : ''}`);
        logged(store, ctx, 'SCREENING_OFFER', personId, id, c);
      });
      break;
    }
    case 'decide':
    case 'decline': {
      const decision = action === 'decline' ? 'DECLINE' : String(b.decision);
      if (action === 'decline') inState('ACCEPTED'); else inState('OFFERED');
      if (!['ACCEPT', 'DECLINE', 'LATER'].includes(decision)) throw new HttpError(400, 'DECISION_REQUIRED', 'Choose what they decided.');
      if (decision === 'DECLINE') {
        need(3, 'Write what they said, in their words if you can.');
        const offerAgain = date(b.nextDue);
        if (offerAgain && offerAgain <= todayLocal()) throw new HttpError(400, 'DATE', 'Choose a date after today to offer again, or leave it empty.');
        store.tx(() => {
          transition(store, 'screening', id, 'DECLINED', who, note.slice(0, 200));
          store.run('UPDATE screening SET decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', ctx.workerId, at, note, id);
          addLog(store, ctx, id, 'DECLINED', note);
          if (offerAgain) again(offerAgain, 'Declined last time; to be offered again.');
          logged(store, ctx, 'SCREENING_DECLINE', personId, id, note.slice(0, 200));
        });
      } else if (decision === 'LATER') {
        need(3, 'Write what they said, e.g. "Wants to talk to her daughter first".');
        store.tx(() => {
          transition(store, 'screening', id, 'OFFERED', who, 'Wants time to decide');
          addLog(store, ctx, id, 'LATER', note);
          logged(store, ctx, 'SCREENING_LATER', personId, id, note.slice(0, 200));
        });
      } else {
        store.tx(() => {
          transition(store, 'screening', id, 'ACCEPTED', who, note.slice(0, 200) || undefined);
          store.run('UPDATE screening SET decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
          addLog(store, ctx, id, 'ACCEPTED', note || 'Agreed to the screen.');
          logged(store, ctx, 'SCREENING_ACCEPT', personId, id);
        });
      }
      break;
    }
    case 'screen': {
      inState('ACCEPTED');
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when > Date.now() + 5 * 60_000 || when < Date.now() - 30 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it was done, in the last month and not in the future.');
      store.tx(() => {
        transition(store, 'screening', id, 'SCREENED', who, note.slice(0, 200) || undefined);
        store.run('UPDATE screening SET screened_by = ?, screened_at = ?, screen_note = ? WHERE id = ?', ctx.workerId, new Date(when).toISOString(), note || null, id);
        addLog(store, ctx, id, 'SCREENED', note || 'Done. Result to follow.');
        logged(store, ctx, 'SCREENING_SCREENED', personId, id);
      });
      break;
    }
    case 'result': {
      inState('SCREENED');
      const result = text(b.result, 1000);
      if (result.length < 2) throw new HttpError(400, 'RESULT_REQUIRED', 'Write the result, e.g. "MoCA 21/30; lost points on recall".');
      const finding = FINDINGS[String(b.finding)] ? String(b.finding) : '';
      if (!finding) throw new HttpError(400, 'FINDING_REQUIRED', 'Say whether the screen is normal, abnormal or inconclusive.');
      store.tx(() => {
        transition(store, 'screening', id, 'RESULTED', who, FINDINGS[finding]);
        store.run('UPDATE screening SET result_by = ?, result_at = ?, result = ?, finding = ? WHERE id = ?', ctx.workerId, at, result, finding, id);
        addLog(store, ctx, id, 'RESULT', `${result} (${FINDINGS[finding].toLowerCase()}).`);
        logged(store, ctx, 'SCREENING_RESULT', personId, id, finding);
      });
      break;
    }
    case 'review': {
      mustReview();
      inState('RESULTED');
      need(5, 'Write your review, e.g. "Abnormal; refer to the memory clinic".');
      store.tx(() => {
        transition(store, 'screening', id, 'REVIEWED', who, note.slice(0, 200));
        store.run('UPDATE screening SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx, id, 'REVIEWED', note);
        logged(store, ctx, 'SCREENING_REVIEW', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'tell': {
      inState('REVIEWED');
      const c = channel();
      need(5, 'Write what you told them and what they understood.');
      store.tx(() => {
        transition(store, 'screening', id, 'COMMUNICATED', who, CHANNELS[c]);
        store.run('UPDATE screening SET told_by = ?, told_at = ?, told_channel = ?, told_note = ? WHERE id = ?', ctx.workerId, at, c, note, id);
        addLog(store, ctx, id, 'TOLD', `${CHANNELS[c]}. ${note}`);
        logged(store, ctx, 'SCREENING_TOLD', personId, id, c);
      });
      break;
    }
    case 'close': {
      mustReview();
      inState('COMMUNICATED');
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what happens next.');
      const nextDue = outcome === 'RECALL' ? date(b.nextDue) : '';
      if (outcome === 'RECALL' && (!nextDue || nextDue <= todayLocal())) throw new HttpError(400, 'DATE', 'Choose when the next screen is due, after today.');
      const reason = outcome === 'EXIT' ? (EXIT_REASONS[String(b.reason)] ? String(b.reason) : '') : '';
      if (outcome === 'EXIT' && !reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why screening is ending.');
      if (outcome === 'ESCALATE') need(5, 'Say what further tests or referral, e.g. "Referred to the memory clinic".');
      if (r.finding === 'ABNORMAL' && outcome !== 'ESCALATE' && reason !== 'DIAGNOSED') {
        throw new HttpError(400, 'ABNORMAL', 'An abnormal screen needs further tests or referral, unless the condition is already diagnosed.');
      }
      store.tx(() => {
        transition(store, 'screening', id, 'CLOSED', who, OUTCOMES[outcome]);
        store.run('UPDATE screening SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ?, exit_reason = ? WHERE id = ?', outcome, note || null, ctx.workerId, at, reason || null, id);
        addLog(store, ctx, id, 'CLOSED', `${OUTCOMES[outcome]}${reason ? `: ${EXIT_REASONS[reason].toLowerCase()}` : ''}.${note ? ` ${note}` : ''}`);
        if (nextDue) again(nextDue, 'Due again after the last screen.');
        logged(store, ctx, `SCREENING_${outcome}`, personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'exit': {
      inState('ELIGIBLE', 'OFFERED', 'ACCEPTED');
      const reason = EXIT_REASONS[String(b.reason)] ? String(b.reason) : '';
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why this is ending.');
      need(5, 'Say what happened.');
      store.tx(() => {
        end('EXITED', reason);
        addLog(store, ctx, id, 'EXITED', `${EXIT_REASONS[reason]}. ${note}`);
        logged(store, ctx, 'SCREENING_EXIT', personId, id, reason);
      });
      break;
    }
    case 'error': {
      inState(...OPEN);
      need(10, 'Write why this was entered in error, e.g. "Set up for the wrong person".');
      store.tx(() => {
        end('ENTERED_IN_ERROR', null);
        addLog(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'SCREENING_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Screening view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE x.person_id = ? ORDER BY x.due_date DESC, x.set_at DESC`, personId).map((r) => shape(ctx, store, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canStart: can,
    options: { kinds: KINDS, channels: CHANNELS, findings: FINDINGS, outcomes: OUTCOMES, exitReasons: EXIT_REASONS },
  };
}

// Home → Screening for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('screening.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include screening`);
  const rows = store.all<Row>(`${Q} WHERE x.service_id = ? AND x.state IN ('ELIGIBLE', 'OFFERED', 'ACCEPTED', 'SCREENED', 'RESULTED', 'REVIEWED', 'COMMUNICATED') ORDER BY x.due_date`, ctx.serviceId)
    .map((r) => shape(ctx, store, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_SCREENING', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toReview: rows.filter((x) => x.state === 'RESULTED').sort((a, b) => Number(b.finding === 'ABNORMAL') - Number(a.finding === 'ABNORMAL')),
    toTell: rows.filter((x) => x.state === 'REVIEWED' || x.state === 'COMMUNICATED'),
    toOffer: rows.filter((x) => x.offerSoon || x.state === 'OFFERED'),
    inProgress: rows.filter((x) => x.state === 'ACCEPTED' || x.state === 'SCREENED'),
    canReview: reviewer(ctx),
  };
}
