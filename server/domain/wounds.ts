import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history, revise } from './lifecycle.ts';
import { KEY_BY_CODE } from '../config/keys.ts';
import { render } from './commands.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Wound (Shared Lifecycle Object 213):
//   identified → initial assessment → treatment plan → serial reassessment →
//   improving / static / deteriorating → healed OR closed.
// Anyone who can identify a wound may report one; assessment, plan and healing are for the
// roles that manage wounds. Trend is the assessor's judgement; SHIFT calculates area only
// as a reference and never decides that a wound is deteriorating.

type Row = Record<string, string | number | null>;
export const KINDS = ['Pressure injury', 'Skin tear', 'Surgical', 'Leg ulcer', 'Burn', 'Other'];
export const TRENDS = ['IMPROVING', 'STATIC', 'DETERIORATING'];
const OPTIONS = {
  stage: ['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Unstageable', 'Deep tissue injury', 'Not applicable'],
  bed: ['Epithelialising', 'Granulating', 'Sloughy', 'Necrotic', 'Mixed'],
  exudate: ['Nil', 'Low', 'Moderate', 'High'],
  surrounding: ['Healthy', 'Red', 'Macerated', 'Dry or scaly', 'Swollen'],
  complication: ['None', 'Signs of infection', 'Bleeding', 'Increasing pain', 'Other'],
};

const SELECT = `
  SELECT w.id, w.state, w.site, w.kind, w.description, w.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = w.person_id AND e.service_id = w.service_id AND e.state = 'ACTIVE' LIMIT 1) AS location,
         ib.display_name AS identifiedBy, w.identified_at AS identifiedAt, w.plan, w.review_days AS reviewDays, pb.display_name AS planBy,
         w.plan_at AS planAt, w.next_review AS nextReview, cb.display_name AS closedBy, w.closed_at AS closedAt, w.close_reason AS closeReason
    FROM wound w
    JOIN person p ON p.id = w.person_id
    JOIN workforce_person ib ON ib.id = w.identified_by
    LEFT JOIN workforce_person pb ON pb.id = w.plan_by
    LEFT JOIN workforce_person cb ON cb.id = w.closed_by`;

const OPEN = "('IDENTIFIED', 'ASSESSED', 'PLANNED')";

function assessments(store: Store, woundId: string) {
  return store.all<Row>(
    `SELECT a.id, a.assessed_at AS at, w.display_name AS by, a.length_mm AS lengthMm, a.width_mm AS widthMm, a.depth_mm AS depthMm,
            a.stage, a.bed, a.exudate, a.surrounding, a.pain, a.trend, a.complication, a.dressing, a.note
       FROM wound_assessment a JOIN workforce_person w ON w.id = a.assessed_by WHERE a.wound_id = ? ORDER BY a.assessed_at DESC`, woundId,
  );
}

function shape(store: Store, ctx: WorkContext, w: Row) {
  const list = assessments(store, String(w.id));
  const open = ['IDENTIFIED', 'ASSESSED', 'PLANNED'].includes(String(w.state));
  const manage = open && evaluate(store, ctx, { op: 'WOUND', personId: String(w.personId), cap: 'wound.manage' }).decision === 'ALLOW';
  const actions: string[] = [];
  if (manage) {
    actions.push('assess');
    if (w.state !== 'IDENTIFIED') actions.push('plan');
    if (w.state !== 'IDENTIFIED') actions.push('heal');
    actions.push('close');
  }
  const latest = list[0] ?? null;
  const due = open && w.nextReview ? String(w.nextReview) <= todayLocal() : false;
  return { ...w, assessments: list, latest, due, actions, history: history(store, 'wound', String(w.id)) };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'wound', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [213],
  });
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const rows = store.all<Row>(`${SELECT} WHERE w.person_id = ? ORDER BY CASE WHEN w.state IN ${OPEN} THEN 0 ELSE 1 END, w.identified_at DESC`, personId);
  const can = (cap: 'wound.identify' | 'wound.manage') => evaluate(store, ctx, { op: 'WOUND', personId, cap }).decision === 'ALLOW';
  return {
    wounds: rows.map((r) => shape(store, ctx, r)),
    canIdentify: can('wound.identify'),
    kinds: KINDS,
    options: { ...OPTIONS, trend: TRENDS },
  };
}

export function identify(store: Store, ctx: WorkContext, personId: string, b: { site?: string; kind?: string; description?: string }) {
  enforce(store, ctx, { op: 'WOUND', personId, cap: 'wound.identify' }, personId);
  const site = (b.site ?? '').trim().slice(0, 120);
  if (site.length < 2) throw new HttpError(400, 'SITE_REQUIRED', 'Say where the wound is.');
  const kind = KINDS.includes(b.kind ?? '') ? b.kind! : 'Other';
  const description = (b.description ?? '').trim().slice(0, 1000) || null;
  const id = newId();
  store.tx(() => {
    store.insert('wound', { id, person_id: personId, service_id: ctx.serviceId, site, kind, state: 'IDENTIFIED', identified_by: ctx.workerId, identified_at: now(), description });
    recordInitial(store, 'wound', id, 'IDENTIFIED', { actorId: ctx.workerId, workContextId: ctx.id }, description ?? `${kind}, ${site}`);
    logged(store, ctx, 'WOUND_IDENTIFY', personId, id, `${kind}, ${site}`);
  });
  return { id, state: 'IDENTIFIED' };
}

const load = (store: Store, id: string) => {
  const w = store.get<Row>(`${SELECT} WHERE w.id = ?`, id);
  if (!w) throw new HttpError(404, 'NOT_FOUND', 'That wound no longer exists.');
  return w;
};

const mm = (v: unknown) => {
  const n = Number(v);
  return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : Math.max(0, Math.min(2000, Math.round(n)));
};
const pick = (list: string[], v: unknown) => (list.includes(String(v)) ? String(v) : null);

export function assess(store: Store, ctx: WorkContext, id: string, b: Record<string, unknown>) {
  const w = load(store, id);
  const personId = String(w.personId);
  enforce(store, ctx, { op: 'WOUND', personId, cap: 'wound.manage' }, personId);
  if (!['IDENTIFIED', 'ASSESSED', 'PLANNED'].includes(String(w.state))) throw new HttpError(409, 'CLOSED', 'This wound is no longer open.');
  const first = w.state === 'IDENTIFIED';
  const a = {
    length: mm(b.lengthMm), width: mm(b.widthMm), depth: mm(b.depthMm),
    stage: pick(OPTIONS.stage, b.stage), bed: pick(OPTIONS.bed, b.bed), exudate: pick(OPTIONS.exudate, b.exudate),
    surrounding: pick(OPTIONS.surrounding, b.surrounding), complication: pick(OPTIONS.complication, b.complication) ?? 'None',
    pain: b.pain === '' || b.pain === undefined ? null : Math.max(0, Math.min(10, Math.round(Number(b.pain)))),
    trend: first ? 'FIRST' : pick(TRENDS, b.trend), dressing: String(b.dressing ?? '').trim().slice(0, 300) || null, note: String(b.note ?? '').trim().slice(0, 1000) || null,
  };
  if (a.length === null || a.width === null) throw new HttpError(400, 'SIZE_REQUIRED', 'Record the length and width in millimetres.');
  if (!a.exudate || !a.bed) throw new HttpError(400, 'DETAIL_REQUIRED', 'Record the wound bed and exudate.');
  if (!first && !a.trend) throw new HttpError(400, 'TREND_REQUIRED', 'Say whether it is improving, static or deteriorating.');
  return store.tx(() => {
    // The assessment is also a .wound entry, so it appears in history, handover and routes.
    const t = KEY_BY_CODE.get('.wound')!;
    const fields: Record<string, string | number> = {
      site: String(w.site), type: String(w.kind), size: `${(a.length! / 10).toFixed(1)} x ${(a.width! / 10).toFixed(1)}${a.depth !== null ? ` x ${(a.depth / 10).toFixed(1)}` : ''}`,
      exudate: a.exudate!, ...(a.dressing ? { dressing: a.dressing } : {}), ...(w.nextReview ? { next: String(w.nextReview) } : {}),
    };
    const eventId = newId();
    store.insert('clinical_event', {
      id: eventId, lineage_id: eventId, version: 1, person_id: personId,
      encounter_id: store.get<{ id: string }>("SELECT id FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId)?.id ?? null,
      category: t.category, key_code: t.code, key_version: t.version, fields_json: JSON.stringify(fields), rendered_text: render(t, fields),
      author_id: ctx.workerId, author_position_id: ctx.positionId, author_role_label: `${ctx.role.label}, ${ctx.serviceName}`, service_id: ctx.serviceId,
      recorded_at: now(), effective_at: now(), state: 'CURRENT', urgent: a.trend === 'DETERIORATING' || a.complication !== 'None', collection: 'DIRECT', data_source: 'SHIFT',
    });
    store.insert('wound_assessment', {
      id: newId(), wound_id: id, event_id: eventId, assessed_by: ctx.workerId, assessed_at: now(), length_mm: a.length, width_mm: a.width, depth_mm: a.depth,
      stage: a.stage, bed: a.bed, exudate: a.exudate, surrounding: a.surrounding, pain: a.pain, trend: a.trend, complication: a.complication, dressing: a.dressing, note: a.note,
    });
    if (first) transition(store, 'wound', id, 'ASSESSED', { actorId: ctx.workerId, workContextId: ctx.id }, 'Initial assessment');
    if (w.reviewDays) store.run('UPDATE wound SET next_review = ? WHERE id = ?', addDays(todayLocal(), Number(w.reviewDays)), id);
    logged(store, ctx, 'WOUND_ASSESS', personId, id, a.trend ?? undefined);
    return shape(store, ctx, load(store, id));
  });
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { plan?: string; reviewDays?: unknown; note?: string }) {
  const w = load(store, id);
  const personId = String(w.personId);
  enforce(store, ctx, { op: 'WOUND', personId, cap: 'wound.manage' }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = (b.note ?? '').trim().slice(0, 1000);
  return store.tx(() => {
    switch (action) {
      case 'plan': {
        const plan = (b.plan ?? '').trim().slice(0, 1000);
        if (plan.length < 5) throw new HttpError(400, 'PLAN_REQUIRED', 'Write the treatment plan.');
        const days = Math.round(Number(b.reviewDays));
        if (!Number.isFinite(days) || days < 1 || days > 28) throw new HttpError(400, 'REVIEW_REQUIRED', 'Set how often it is reassessed, in days (1 to 28).');
        const before = store.get<Record<string, unknown>>('SELECT plan, review_days FROM wound WHERE id = ?', id)!;
        revise(store, 'wound', id, before, { plan, review_days: days }, { plan: 'Plan', review_days: 'Reassess every (days)' }, who, 'New treatment plan');
        transition(store, 'wound', id, 'PLANNED', who, plan);
        store.run('UPDATE wound SET plan = ?, review_days = ?, plan_by = ?, plan_at = ?, next_review = ? WHERE id = ?', plan, days, ctx.workerId, now(), addDays(todayLocal(), days), id);
        break;
      }
      case 'heal':
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Describe the healed wound.');
        transition(store, 'wound', id, 'HEALED', who, note);
        store.run('UPDATE wound SET closed_by = ?, closed_at = ?, close_reason = ?, next_review = NULL WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      case 'close':
        if (note.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Give the reason for closing this wound without healing.');
        transition(store, 'wound', id, 'CLOSED', who, note);
        store.run('UPDATE wound SET closed_by = ?, closed_at = ?, close_reason = ?, next_review = NULL WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `WOUND_${action.toUpperCase()}`, personId, id, note || undefined);
    return shape(store, ctx, load(store, id));
  });
}

// Wound reviews for the service: open wounds, due or overdue first, and wounds reported but
// not yet assessed.
export function reviews(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('wound.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include wound management`);
  const rows = store.all<Row>(
    `${SELECT} WHERE w.service_id = ? AND w.state IN ${OPEN}
       AND EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = w.person_id AND e.service_id = w.service_id AND e.state = 'ACTIVE')
      ORDER BY CASE w.state WHEN 'IDENTIFIED' THEN 0 ELSE 1 END, w.next_review IS NULL, w.next_review, w.identified_at`,
    ctx.serviceId,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_WOUNDS', decision: 'ALLOW', outcome: 'VIEWED', engines: [213] });
  return rows.map((r) => shape(store, ctx, r));
}
