import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { TESTS, PRIORITY, ORDER_STATES, LAB, REFS } from '../config/diagnostics.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Laboratory tests (entry 12; Shared Lifecycle Objects 204, 205, 212):
//   ordered by a doctor → sample taken, with the person's identity checked at the bedside and the
//   sample labelled there → sent → result back, electronically or phoned through by the lab and
//   read back → reviewed. A critical result (the lab's call) shows on the record for everyone
//   until a doctor acknowledges it with a plan; a nurse who takes the call writes which doctor
//   she told. Rest homes have no doctor in SHIFT, so the nurse records the GP's plan from the call.
// A corrected result never overwrites: the original is kept, marked corrected, and the new value
// needs reviewing again.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const ALLOW = (store: Store, ctx: WorkContext, op: 'TEST_ORDER' | 'TEST_COLLECT' | 'RESULT_RECEIVE' | 'REVIEW_RESULT', personId: string) =>
  evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, type: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: type, objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [12, 204, 205, 212],
  });
}

const ORDERS = `
  SELECT o.id, o.person_id AS personId, o.test, o.priority, o.reason, o.state, ob.display_name AS orderedBy, o.ordered_at AS orderedAt, o.take_by AS takeBy,
         cb.display_name AS collectedBy, o.collected_at AS collectedAt, o.sent_at AS sentAt, o.cancel_note AS cancelNote, o.result_id AS resultId
    FROM test_order o
    JOIN workforce_person ob ON ob.id = o.ordered_by
    LEFT JOIN workforce_person cb ON cb.id = o.collected_by`;

const RESULTS = `
  SELECT r.id, r.person_id AS personId, r.test, r.value, r.units, r.reference_range AS referenceRange, r.flag, r.critical, r.state,
         r.performed_at AS performedAt, r.released_at AS releasedAt, r.source, rv.display_name AS reviewedBy, r.reviewed_at AS reviewedAt,
         ab.display_name AS ackBy, r.ack_at AS ackAt, r.ack_plan AS ackPlan, r.told_doctor AS toldDoctor, rb.display_name AS receivedBy, r.read_back AS readBack,
         r.corrects_id AS correctsId, r.corrected_reason AS correctedReason, r.order_id AS orderId
    FROM result r
    LEFT JOIN workforce_person rv ON rv.id = r.reviewed_by
    LEFT JOIN workforce_person ab ON ab.id = r.ack_by
    LEFT JOIN workforce_person rb ON rb.id = r.received_by`;

const unacked = (r: Row) => !!r.critical && !r.ackAt && r.state !== 'CORRECTED';

// The person's Tests and results view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const canOrder = ALLOW(store, ctx, 'TEST_ORDER', personId);
  const canCollect = ALLOW(store, ctx, 'TEST_COLLECT', personId);
  const canReceive = ALLOW(store, ctx, 'RESULT_RECEIVE', personId);
  const canReview = ALLOW(store, ctx, 'REVIEW_RESULT', personId);
  const relay = canReceive && !canReview && (ctx.role.capabilities as string[]).includes('result.relay');
  const orders = store.all<Row>(`${ORDERS} WHERE o.person_id = ? AND (o.state NOT IN ('RESULTED', 'CANCELLED') OR o.ordered_at >= ?) ORDER BY o.ordered_at DESC`,
    personId, new Date(Date.now() - 3 * 86_400_000).toISOString()).map((o): Record<string, any> => {
    const state = String(o.state);
    const actions: string[] = [];
    if (canCollect && state === 'ORDERED') actions.push('collect');
    if (canCollect && state === 'COLLECTED') actions.push('send');
    if ((canOrder || canCollect) && ['ORDERED', 'COLLECTED'].includes(state)) actions.push('cancel');
    return {
      ...o, state, label: TESTS[String(o.test)]?.label ?? o.test, sample: TESTS[String(o.test)]?.sample, priorityLabel: PRIORITY[String(o.priority)]?.label,
      stateLabel: ORDER_STATES[state], overdue: state === 'ORDERED' && String(o.takeBy) < now(), actions,
    };
  });
  const results = store.all<Row>(`${RESULTS} WHERE r.person_id = ? ORDER BY r.performed_at DESC, r.test`, personId).map((r): Record<string, any> => {
    const state = String(r.state);
    const actions: string[] = [];
    if (unacked(r) && (canReview || relay)) actions.push('acknowledge');
    if (!r.critical && state === 'AVAILABLE' && canReview) actions.push('review');
    if (canReceive && state !== 'CORRECTED') actions.push('correct');
    return { ...r, state, critical: !!r.critical, needsAck: unacked(r), readBack: !!r.readBack, actions };
  });
  return {
    orders, results, canOrder, canReceive, canReview, relay,
    options: { tests: Object.fromEntries(Object.entries(TESTS).map(([k, t]) => [k, t.label])), priority: Object.fromEntries(Object.entries(PRIORITY).map(([k, p]) => [k, p.label])),
      waiting: orders.filter((o) => ['ORDERED', 'COLLECTED', 'SENT'].includes(o.state)).map((o) => ({ id: o.id, label: `${o.label} (ordered ${String(o.orderedAt).slice(0, 10)})` })) },
  };
}

// For the record header: critical results nobody has acknowledged yet.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>(`${RESULTS} WHERE r.person_id = ? AND r.critical = 1 AND r.ack_at IS NULL AND r.state != 'CORRECTED' ORDER BY r.performed_at`, personId);
  return rows.length ? rows.map((r) => ({ test: r.test, value: r.value, units: r.units, at: r.releasedAt ?? r.performedAt, toldDoctor: r.toldDoctor })) : null;
}

interface Body {
  test?: string; priority?: string; reason?: string; idChecked?: string; note?: string; orderId?: string; value?: string; units?: string; range?: string;
  critical?: string; readBack?: string; from?: string; toldDoctor?: string; plan?: string; doctor?: string;
}

export function order(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'TEST_ORDER', personId }, personId);
  const test = pick(TESTS, b.test);
  if (!test) throw new HttpError(400, 'TEST_REQUIRED', 'Choose the test.');
  const priority = pick(PRIORITY, b.priority) || 'ROUTINE';
  const reason = text(b.reason);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why the test is needed, e.g. "Chest pain; check troponin".');
  if (store.get("SELECT 1 FROM test_order WHERE person_id = ? AND test = ? AND state IN ('ORDERED', 'COLLECTED')", personId, test)) {
    throw new HttpError(409, 'ALREADY', `${TESTS[test].label} is already ordered and the sample has not gone to the lab yet.`);
  }
  const id = newId();
  store.tx(() => {
    store.insert('test_order', {
      id, person_id: personId, service_id: ctx.serviceId, test, priority, reason, state: 'ORDERED', ordered_by: ctx.workerId, ordered_at: now(),
      take_by: new Date(Date.now() + PRIORITY[priority].takeWithinMins * 60_000).toISOString(),
    });
    recordInitial(store, 'test_order', id, 'ORDERED', { actorId: ctx.workerId, workContextId: ctx.id }, `${PRIORITY[priority].label}: ${TESTS[test].label}`);
    logged(store, ctx, 'TEST_ORDER', personId, 'test_order', id, TESTS[test].label);
  });
  return forPerson(store, ctx, personId);
}

export function orderAct(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const o = store.get<Row>(`${ORDERS} WHERE o.id = ?`, id);
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'That test order is no longer in SHIFT.');
  const personId = String(o.personId);
  const state = String(o.state);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const label = TESTS[String(o.test)]?.label ?? String(o.test);
  store.tx(() => {
    switch (action) {
      case 'collect': {
        enforce(store, ctx, { op: 'TEST_COLLECT', personId }, personId);
        if (state !== 'ORDERED') throw new HttpError(409, 'STATE', 'The sample has already been taken.');
        if (b.idChecked !== 'yes') throw new HttpError(400, 'ID_CHECK', 'Check their name and NHI with them (or their wristband) and label the sample at the bedside before saving.');
        transition(store, 'test_order', id, 'COLLECTED', who, 'Sample taken');
        store.run('UPDATE test_order SET collected_by = ?, collected_at = ?, collect_note = ? WHERE id = ?', ctx.workerId, now(), text(b.note) || null, id);
        logged(store, ctx, 'TEST_COLLECT', personId, 'test_order', id, `${label}: identity checked, labelled at the bedside`);
        break;
      }
      case 'send': {
        enforce(store, ctx, { op: 'TEST_COLLECT', personId }, personId);
        if (state !== 'COLLECTED') throw new HttpError(409, 'STATE', 'Take the sample first.');
        transition(store, 'test_order', id, 'SENT', who, `Sent to ${LAB}`);
        store.run('UPDATE test_order SET sent_at = ? WHERE id = ?', now(), id);
        logged(store, ctx, 'TEST_SEND', personId, 'test_order', id, label);
        break;
      }
      case 'cancel': {
        if (!ALLOW(store, ctx, 'TEST_ORDER', personId)) enforce(store, ctx, { op: 'TEST_COLLECT', personId }, personId);
        if (!['ORDERED', 'COLLECTED'].includes(state)) throw new HttpError(409, 'STATE', 'Only a test not yet with the lab can be cancelled here.');
        const say = text(b.note);
        if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is cancelled.');
        transition(store, 'test_order', id, 'CANCELLED', who, say);
        store.run('UPDATE test_order SET cancel_note = ? WHERE id = ?', say, id);
        logged(store, ctx, 'TEST_CANCEL', personId, 'test_order', id, `${label}: ${say}`);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}

// The lab phones a result through (often a critical one): it is written down and read back.
export function receive(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'RESULT_RECEIVE', personId }, personId);
  const orderRow = b.orderId ? store.get<Row>("SELECT id, test, state FROM test_order WHERE id = ? AND person_id = ? AND state IN ('ORDERED', 'COLLECTED', 'SENT')", b.orderId, personId) : null;
  const test = orderRow ? TESTS[String(orderRow.test)].label : text(b.test, 120);
  if (test.length < 2) throw new HttpError(400, 'TEST_REQUIRED', 'Choose the test it is for, or write the test name.');
  const value = text(b.value, 60);
  if (!value) throw new HttpError(400, 'VALUE_REQUIRED', 'Write the result.');
  const from = text(b.from, 120);
  if (from.length < 2) throw new HttpError(400, 'FROM_REQUIRED', 'Write who phoned from the lab.');
  if (b.readBack !== 'yes') throw new HttpError(400, 'READ_BACK', 'Read the result back to the lab and have them confirm it before saving.');
  const critical = b.critical === 'yes';
  const doctorRole = (ctx.role.capabilities as string[]).includes('result.review');
  const told = text(b.toldDoctor, 160);
  if (critical && !doctorRole && told.length < 3) throw new HttpError(400, 'TELL_DOCTOR', 'A critical result must go to a doctor now. Write which doctor you told, and how.');
  const id = newId();
  store.tx(() => {
    store.insert('result', {
      id, person_id: personId, test, value, units: text(b.units, 30) || null, reference_range: text(b.range, 60) || null, flag: critical ? 'C' : null, state: 'AVAILABLE',
      performed_at: now(), released_at: now(), source: `Phoned by ${from}, ${LAB}`, reviewed_by: null, reviewed_at: null, data_source: 'SHIFT',
      critical: critical ? 1 : 0, received_by: ctx.workerId, read_back: 1, told_doctor: critical && !doctorRole ? told : null, order_id: orderRow?.id ?? null,
    });
    recordInitial(store, 'result', id, 'AVAILABLE', { actorId: ctx.workerId, workContextId: ctx.id }, `Phoned by ${from}; read back`);
    if (orderRow) {
      transition(store, 'test_order', String(orderRow.id), 'RESULTED', { actorId: ctx.workerId, workContextId: ctx.id }, 'Result phoned');
      store.run('UPDATE test_order SET result_id = ? WHERE id = ?', id, orderRow.id);
    }
    logged(store, ctx, critical ? 'RESULT_CRITICAL_RECEIVED' : 'RESULT_RECEIVED', personId, 'result', id, `${test} ${value}${critical && !doctorRole ? `; told ${told}` : ''}`);
  });
  return forPerson(store, ctx, personId);
}

export function resultAct(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${RESULTS} WHERE r.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That result is no longer in SHIFT.');
  const personId = String(r.personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    switch (action) {
      case 'acknowledge': {
        if (!unacked(r)) throw new HttpError(409, 'STATE', 'This result does not need acknowledging.');
        const doctor = ALLOW(store, ctx, 'REVIEW_RESULT', personId);
        if (!doctor) {
          enforce(store, ctx, { op: 'RESULT_RECEIVE', personId }, personId);
          if (!(ctx.role.capabilities as string[]).includes('result.relay')) throw new HttpError(403, 'BLOCK', 'A doctor must acknowledge a critical result.');
        }
        const plan = text(b.plan, 800);
        if (plan.length < 5) throw new HttpError(400, 'PLAN_REQUIRED', 'Write the plan, e.g. "Repeat potassium now; ECG; insulin-dextrose if still above 6.5".');
        const name = text(b.doctor, 160);
        if (!doctor && name.length < 3) throw new HttpError(400, 'DOCTOR_REQUIRED', 'Write which doctor gave the plan, e.g. "Dr Whyte (GP), by phone".');
        const full = doctor ? plan : `${name}: ${sentence(plan)}`;
        if (r.state === 'AVAILABLE') transition(store, 'result', id, 'REVIEWED', who, 'Critical result acknowledged');
        store.run('UPDATE result SET ack_by = ?, ack_at = ?, ack_plan = ?, reviewed_by = COALESCE(reviewed_by, ?), reviewed_at = COALESCE(reviewed_at, ?) WHERE id = ?',
          ctx.workerId, now(), full, ctx.workerId, now(), id);
        logged(store, ctx, 'RESULT_CRITICAL_ACK', personId, 'result', id, `${r.test} ${r.value}: ${full}`);
        break;
      }
      case 'correct': {
        enforce(store, ctx, { op: 'RESULT_RECEIVE', personId }, personId);
        if (r.state === 'CORRECTED') throw new HttpError(409, 'STATE', 'This result has already been corrected.');
        const value = text(b.value, 60);
        if (!value || value === r.value) throw new HttpError(400, 'VALUE_REQUIRED', 'Write the corrected result.');
        const reason = text(b.reason, 300);
        if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Write what the lab said was wrong, e.g. "Haemolysed sample; repeat was normal".');
        const from = text(b.from, 120);
        if (from.length < 2) throw new HttpError(400, 'FROM_REQUIRED', 'Write who at the lab told you.');
        const critical = b.critical === 'yes';
        const newIdV = newId();
        transition(store, 'result', id, 'CORRECTED', who, reason);
        store.run('UPDATE result SET corrected_reason = ? WHERE id = ?', reason, id);
        store.insert('result', {
          id: newIdV, person_id: personId, test: r.test, value, units: r.units, reference_range: r.referenceRange, flag: critical ? 'C' : null, state: 'AVAILABLE',
          performed_at: r.performedAt, released_at: now(), source: `Corrected by ${from}, ${LAB}`, reviewed_by: null, reviewed_at: null, data_source: 'SHIFT',
          critical: critical ? 1 : 0, received_by: ctx.workerId, read_back: 1, corrects_id: id, order_id: r.orderId,
        });
        recordInitial(store, 'result', newIdV, 'AVAILABLE', who, `Corrects an earlier result: ${reason}`);
        logged(store, ctx, 'RESULT_CORRECTED', personId, 'result', newIdV, `${r.test} ${r.value} → ${value}: ${reason}`);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
