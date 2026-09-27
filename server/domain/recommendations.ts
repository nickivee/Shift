import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES } from '../config/workstations.ts';
import { CHANNELS, NOT_DONE } from '../config/recommendations.ts';
import { generate as generateRequirement } from './requirements.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Recommendation (the recommendation lifecycle listed under Shared Lifecycle Object 278):
//   assessment → recommendation → recipient → communicated → accepted/declined/modified →
//   implementation requirement → implemented/not implemented → review.
// A clinician records what their assessment found and what they recommend, and to which role
// in which service. Sending it (in SHIFT, in person, by phone or at a meeting) is a separate
// step. The recipient role accepts it, changes it, or declines it with a reason; accepting or
// changing it says what needs doing and by when. The recipient's team records whether it was
// implemented. The recommending side reviews the outcome, which closes it.

type Row = Record<string, string | number | null>;
type Cap = 'recommendation.make' | 'recommendation.respond' | 'recommendation.record';
const STATES: Record<string, string> = {
  RECOMMENDED: 'Not sent yet', COMMUNICATED: 'Waiting for a response', ACCEPTED: 'Accepted', MODIFIED: 'Accepted with changes', DECLINED: 'Declined',
  IMPLEMENTED: 'Implemented', NOT_IMPLEMENTED: 'Not implemented', REVIEWED: 'Reviewed', WITHDRAWN: 'Withdrawn', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  RECOMMENDED: 'Recommended', COMMUNICATED: 'Sent', ACCEPTED: 'Accepted', MODIFIED: 'Accepted with changes', DECLINED: 'Declined',
  IMPLEMENTED: 'Implemented', NOT_IMPLEMENTED: 'Not implemented', REVIEWED: 'Reviewed', WITHDRAWN: 'Withdrawn', ERROR: 'Entered in error',
};
const OPEN = ['RECOMMENDED', 'COMMUNICATED', 'ACCEPTED', 'MODIFIED', 'DECLINED', 'IMPLEMENTED', 'NOT_IMPLEMENTED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-REC-001'];
const roleLabel = (key: string) => ROLES.find((r) => r.roleKey === key)?.label ?? key;

const Q = `
  SELECT r.id, r.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = r.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         r.state, r.basis, r.what, r.from_service_id AS fromServiceId, fs.name AS fromService, r.from_role_key AS fromRoleKey,
         r.to_service_id AS toServiceId, ts.name AS toService, r.to_role_key AS toRoleKey, r.implement_by AS implementBy,
         mb.display_name AS madeBy, r.made_at AS madeAt, r.channel, r.communicated_at AS communicatedAt,
         rb.display_name AS respondedBy, r.responded_at AS respondedAt, r.response, r.modified_what AS modifiedWhat, r.requirement,
         ib.display_name AS implementedBy, r.implemented_at AS implementedAt, r.not_done_reason AS notDoneReason, r.implementation_note AS implementationNote,
         vb.display_name AS reviewedBy, r.reviewed_at AS reviewedAt, r.review_note AS reviewNote
    FROM recommendation r
    JOIN person p ON p.id = r.person_id
    JOIN service fs ON fs.id = r.from_service_id
    JOIN service ts ON ts.id = r.to_service_id
    JOIN workforce_person mb ON mb.id = r.made_by
    LEFT JOIN workforce_person rb ON rb.id = r.responded_by
    LEFT JOIN workforce_person ib ON ib.id = r.implemented_by
    LEFT JOIN workforce_person vb ON vb.id = r.reviewed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string, cap: Cap) => evaluate(store, ctx, { op: 'RECOMMENDATION', personId, cap }).decision === 'ALLOW';
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'recommendation', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('recommendation_log', { id: newId(), recommendation_id: id, kind, body, by_id: ctx.workerId, at: now() });

// Roles, in services of this organisation, that can respond to a recommendation.
export function recipients(store: Store, ctx: WorkContext) {
  const responders = new Set(ROLES.filter((r) => r.capabilities.includes('recommendation.respond')).map((r) => r.roleKey));
  return store.all<{ serviceId: string; service: string; roleKey: string }>(`SELECT DISTINCT p.service_id AS serviceId, s.name AS service, p.role_key AS roleKey
      FROM position p JOIN service s ON s.id = p.service_id
     WHERE s.organisation_id = ? AND (p.end_date IS NULL OR p.end_date >= ?) ORDER BY s.name, p.role_key`, ctx.organisationId, todayLocal())
    .filter((r) => responders.has(r.roleKey) && !(r.serviceId === ctx.serviceId && r.roleKey === ctx.role.roleKey))
    .map((r) => ({ id: `${r.serviceId}|${r.roleKey}`, label: `${roleLabel(r.roleKey)}, ${r.service}` }));
}

const isRecipient = (ctx: WorkContext, r: Row) => ctx.serviceId === r.toServiceId && ctx.role.roleKey === r.toRoleKey;
const isRecommender = (ctx: WorkContext, r: Row) => ctx.serviceId === r.fromServiceId && ctx.role.roleKey === r.fromRoleKey;

function shape(store: Store, ctx: WorkContext | null, r: Row, can: { make: boolean; respond: boolean; record: boolean }) {
  const id = String(r.id);
  const state = String(r.state);
  const actions: string[] = [];
  const recommender = !!ctx && isRecommender(ctx, r) && can.make;
  if (recommender && state === 'RECOMMENDED') actions.push('send');
  if (!!ctx && isRecipient(ctx, r) && can.respond && state === 'COMMUNICATED') actions.push('accept', 'modify', 'decline');
  if (!!ctx && ctx.serviceId === r.toServiceId && can.record && ['ACCEPTED', 'MODIFIED'].includes(state)) actions.push('implemented', 'not-implemented');
  if (recommender && ['DECLINED', 'IMPLEMENTED', 'NOT_IMPLEMENTED'].includes(state)) actions.push('review');
  if (recommender && ['RECOMMENDED', 'COMMUNICATED'].includes(state)) actions.push('withdraw');
  if (recommender && OPEN.includes(state)) actions.push('error');
  return {
    ...r, id, state, stateLabel: STATES[state], fromRole: roleLabel(String(r.fromRoleKey)), toRole: roleLabel(String(r.toRoleKey)),
    channelLabel: r.channel ? CHANNELS[String(r.channel)] ?? String(r.channel) : null,
    notDoneLabel: r.notDoneReason ? NOT_DONE[String(r.notDoneReason)] ?? String(r.notDoneReason) : null,
    mine: recommender || (!!ctx && isRecommender(ctx, r)),
    overdue: ['ACCEPTED', 'MODIFIED'].includes(state) && !!r.implementBy && String(r.implementBy) < todayLocal(),
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM recommendation_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.recommendation_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'recommendation', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That recommendation is no longer in SHIFT.');
  return r;
};

export function make(store: Store, ctx: WorkContext, personId: string,
  b: { basis?: string; what?: string; to?: string; implementBy?: string; channel?: string; note?: string }) {
  enforce(store, ctx, { op: 'RECOMMENDATION', personId, cap: 'recommendation.make' }, personId);
  const basis = text(b.basis, 1000);
  if (basis.length < 5) throw new HttpError(400, 'BASIS_REQUIRED', 'Say what your assessment found, e.g. "Unsteady turning; needs a frame".');
  const what = text(b.what, 500);
  if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say exactly what you recommend.');
  const to = recipients(store, ctx).find((x) => x.id === b.to);
  if (!to) throw new HttpError(400, 'RECIPIENT_REQUIRED', 'Choose who the recommendation is for.');
  const [toService, toRole] = to.id.split('|');
  const implementBy = date(b.implementBy);
  if (b.implementBy && (!implementBy || implementBy < todayLocal())) throw new HttpError(400, 'DATE', 'The date must be today or later.');
  const channel = b.channel ? (CHANNELS[String(b.channel)] ? String(b.channel) : '') : '';
  if (b.channel && !channel) throw new HttpError(400, 'CHANNEL', 'Choose how you told them.');
  const note = text(b.note, 500);
  const id = newId();
  const at = now();
  store.tx(() => {
    store.insert('recommendation', {
      id, person_id: personId, state: 'RECOMMENDED', basis, what, from_service_id: ctx.serviceId, from_role_key: ctx.role.roleKey,
      to_service_id: toService, to_role_key: toRole, implement_by: implementBy || null, made_by: ctx.workerId, made_at: at,
    });
    recordInitial(store, 'recommendation', id, 'RECOMMENDED', { actorId: ctx.workerId, workContextId: ctx.id }, what.slice(0, 200));
    addLog(store, ctx, id, 'RECOMMENDED', `${what}. For ${to.label}. Based on: ${basis}`);
    logged(store, ctx, 'RECOMMENDATION_MAKE', personId, id, what.slice(0, 200));
    if (channel) communicate(store, ctx, id, channel, note);
  });
  return forPerson(store, ctx, personId);
}

function communicate(store: Store, ctx: WorkContext, id: string, channel: string, note: string) {
  const r = load(store, id);
  transition(store, 'recommendation', id, 'COMMUNICATED', { actorId: ctx.workerId, workContextId: ctx.id }, CHANNELS[channel]);
  store.run('UPDATE recommendation SET channel = ?, communicated_at = ? WHERE id = ?', channel, now(), id);
  addLog(store, ctx, id, 'COMMUNICATED', `${CHANNELS[channel]}.${note ? ` ${note}` : ''}`);
  logged(store, ctx, 'RECOMMENDATION_SEND', String(r.personId), id, channel);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; channel?: string; what?: string; requirement?: string; implementBy?: string; reason?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  const cap: Cap = ['accept', 'modify', 'decline'].includes(action) ? 'recommendation.respond'
    : ['implemented', 'not-implemented'].includes(action) ? 'recommendation.record' : 'recommendation.make';
  enforce(store, ctx, { op: 'RECOMMENDATION', personId, cap }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This recommendation is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const recipientOnly = () => { if (!isRecipient(ctx, r)) throw new HttpError(403, 'BLOCK', `Only the ${roleLabel(String(r.toRoleKey))} in ${r.toService} can respond to this.`); };
  const recipientTeam = () => { if (ctx.serviceId !== r.toServiceId) throw new HttpError(403, 'BLOCK', `Only ${r.toService} can record whether this was done.`); };
  const recommenderOnly = () => { if (!isRecommender(ctx, r)) throw new HttpError(403, 'BLOCK', 'Only the side that made this recommendation can do that.'); };
  const requirement = () => {
    const req = text(b.requirement, 500);
    if (req.length < 5) throw new HttpError(400, 'REQUIREMENT_REQUIRED', 'Say what needs doing to put it in place, e.g. "Add to her care plan; walk her to the toilet at night".');
    const by = date(b.implementBy);
    if (b.implementBy && (!by || by < todayLocal())) throw new HttpError(400, 'DATE', 'The date must be today or later.');
    return { req, by: by || (r.implementBy ? String(r.implementBy) : null) };
  };
  switch (action) {
    case 'send': {
      recommenderOnly();
      inState('RECOMMENDED');
      const channel = CHANNELS[String(b.channel)] ? String(b.channel) : '';
      if (!channel) throw new HttpError(400, 'CHANNEL', 'Choose how you told them.');
      store.tx(() => communicate(store, ctx, id, channel, note));
      break;
    }
    case 'accept':
    case 'modify': {
      recipientOnly();
      inState('COMMUNICATED');
      const { req, by } = requirement();
      const modified = action === 'modify' ? text(b.what, 500) : '';
      if (action === 'modify' && (modified.length < 5 || modified === String(r.what))) throw new HttpError(400, 'CHANGE_REQUIRED', 'Write the recommendation as you will carry it out.');
      if (action === 'modify') need(5, 'Write why you changed it.');
      const to = action === 'accept' ? 'ACCEPTED' : 'MODIFIED';
      store.tx(() => {
        transition(store, 'recommendation', id, to, who, (modified || req).slice(0, 200));
        store.run('UPDATE recommendation SET responded_by = ?, responded_at = ?, response = ?, modified_what = ?, requirement = ?, implement_by = ? WHERE id = ?',
          ctx.workerId, at, note || null, modified || null, req, by, id);
        addLog(store, ctx, id, to, `${modified ? `Changed to: ${modified}. ` : ''}${note ? `${note} ` : ''}To do: ${req}${by ? ` by ${by}` : ''}.`);
        logged(store, ctx, `RECOMMENDATION_${to}`, personId, id, req.slice(0, 200));
        // What needs doing becomes a requirement for the recipient's service.
        generateRequirement(store, ctx, {
          personId, serviceId: String(r.toServiceId), what: req, source: 'RECOMMENDATION', sourceId: id, dueBy: by,
          sourceLabel: `${r.madeBy}'s recommendation (${roleLabel(String(r.fromRoleKey))}): ${modified || r.what}`,
        });
      });
      break;
    }
    case 'decline': {
      recipientOnly();
      inState('COMMUNICATED');
      need(5, 'Write why you are declining it.');
      store.tx(() => {
        transition(store, 'recommendation', id, 'DECLINED', who, note.slice(0, 200));
        store.run('UPDATE recommendation SET responded_by = ?, responded_at = ?, response = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx, id, 'DECLINED', note);
        logged(store, ctx, 'RECOMMENDATION_DECLINE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'implemented':
    case 'not-implemented': {
      recipientTeam();
      inState('ACCEPTED', 'MODIFIED');
      const done = action === 'implemented';
      const reason = done ? '' : NOT_DONE[String(b.reason)] ? String(b.reason) : '';
      if (!done && !reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it was not implemented.');
      if (!done) need(5, 'Write what happened instead.');
      const to = done ? 'IMPLEMENTED' : 'NOT_IMPLEMENTED';
      store.tx(() => {
        transition(store, 'recommendation', id, to, who, note.slice(0, 200) || to);
        store.run('UPDATE recommendation SET implemented_by = ?, implemented_at = ?, not_done_reason = ?, implementation_note = ? WHERE id = ?', ctx.workerId, at, reason || null, note || null, id);
        addLog(store, ctx, id, to, `${reason ? `${NOT_DONE[reason]}. ` : ''}${note || (done ? 'Done.' : '')}`);
        logged(store, ctx, `RECOMMENDATION_${to}`, personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'review': {
      recommenderOnly();
      inState('DECLINED', 'IMPLEMENTED', 'NOT_IMPLEMENTED');
      need(5, 'Write what you found when you reviewed it, e.g. "Walking safely with the frame; no falls".');
      store.tx(() => {
        transition(store, 'recommendation', id, 'REVIEWED', who, note.slice(0, 200));
        store.run('UPDATE recommendation SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx, id, 'REVIEWED', note);
        logged(store, ctx, 'RECOMMENDATION_REVIEW', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'withdraw':
    case 'error': {
      recommenderOnly();
      if (action === 'withdraw') { inState('RECOMMENDED', 'COMMUNICATED'); need(5, 'Write why you are withdrawing it.'); }
      else { inState(...OPEN); need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".'); }
      const to = action === 'withdraw' ? 'WITHDRAWN' : 'ENTERED_IN_ERROR';
      store.tx(() => {
        transition(store, 'recommendation', id, to, who, note.slice(0, 200));
        store.run('UPDATE recommendation SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addLog(store, ctx, id, action === 'withdraw' ? 'WITHDRAWN' : 'ERROR', note);
        logged(store, ctx, action === 'withdraw' ? 'RECOMMENDATION_WITHDRAW' : 'RECOMMENDATION_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Recommendations view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = { make: may(store, ctx, personId, 'recommendation.make'), respond: may(store, ctx, personId, 'recommendation.respond'), record: may(store, ctx, personId, 'recommendation.record') };
  const all = store.all<Row>(`${Q} WHERE r.person_id = ? ORDER BY r.made_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canMake: can.make,
    options: { recipients: can.make ? recipients(store, ctx) : [], channels: CHANNELS, notDone: NOT_DONE },
  };
}

// Home → Recommendations: to respond to, to implement, to review.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('recommendation.make') && !ctx.role.capabilities.includes('recommendation.respond')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include recommendations`);
  }
  const can = { make: true, respond: ctx.role.capabilities.includes('recommendation.respond'), record: ctx.role.capabilities.includes('recommendation.record') };
  const rows = store.all<Row>(`${Q} WHERE r.state IN ('COMMUNICATED', 'ACCEPTED', 'MODIFIED', 'DECLINED', 'IMPLEMENTED', 'NOT_IMPLEMENTED')
      AND (r.to_service_id = ? OR (r.from_service_id = ? AND r.from_role_key = ?)) ORDER BY r.made_at`, ctx.serviceId, ctx.serviceId, ctx.role.roleKey)
    .map((r) => shape(store, ctx, r, can));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_RECOMMENDATIONS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toRespond: rows.filter((r) => r.actions.includes('accept')),
    toImplement: rows.filter((r) => r.actions.includes('implemented')),
    toReview: rows.filter((r) => r.actions.includes('review')),
    waiting: rows.filter((r) => r.mine && r.state === 'COMMUNICATED'),
  };
}
