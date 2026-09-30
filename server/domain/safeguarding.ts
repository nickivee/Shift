import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { KINDS, HOW, SHARE, STEPS, RISK, TO, CLOSE, FOLLOW_DAYS, REFS } from '../config/safeguarding.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Safeguarding, family violence and elder abuse (entries 148, 149):
//   concern or disclosure → safe now → risk assessed → what the person wants, and whether they agree
//   to information being shared → referred or told → safety plan → followed up → closed.
// Details are private. Anyone caring for the person can raise a concern; only nurses and doctors
// who work safeguarding concerns (safeguarding.manage) can read them, and every time they do is
// audited. The person who raised a concern sees what they wrote and whether it is being worked.
// Everyone else who opens the record sees only that there is a concern and to check with the
// nurse in charge before sharing information. When a report must be made, and when information
// may be shared without the person's agreement, are RR-SAFE-001: SHIFT records who decided and why.
// Only the private steps table holds what was said: transitions, revisions and audit reasons, which
// other screens show, carry labels only.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');
const daysFrom = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

const mayManage = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'SAFEGUARD', personId }).decision === 'ALLOW';
const mayRaise = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'SAFEGUARD_RAISE', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string | null, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'safeguard', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string, to: string | null = null) =>
  store.insert('safeguard_step', { id: newId(), safeguard_id: id, kind, to_whom: to, body, by_id: by, at: now() });

const Q = `
  SELECT s.id, s.person_id AS personId, s.kind, s.how, s.concern, s.involved, s.share, s.wishes, s.risk, s.state, s.follow_due AS followDue,
         s.raised_by AS raisedById, rb.display_name AS raisedBy, s.raised_at AS raisedAt,
         cb.display_name AS closedBy, s.closed_at AS closedAt, s.close_reason AS closeReason, s.close_note AS closeNote
    FROM safeguard s
    JOIN workforce_person rb ON rb.id = s.raised_by
    LEFT JOIN workforce_person cb ON cb.id = s.closed_by`;

function shape(store: Store, r: Row, full: boolean) {
  const state = String(r.state);
  const base = {
    id: r.id, state, kind: r.kind, kindLabel: KINDS[String(r.kind)], raisedBy: r.raisedBy, raisedAt: r.raisedAt,
    stateLabel: state === 'RAISED' ? 'Waiting for a nurse or doctor' : state === 'WORKING' ? 'Being worked on' : 'Closed',
  };
  if (!full) return { ...base, full: false, concern: r.concern, howLabel: HOW[String(r.how)] };
  return {
    ...base, full: true, how: r.how, howLabel: HOW[String(r.how)], concern: r.concern, involved: r.involved, share: r.share, shareLabel: SHARE[String(r.share)],
    wishes: r.wishes, risk: r.risk, riskLabel: r.risk ? RISK[String(r.risk)] : null, followDue: r.followDue,
    overdue: state !== 'CLOSED' && !!r.followDue && String(r.followDue) < now(),
    closedBy: r.closedBy, closedAt: r.closedAt, closeLabel: r.closeReason ? CLOSE[String(r.closeReason)] : null, closeNote: r.closeNote,
    actions: state === 'CLOSED' ? [] : ['safety', 'assess', 'refer', 'plan', 'followup', 'share', 'close'],
    steps: store.all<Row>(
      'SELECT t.kind, t.to_whom AS "to", t.body, w.display_name AS "by", t.at FROM safeguard_step t JOIN workforce_person w ON w.id = t.by_id WHERE t.safeguard_id = ? ORDER BY t.at, t.rowid', String(r.id),
    ).map((t) => ({ ...t, kindLabel: STEPS[String(t.kind)] ?? (t.kind === 'RAISED' ? 'Raised' : t.kind === 'CLOSED' ? 'Closed' : t.kind === 'SHARE' ? 'Sharing' : t.kind), toLabel: t.to ? TO[String(t.to)] : null })),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = mayManage(store, ctx, personId);
  const raise = manage || mayRaise(store, ctx, personId);
  const rows = store.all<Row>(`${Q} WHERE s.person_id = ? ORDER BY s.state = 'CLOSED', s.raised_at DESC`, personId);
  // Details only for those who work concerns, or the person who raised it (their own words only).
  const seen = manage ? rows : rows.filter((r) => r.raisedById === ctx.workerId);
  if (manage && rows.length) logged(store, ctx, 'SAFEGUARD_VIEW', personId, null, `Read ${rows.length} safeguarding concern(s)`);
  return {
    concerns: seen.map((r) => shape(store, r, manage)),
    others: rows.length - seen.length,
    canManage: manage, canRaise: raise,
    options: { kinds: KINDS, how: HOW, share: SHARE, risk: RISK, to: TO, close: CLOSE, followDays: FOLLOW_DAYS },
  };
}

// For the record header: that there is a concern, never what it is.
export function current(store: Store, personId: string) {
  const n = Number(store.get<{ n: number }>("SELECT count(*) AS n FROM safeguard WHERE person_id = ? AND state != 'CLOSED'", personId)?.n ?? 0);
  return n ? { open: n } : null;
}

export function raise(store: Store, ctx: WorkContext, personId: string, b: { kind?: string; how?: string; concern?: string; involved?: string; share?: string; wishes?: string }) {
  const manage = mayManage(store, ctx, personId);
  enforce(store, ctx, { op: manage ? 'SAFEGUARD' : 'SAFEGUARD_RAISE', personId }, personId);
  const kind = pick(KINDS, b.kind);
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of concern it is.');
  const how = pick(HOW, b.how);
  if (!how) throw new HttpError(400, 'HOW_REQUIRED', 'Choose how you know.');
  const concern = text(b.concern);
  if (concern.length < 15) throw new HttpError(400, 'CONCERN_REQUIRED', 'Write what you saw or heard, in their words where you can.');
  const share = pick(SHARE, b.share);
  if (!share) throw new HttpError(400, 'SHARE_REQUIRED', 'Choose whether they agree to information being shared, or why you could not ask.');
  const id = newId();
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    store.insert('safeguard', {
      id, person_id: personId, service_id: ctx.serviceId, kind, how, concern, involved: text(b.involved, 300) || null, share, wishes: text(b.wishes, 500) || null,
      risk: null, state: 'RAISED', follow_due: null, raised_by: ctx.workerId, raised_at: now(),
    });
    recordInitial(store, 'safeguard', id, 'RAISED', who, KINDS[kind]);
    step(store, id, 'RAISED', `${KINDS[kind]}. ${HOW[how]}. ${SHARE[share]}.`, ctx.workerId);
    // The task says only that there is a concern: task lists are seen by the whole team.
    if (!manage) {
      const taskId = newId();
      store.insert('task', {
        id: taskId, person_id: personId, source_event_id: null, service_id: ctx.serviceId, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: now(), due_at: null,
        description: 'A safeguarding concern has been raised. A nurse or doctor needs to open Incidents and safeguarding today. The details are private.',
      });
      recordInitial(store, 'task', taskId, 'CREATED', who, 'Safeguarding concern raised');
    }
    logged(store, ctx, 'SAFEGUARD_RAISE', personId, id, KINDS[kind]);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; risk?: string; to?: string; why?: string; followDays?: unknown; share?: string; reason?: string }) {
  const r = store.get<Row>(`${Q} WHERE s.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That concern is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: 'SAFEGUARD', personId }, personId);
  if (r.state === 'CLOSED') throw new HttpError(409, 'CLOSED', 'This concern is closed. Raise a new one if there is a new concern.');
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const need = (n: number, msg: string) => { if (say.length < n) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const follow = () => {
    const d = Number(b.followDays);
    if (!FOLLOW_DAYS.includes(d)) throw new HttpError(400, 'FOLLOW_REQUIRED', 'Choose when to follow up.');
    store.run('UPDATE safeguard SET follow_due = ? WHERE id = ?', daysFrom(d), id);
  };
  store.tx(() => {
    if (r.state === 'RAISED' && action !== 'close') transition(store, 'safeguard', id, 'WORKING', who, STEPS[action] ?? action);
    switch (action) {
      case 'safety':
        need(10, 'Write what was done to keep them safe now, e.g. "Moved to a cubicle away from the waiting room; partner asked to wait outside".');
        step(store, id, 'SAFETY', say, ctx.workerId);
        break;
      case 'assess': {
        const risk = pick(RISK, b.risk);
        if (!risk) throw new HttpError(400, 'RISK_REQUIRED', 'Choose how much risk you judge there is.');
        need(10, 'Write what you found and who else is at risk, including children.');
        store.run('UPDATE safeguard SET risk = ? WHERE id = ?', risk, id);
        step(store, id, 'ASSESSED', `${RISK[risk]}. ${say}`, ctx.workerId);
        break;
      }
      case 'refer': {
        const to = pick(TO, b.to);
        if (!to) throw new HttpError(400, 'TO_REQUIRED', 'Choose who was told or referred to.');
        need(5, 'Write who you spoke with and what was agreed.');
        // Sharing without the person's agreement: SHIFT records who decided and why, not whether it was lawful.
        const why = text(b.why, 500);
        if (r.share !== 'AGREED' && why.length < 10) {
          throw new HttpError(400, 'WHY_REQUIRED', `${SHARE[String(r.share)]}. Write why information is being shared anyway and who decided. When that is allowed is still being researched (RR-SAFE-001).`);
        }
        step(store, id, 'REFERRED', `${say}${r.share !== 'AGREED' ? ` Shared without their agreement because: ${why}` : ''}`, ctx.workerId, to);
        break;
      }
      case 'plan':
        need(10, 'Write the safety plan, e.g. "Visits from her son only with staff present; she has the Shine helpline number".');
        follow();
        step(store, id, 'PLAN', say, ctx.workerId);
        break;
      case 'followup':
        need(10, 'Write what you found when you followed up.');
        follow();
        step(store, id, 'FOLLOWUP', say, ctx.workerId);
        break;
      case 'share': {
        const share = pick(SHARE, b.share);
        if (!share) throw new HttpError(400, 'SHARE_REQUIRED', 'Choose what they now say about sharing.');
        need(5, 'Write what they said.');
        const changed = revise(store, 'safeguard', id, { share: r.share }, { share }, { share: ['Sharing', SHARE] }, who, 'Sharing changed');
        if (!changed) throw new HttpError(409, 'UNCHANGED', 'Nothing was changed.');
        store.run('UPDATE safeguard SET share = ? WHERE id = ?', share, id);
        step(store, id, 'SHARE', `${SHARE[String(r.share)]} → ${SHARE[share]}. ${say}`, ctx.workerId);
        break;
      }
      case 'close': {
        const reason = pick(CLOSE, b.reason);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the concern is closing.');
        need(10, 'Write what was done and who it was handed on to.');
        transition(store, 'safeguard', id, 'CLOSED', who, CLOSE[reason]);
        store.run('UPDATE safeguard SET closed_by = ?, closed_at = ?, close_reason = ?, close_note = ? WHERE id = ?', ctx.workerId, now(), reason, say, id);
        step(store, id, 'CLOSED', `${CLOSE[reason]}. ${say}`, ctx.workerId);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
    logged(store, ctx, `SAFEGUARD_${action.toUpperCase()}`, personId, id, STEPS[action] ?? action);
  });
  return forPerson(store, ctx, personId);
}
