import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';
import { overdue as monitoringOverdue } from './monitoring.ts';
import { reviewOverdue as restrictionReviewOverdue } from './restrictions.ts';
import { swallowConcerns } from './diets.ts';
import { inUseOverdue as equipmentOverdue } from './equipment.ts';

// Alert (Shared Lifecycle Object 218):
//   trigger condition → alert generated → visible to an authorised recipient →
//   acknowledged → action where required → resolved or expired.
// Generated alerts follow recorded facts only. When the condition clears, an alert nobody
// acknowledged expires; one that was acknowledged is resolved. SHIFT sets no clinical
// thresholds: an abnormal result is one the laboratory flagged.

type Row = Record<string, string | number | null>;
const OPEN = "('GENERATED', 'VISIBLE', 'ACKNOWLEDGED', 'ACTIONED')";
const CATEGORIES: Record<string, string> = { SAFETY: 'Safety', CLINICAL: 'Clinical risk', COMMUNICATION: 'Communication need' };

interface Condition { personId: string; objectId: string; title: string; detail: string }
interface Rule { rule: string; objectType: string; capability: string; current: (store: Store, serviceId: string, today: string) => Condition[] }

// Each rule reads the canonical record and lists the conditions that hold right now.
const RULES: Rule[] = [
  {
    rule: 'RESULT_ABNORMAL', objectType: 'result', capability: 'result.review',
    current: (store, serviceId) => store.all<Record<string, string>>(
      `SELECT r.id, r.person_id, r.test, r.value, r.units, r.reference_range, r.flag FROM result r
        WHERE r.state = 'AVAILABLE' AND r.flag IS NOT NULL AND r.flag <> ''
          AND EXISTS (SELECT 1 FROM encounter e WHERE e.person_id = r.person_id AND e.service_id = ? AND e.state = 'ACTIVE')`, serviceId,
    ).map((r) => ({
      personId: r.person_id, objectId: r.id, title: `${r.test} ${r.value}${r.units ? ` ${r.units}` : ''} not yet reviewed`,
      detail: `Laboratory flag ${r.flag}${r.reference_range ? `, reference range ${r.reference_range}` : ''}`,
    })),
  },
  {
    rule: 'WOUND_REVIEW_OVERDUE', objectType: 'wound', capability: 'wound.manage',
    current: (store, serviceId, today) => store.all<Record<string, string>>(
      `SELECT id, person_id, site, kind, next_review FROM wound WHERE service_id = ? AND state IN ('IDENTIFIED', 'ASSESSED', 'PLANNED') AND next_review < ?`, serviceId, today,
    ).map((w) => ({ personId: w.person_id, objectId: w.id, title: `${w.kind}, ${w.site.toLowerCase()}: review overdue`, detail: `Review was due ${w.next_review}` })),
  },
  {
    rule: 'CAREPLAN_REVIEW_OVERDUE', objectType: 'care_plan_item', capability: 'careplan.manage',
    current: (store, serviceId, today) => store.all<Record<string, string>>(
      `SELECT id, person_id, need, review_date FROM care_plan_item WHERE service_id = ? AND state = 'ACTIVE' AND review_date < ?`, serviceId, today,
    ).map((c) => ({ personId: c.person_id, objectId: c.id, title: `Care plan review overdue: ${c.need}`, detail: `Review was due ${c.review_date}` })),
  },
  {
    rule: 'MONITORING_OVERDUE', objectType: 'monitoring_plan', capability: 'monitoring.record',
    current: (store, serviceId) => monitoringOverdue(store, serviceId),
  },
  {
    rule: 'RESTRICTION_REVIEW_OVERDUE', objectType: 'restriction', capability: 'restriction.manage',
    current: (store, serviceId) => restrictionReviewOverdue(store, serviceId),
  },
  {
    rule: 'SWALLOW_CONCERN', objectType: 'diet_order', capability: 'diet.order',
    current: (store, serviceId) => swallowConcerns(store, serviceId),
  },
  {
    rule: 'EQUIPMENT_SERVICE_OVERDUE', objectType: 'equipment', capability: 'equipment.manage',
    current: (store, serviceId) => equipmentOverdue(store, serviceId),
  },
];

// Bring this service's alerts into line with the record: generate alerts for conditions
// that hold, and close alerts whose condition has cleared or whose date has passed.
export function refresh(store: Store, serviceId: string) {
  const today = todayLocal();
  store.tx(() => {
    for (const rule of RULES) {
      const holding = rule.current(store, serviceId, today);
      const ids = new Set(holding.map((c) => c.objectId));
      const open = store.all<{ id: string; object_id: string; state: string }>(`SELECT id, object_id, state FROM alert WHERE service_id = ? AND rule = ? AND state IN ${OPEN}`, serviceId, rule.rule);
      const have = new Set(open.map((a) => a.object_id));
      for (const c of holding) {
        if (have.has(c.objectId)) continue;
        const id = newId();
        store.insert('alert', {
          id, person_id: c.personId, service_id: serviceId, capability: rule.capability, rule: rule.rule, object_type: rule.objectType, object_id: c.objectId,
          title: c.title, detail: c.detail, state: 'GENERATED', generated_at: now(),
        });
        recordInitial(store, 'alert', id, 'GENERATED', { actorId: null, workContextId: null }, c.detail);
      }
      for (const a of open) {
        if (ids.has(a.object_id)) continue;
        close(store, a.id, a.state, 'Condition no longer present');
      }
    }
    for (const a of store.all<{ id: string; state: string }>(`SELECT id, state FROM alert WHERE service_id = ? AND rule = 'RAISED' AND state IN ${OPEN} AND expires_on IS NOT NULL AND expires_on < ?`, serviceId, today)) {
      transition(store, 'alert', a.id, 'EXPIRED', { actorId: null, workContextId: null }, 'Review date passed');
      store.run('UPDATE alert SET resolved_at = ?, resolution = ? WHERE id = ?', now(), 'Review date passed', a.id);
    }
  });
}

function close(store: Store, id: string, state: string, reason: string) {
  const to = state === 'GENERATED' || state === 'VISIBLE' ? 'EXPIRED' : 'RESOLVED';
  transition(store, 'alert', id, to, { actorId: null, workContextId: null }, reason);
  store.run('UPDATE alert SET resolved_at = ?, resolution = ? WHERE id = ?', now(), reason, id);
}

const SELECT = `
  SELECT a.id, a.state, a.rule, a.category, a.title, a.detail, a.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = a.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         a.service_id AS serviceId, s.name AS service, a.capability, a.object_type AS objectType, a.generated_at AS generatedAt,
         rb.display_name AS raisedBy, vt.display_name AS seenBy, a.visible_at AS visibleAt, ak.display_name AS acknowledgedBy, a.acknowledged_at AS acknowledgedAt,
         a.action_note AS actionNote, ac.display_name AS actionedBy, a.actioned_at AS actionedAt, rs.display_name AS resolvedBy, a.resolved_at AS resolvedAt,
         a.resolution, a.expires_on AS expiresOn
    FROM alert a
    JOIN person p ON p.id = a.person_id
    JOIN service s ON s.id = a.service_id
    LEFT JOIN workforce_person rb ON rb.id = a.raised_by
    LEFT JOIN workforce_person vt ON vt.id = a.visible_to
    LEFT JOIN workforce_person ak ON ak.id = a.acknowledged_by
    LEFT JOIN workforce_person ac ON ac.id = a.actioned_by
    LEFT JOIN workforce_person rs ON rs.id = a.resolved_by`;

const recipient = (store: Store, ctx: WorkContext, a: Row) =>
  evaluate(store, ctx, { op: 'ALERT_RECEIVE', serviceId: String(a.serviceId), capability: String(a.capability) }).decision === 'ALLOW';

// Showing an alert to an authorised recipient for the first time is the "visible" step.
function seen(store: Store, ctx: WorkContext, rows: Row[]) {
  const fresh = rows.filter((a) => a.state === 'GENERATED' && recipient(store, ctx, a));
  if (!fresh.length) return rows;
  store.tx(() => {
    for (const a of fresh) {
      transition(store, 'alert', String(a.id), 'VISIBLE', { actorId: ctx.workerId, workContextId: ctx.id }, 'Shown to recipient');
      store.run('UPDATE alert SET visible_at = ?, visible_to = ? WHERE id = ?', now(), ctx.workerId, a.id);
    }
  });
  return rows.map((a) => (fresh.includes(a) ? store.get<Row>(`${SELECT} WHERE a.id = ?`, a.id)! : a));
}

function shape(store: Store, ctx: WorkContext, a: Row) {
  const actions: string[] = [];
  const mine = recipient(store, ctx, a);
  const state = String(a.state);
  if (mine && state === 'VISIBLE') actions.push('acknowledge');
  if (mine && (state === 'ACKNOWLEDGED' || state === 'ACTIONED')) actions.push('action');
  // Generated alerts resolve when the record changes; a raised alert is resolved by a person.
  if (a.rule === 'RAISED' && mine && ctx.role.capabilities.includes('alert.raise') && ['VISIBLE', 'ACKNOWLEDGED', 'ACTIONED'].includes(state)) actions.push('resolve');
  return {
    ...a, categoryLabel: a.category ? CATEGORIES[String(a.category)] : null, actions, mine,
    history: history(store, 'alert', String(a.id)),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'alert', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: ['ORG-SYN-001 v1'], engines: [42],
  });
}

// Active raised alerts for the patient banner, from every service.
export function activeRaised(store: Store, personId: string) {
  return store.all<{ id: string; category: string; title: string; service: string }>(
    `SELECT a.id, a.category, a.title, s.name AS service FROM alert a JOIN service s ON s.id = a.service_id
      WHERE a.person_id = ? AND a.rule = 'RAISED' AND a.state IN ${OPEN} AND (a.expires_on IS NULL OR a.expires_on >= ?) ORDER BY a.generated_at`,
    personId, todayLocal(),
  ).map((a) => ({ ...a, categoryLabel: CATEGORIES[a.category] ?? a.category }));
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  refresh(store, ctx.serviceId);
  // Raised alerts from any service; generated alerts for this service.
  const rows = seen(store, ctx, store.all<Row>(
    `${SELECT} WHERE a.person_id = ? AND (a.rule = 'RAISED' OR a.service_id = ?) AND (a.state IN ${OPEN} OR a.resolved_at > datetime('now', '-7 days'))
      ORDER BY CASE WHEN a.state IN ${OPEN} THEN 0 ELSE 1 END, CASE a.rule WHEN 'RAISED' THEN 0 ELSE 1 END, a.generated_at DESC`,
    personId, ctx.serviceId,
  ));
  const canRaise = evaluate(store, ctx, { op: 'ALERT_RAISE', personId }).decision === 'ALLOW';
  return { alerts: rows.map((r) => shape(store, ctx, r)), canRaise, categories: CATEGORIES };
}

export function raise(store: Store, ctx: WorkContext, personId: string, b: { category?: string; title?: string; detail?: string; expiresOn?: string }) {
  enforce(store, ctx, { op: 'ALERT_RAISE', personId }, personId);
  const category = String(b.category);
  if (!CATEGORIES[category]) throw new HttpError(400, 'CATEGORY_REQUIRED', 'Choose the kind of alert.');
  const title = (b.title ?? '').trim().slice(0, 120);
  if (title.length < 3) throw new HttpError(400, 'TITLE_REQUIRED', 'Write the alert in a few words.');
  const detail = (b.detail ?? '').trim().slice(0, 1000) || null;
  const expiresOn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expiresOn)) ? String(b.expiresOn) : null;
  if (expiresOn && expiresOn < todayLocal()) throw new HttpError(400, 'DATE_PAST', 'The review date has already passed.');
  const id = newId();
  store.tx(() => {
    store.insert('alert', {
      id, person_id: personId, service_id: ctx.serviceId, capability: 'record.view', rule: 'RAISED', category, title, detail,
      state: 'GENERATED', generated_at: now(), raised_by: ctx.workerId, expires_on: expiresOn,
    });
    recordInitial(store, 'alert', id, 'GENERATED', { actorId: ctx.workerId, workContextId: ctx.id }, `${CATEGORIES[category]}: ${title}`);
    // The person who raises it has seen it.
    transition(store, 'alert', id, 'VISIBLE', { actorId: ctx.workerId, workContextId: ctx.id }, 'Raised');
    store.run('UPDATE alert SET visible_at = ?, visible_to = ? WHERE id = ?', now(), ctx.workerId, id);
    logged(store, ctx, 'ALERT_RAISE', personId, id, `${CATEGORIES[category]}: ${title}`);
  });
  return { id };
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string }) {
  const a = store.get<Row>(`${SELECT} WHERE a.id = ?`, id);
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'That alert no longer exists.');
  const personId = String(a.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const note = b.note?.trim().slice(0, 1000) || '';
  enforce(store, ctx, { op: 'ALERT_RECEIVE', serviceId: String(a.serviceId), capability: String(a.capability) }, personId);
  store.tx(() => {
    switch (action) {
      case 'acknowledge':
        transition(store, 'alert', id, 'ACKNOWLEDGED', who);
        store.run('UPDATE alert SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', ctx.workerId, now(), id);
        break;
      case 'action':
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Record what was done.');
        transition(store, 'alert', id, 'ACTIONED', who, note);
        store.run('UPDATE alert SET action_note = ?, actioned_by = ?, actioned_at = ? WHERE id = ?', note, ctx.workerId, now(), id);
        break;
      case 'resolve':
        if (a.rule !== 'RAISED') throw new HttpError(409, 'RECORD_RESOLVES', 'This alert resolves when the record changes.');
        enforce(store, ctx, { op: 'ALERT_RAISE', personId }, personId);
        if (note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why the alert no longer applies.');
        transition(store, 'alert', id, 'RESOLVED', who, note);
        store.run('UPDATE alert SET resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?', ctx.workerId, now(), note, id);
        break;
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    }
    logged(store, ctx, `ALERT_${action.toUpperCase()}`, personId, id, note || undefined);
  });
  return shape(store, ctx, store.get<Row>(`${SELECT} WHERE a.id = ?`, id)!);
}

// This worker's alerts: open alerts for this service that name their role, and those
// closed today.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('record.view')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include alerts`);
  refresh(store, ctx.serviceId);
  const caps = ctx.role.capabilities;
  const rows = store.all<Row>(
    `${SELECT} WHERE a.service_id = ? AND a.capability IN (${caps.map(() => '?').join(',')})
        AND (a.state IN ${OPEN} OR a.resolved_at > datetime('now', '-1 day'))
      ORDER BY CASE WHEN a.state IN ${OPEN} THEN 0 ELSE 1 END, CASE a.state WHEN 'GENERATED' THEN 0 WHEN 'VISIBLE' THEN 0 ELSE 1 END,
               CASE a.rule WHEN 'RAISED' THEN 0 WHEN 'RESULT_ABNORMAL' THEN 1 ELSE 2 END, a.generated_at`,
    ctx.serviceId, ...caps,
  );
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_ALERTS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return seen(store, ctx, rows).map((r) => shape(store, ctx, r));
}

// For the Home card: how many open alerts wait on this worker's role. Counting does not
// make an alert visible; only showing it does.
export function count(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('record.view')) return { open: 0 };
  refresh(store, ctx.serviceId);
  const caps = ctx.role.capabilities;
  const r = store.get<{ n: number }>(
    `SELECT count(*) AS n FROM alert WHERE service_id = ? AND capability IN (${caps.map(() => '?').join(',')}) AND state IN ('GENERATED', 'VISIBLE')`,
    ctx.serviceId, ...caps,
  );
  return { open: Number(r?.n ?? 0) };
}
