import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { nilByMouth } from './restrictions.ts';
import { nothingByMouth } from './feeding.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Nutrition / diet order (Shared Lifecycle Object 244):
//   nutrition or swallowing requirement → assessment → authorised diet → preparation and
//   provision → delivery → intake → tolerance → monitoring → review → modification / cessation.
// Food texture and drink thickness use the IDDSI framework's level names. A modified texture or
// thickness rests on a recorded swallowing assessment. While nil by mouth is in force, meals
// are withheld, never given. Meal times are organisational configuration (ORG-SYN-001).

type Row = Record<string, string | number | null>;
export const DIETS: Record<string, string> = {
  STANDARD: 'Standard', DIABETIC: 'Diabetic', LOW_SALT: 'Low salt', RENAL: 'Renal', HIGH_ENERGY: 'High energy, high protein',
  GLUTEN_FREE: 'Gluten free', VEGETARIAN: 'Vegetarian', CULTURAL: 'Cultural or religious needs',
};
export const TEXTURES: Record<string, string> = {
  '7': 'Level 7 Regular', '7EC': 'Level 7 Easy to chew', '6': 'Level 6 Soft and bite-sized', '5': 'Level 5 Minced and moist', '4': 'Level 4 Pureed', '3': 'Level 3 Liquidised',
};
export const DRINKS: Record<string, string> = {
  '0': 'Level 0 Thin', '1': 'Level 1 Slightly thick', '2': 'Level 2 Mildly thick', '3': 'Level 3 Moderately thick', '4': 'Level 4 Extremely thick',
};
const ASSIST: Record<string, string> = { INDEPENDENT: 'Independent', SET_UP: 'Set-up only', SUPERVISION: 'Supervise while eating', FULL: 'Full assistance' };
const MEALS: Record<string, { label: string; at: string | null }> = {
  BREAKFAST: { label: 'Breakfast', at: '07:30' }, LUNCH: { label: 'Lunch', at: '12:00' }, DINNER: { label: 'Dinner', at: '17:00' }, SNACK: { label: 'Snack', at: null },
};
const OUTCOMES: Record<string, string> = { GIVEN: 'Given', REFUSED: 'Refused', WITHHELD: 'Withheld', AWAY: 'Away' };
const INTAKE: Record<string, string> = { ALL: 'All', MOST: 'Most', HALF: 'About half', LITTLE: 'A little', NONE: 'None' };
const TOLERANCE: Record<string, string> = { FINE: 'No problems', COUGHING: 'Coughing', CHOKING: 'Choking', NAUSEA: 'Nausea or vomiting', OTHER: 'Other' };
const CONCERN = ['COUGHING', 'CHOKING'];
const REVIEW: Record<string, string> = { CONTINUE: 'Continue', CHANGED: 'Changed', STOPPED: 'Stopped' };
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002'];

const SELECT = `
  SELECT d.id, d.state, d.diets, d.texture, d.drinks, d.assistance, d.supplements, d.preferences, d.assessment, d.reason,
         d.review_date AS reviewDate, d.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = d.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         d.service_id AS serviceId, s.name AS service, ob.display_name AS orderedBy, d.ordered_at AS orderedAt, d.supersedes_id AS supersedesId,
         cb.display_name AS closedBy, d.closed_at AS closedAt, d.close_reason AS closeReason
    FROM diet_order d
    JOIN person p ON p.id = d.person_id
    JOIN service s ON s.id = d.service_id
    JOIN workforce_person ob ON ob.id = d.ordered_by
    LEFT JOIN workforce_person cb ON cb.id = d.closed_by`;

const modified = (d: Row) => d.texture !== '7' || d.drinks !== '0';

// The chain of orders this one replaced, newest first, so reviews and meals carry across changes.
function chain(store: Store, id: string) {
  const ids: string[] = [];
  for (let at: string | null = id, guard = 0; at && guard < 20; guard++) {
    ids.push(at);
    at = store.get<{ s: string | null }>('SELECT supersedes_id AS s FROM diet_order WHERE id = ?', at)?.s ?? null;
  }
  return ids;
}

function meals(store: Store, ids: string[], since: string) {
  return store.all<Row>(
    `SELECT m.id, m.meal_date AS date, m.meal, m.outcome, m.intake, m.tolerance, m.note, w.display_name AS by, m.recorded_at AS at
       FROM meal_record m JOIN workforce_person w ON w.id = m.recorded_by
      WHERE m.diet_order_id IN (${ids.map(() => '?').join(',')}) AND m.meal_date >= ? ORDER BY m.recorded_at DESC`, ...ids, since,
  ).map((m) => ({
    ...m, date: String(m.date), meal: String(m.meal), mealLabel: MEALS[String(m.meal)].label, outcomeLabel: OUTCOMES[String(m.outcome)],
    intakeLabel: m.intake ? INTAKE[String(m.intake)] : null, toleranceLabel: m.tolerance ? TOLERANCE[String(m.tolerance)] : null,
    concern: CONCERN.includes(String(m.tolerance)),
  }));
}

// A coughing or choking episode recorded since the diet was last reviewed.
function concern(store: Store, d: Row) {
  const ids = chain(store, String(d.id));
  const reviewed = store.get<{ at: string | null }>(
    `SELECT MAX(reviewed_at) AS at FROM diet_review WHERE diet_order_id IN (${ids.map(() => '?').join(',')})`, ...ids,
  )?.at ?? '';
  return store.get<Row>(
    `SELECT m.meal, m.meal_date AS date, m.tolerance, m.note, m.recorded_at AS at FROM meal_record m
      WHERE m.diet_order_id IN (${ids.map(() => '?').join(',')}) AND m.tolerance IN ('COUGHING', 'CHOKING') AND m.recorded_at > ?
      ORDER BY m.recorded_at DESC LIMIT 1`, ...ids, reviewed,
  ) ?? null;
}

function shape(store: Store, ctx: WorkContext, d: Row) {
  const id = String(d.id);
  const personId = String(d.personId);
  const ids = chain(store, id);
  const today = todayLocal();
  const recent = meals(store, ids, (() => { const x = new Date(); x.setDate(x.getDate() - 2); return todayLocal(x); })());
  const clock = new Date().toTimeString().slice(0, 5);
  const active = d.state === 'ACTIVE';
  const todayMeals = Object.entries(MEALS).filter(([, m]) => m.at).map(([k, m]) => {
    const record = recent.find((r) => r.date === today && r.meal === k) ?? null;
    return { meal: k, label: m.label, at: m.at, due: String(m.at) <= clock, record };
  });
  const reviews = store.all<Row>(
    `SELECT v.reviewed_at AS at, w.display_name AS by, v.outcome, v.finding FROM diet_review v JOIN workforce_person w ON w.id = v.reviewed_by
      WHERE v.diet_order_id IN (${ids.map(() => '?').join(',')}) ORDER BY v.reviewed_at DESC`, ...ids,
  ).map((v) => ({ ...v, outcomeLabel: REVIEW[String(v.outcome)] }));
  const c = active ? concern(store, d) : null;
  return {
    ...d,
    dietLabels: String(d.diets).split(',').map((x) => DIETS[x]).filter(Boolean),
    textureLabel: TEXTURES[String(d.texture)], drinksLabel: DRINKS[String(d.drinks)], assistanceLabel: ASSIST[String(d.assistance)],
    modified: modified(d), reviewDue: active && !!d.reviewDate && String(d.reviewDate) <= today,
    nbm: active ? nilByMouth(store, personId) : null,
    today: todayMeals, recent: recent.slice(0, 8), reviews,
    concern: c ? { ...c, mealLabel: MEALS[String(c.meal)].label, toleranceLabel: TOLERANCE[String(c.tolerance)] } : null,
    canRecord: active && evaluate(store, ctx, { op: 'MEAL_RECORD', personId }).decision === 'ALLOW',
    canOrder: active && d.serviceId === ctx.serviceId && evaluate(store, ctx, { op: 'DIET_ORDER', personId }).decision === 'ALLOW',
    history: history(store, 'diet', id),
  };
}

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'diet_order', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS, engines: [42],
  });
}

const options = () => ({
  diets: DIETS, textures: TEXTURES, drinks: DRINKS, assistance: ASSIST, meals: Object.fromEntries(Object.entries(MEALS).map(([k, v]) => [k, v.label])),
  outcomes: OUTCOMES, intake: INTAKE, tolerance: TOLERANCE, review: REVIEW,
});

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const active = store.all<Row>(`${SELECT} WHERE d.person_id = ? AND d.state = 'ACTIVE' ORDER BY d.ordered_at DESC`, personId);
  const past = store.all<Row>(`${SELECT} WHERE d.person_id = ? AND d.state = 'CEASED' ORDER BY d.closed_at DESC LIMIT 5`, personId);
  const canOrder = evaluate(store, ctx, { op: 'DIET_ORDER', personId }).decision === 'ALLOW';
  return { orders: active.map((d) => shape(store, ctx, d)), past: past.map((d) => shape(store, ctx, d)), canOrder, nbm: nilByMouth(store, personId), options: options() };
}

// For the record header: texture and drinks when they are modified, so no one gives the wrong one.
export function current(store: Store, personId: string) {
  const d = store.get<Row>("SELECT texture, drinks, assistance FROM diet_order WHERE person_id = ? AND state = 'ACTIVE' ORDER BY ordered_at DESC LIMIT 1", personId);
  if (!d || !modified(d)) return null;
  return { texture: TEXTURES[String(d.texture)], drinks: DRINKS[String(d.drinks)], assistance: ASSIST[String(d.assistance)] };
}

interface Fields {
  diets?: string; texture?: string; drinks?: string; assistance?: string; supplements?: string; preferences?: string; assessment?: string; reason?: string; reviewDate?: string;
}

function clean(b: Fields) {
  const diets = String(b.diets ?? '').split(',').map((x) => x.trim()).filter((x) => DIETS[x]);
  if (!diets.length) throw new HttpError(400, 'DIET_REQUIRED', 'Choose at least one diet.');
  const texture = TEXTURES[String(b.texture)] ? String(b.texture) : '';
  const drinks = DRINKS[String(b.drinks)] ? String(b.drinks) : '';
  if (!texture || !drinks) throw new HttpError(400, 'LEVEL_REQUIRED', 'Choose the food texture and drink thickness.');
  const t = (v?: string, n = 500) => (v ?? '').trim().slice(0, n) || null;
  const assessment = t(b.assessment, 1000);
  if ((texture !== '7' || drinks !== '0') && (!assessment || assessment.length < 3)) {
    throw new HttpError(400, 'ASSESSMENT_REQUIRED', 'A modified texture or thickness needs the swallowing assessment it rests on.');
  }
  const reason = (b.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why this diet is needed.');
  return {
    diets: diets.join(','), texture, drinks, assistance: ASSIST[String(b.assistance)] ? String(b.assistance) : 'INDEPENDENT',
    supplements: t(b.supplements), preferences: t(b.preferences), assessment, reason,
    review_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null,
  };
}

export function order(store: Store, ctx: WorkContext, personId: string, b: Fields) {
  enforce(store, ctx, { op: 'DIET_ORDER', personId }, personId);
  const v = clean(b);
  if (store.get("SELECT 1 FROM diet_order WHERE person_id = ? AND state = 'ACTIVE'", personId)) {
    throw new HttpError(409, 'ALREADY_ACTIVE', 'There is already a diet for this patient. Review it to change it.');
  }
  const id = newId();
  store.tx(() => {
    store.insert('diet_order', { id, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', ordered_by: ctx.workerId, ordered_at: now() });
    recordInitial(store, 'diet', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, `${TEXTURES[v.texture]}, drinks ${DRINKS[v.drinks]}`);
    logged(store, ctx, 'DIET_ORDER', personId, id, `${TEXTURES[v.texture]}, drinks ${DRINKS[v.drinks]}`);
  });
  return { id };
}

const load = (store: Store, id: string) => {
  const d = store.get<Row>(`${SELECT} WHERE d.id = ?`, id);
  if (!d) throw new HttpError(404, 'NOT_FOUND', 'That diet no longer exists.');
  return d;
};

// A meal: given (how much eaten, how tolerated), refused, withheld or away.
export function meal(store: Store, ctx: WorkContext, id: string, b: { meal?: string; outcome?: string; intake?: string; tolerance?: string; note?: string }) {
  const d = load(store, id);
  const personId = String(d.personId);
  if (d.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This diet is no longer in place.');
  enforce(store, ctx, { op: 'MEAL_RECORD', personId }, personId);
  const which = String(b.meal);
  if (!MEALS[which]) throw new HttpError(400, 'MEAL_REQUIRED', 'Choose the meal.');
  const outcome = String(b.outcome);
  if (!OUTCOMES[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what happened.');
  const nbm = nilByMouth(store, personId);
  if (nbm && outcome === 'GIVEN') throw new HttpError(409, 'NIL_BY_MOUTH', `Nil by mouth is in force: ${nbm.detail}. Record the meal as withheld.`);
  if (outcome === 'GIVEN' && nothingByMouth(store, personId)) throw new HttpError(409, 'TUBE_FED', 'They are tube fed with nothing by mouth. Record the meal as withheld.');
  const given = outcome === 'GIVEN';
  const intake = given ? (INTAKE[String(b.intake)] ? String(b.intake) : null) : null;
  if (given && !intake) throw new HttpError(400, 'INTAKE_REQUIRED', 'Choose how much was eaten.');
  const tolerance = given ? (TOLERANCE[String(b.tolerance)] ? String(b.tolerance) : 'FINE') : null;
  const note = (b.note ?? '').trim().slice(0, 500) || null;
  if ((tolerance && tolerance !== 'FINE' || outcome === 'REFUSED') && !note) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what happened.');
  const today = todayLocal();
  if (which !== 'SNACK' && store.get('SELECT 1 FROM meal_record WHERE person_id = ? AND meal_date = ? AND meal = ?', personId, today, which)) {
    throw new HttpError(409, 'ALREADY_RECORDED', `${MEALS[which].label} is already recorded for today.`);
  }
  const mid = newId();
  store.tx(() => {
    store.insert('meal_record', {
      id: mid, diet_order_id: id, person_id: personId, meal_date: today, meal: which, outcome, intake, tolerance,
      note: nbm && outcome === 'WITHHELD' && !note ? `Nil by mouth: ${nbm.detail}` : note, recorded_by: ctx.workerId, recorded_at: now(),
    });
    logged(store, ctx, `MEAL_${outcome}`, personId, id, `${MEALS[which].label}${intake ? `: ${INTAKE[intake]}` : ''}${tolerance && tolerance !== 'FINE' ? `, ${TOLERANCE[tolerance]}` : ''}`);
  });
  return shape(store, ctx, load(store, id));
}

// Review: continue, change (the old order is superseded and the new one links back) or stop.
export function review(store: Store, ctx: WorkContext, id: string, b: Fields & { outcome?: string; finding?: string }) {
  const d = load(store, id);
  const personId = String(d.personId);
  if (d.serviceId !== ctx.serviceId) throw new HttpError(403, 'BLOCK', 'This diet was ordered by another service.');
  enforce(store, ctx, { op: 'DIET_ORDER', personId }, personId);
  if (d.state !== 'ACTIVE') throw new HttpError(409, 'NOT_ACTIVE', 'This diet is no longer in place.');
  const outcome = String(b.outcome);
  if (!REVIEW[outcome]) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose continue, change or stop.');
  const finding = (b.finding ?? '').trim().slice(0, 1000);
  if (finding.length < 3) throw new HttpError(400, 'FINDING_REQUIRED', 'Write what the review found.');
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  let result = id;
  store.tx(() => {
    store.insert('diet_review', { id: newId(), diet_order_id: id, reviewed_by: ctx.workerId, reviewed_at: now(), outcome, finding });
    if (outcome === 'CONTINUE') {
      store.run('UPDATE diet_order SET review_date = ? WHERE id = ?', /^\d{4}-\d{2}-\d{2}$/.test(String(b.reviewDate)) ? String(b.reviewDate) : null, id);
    } else if (outcome === 'CHANGED') {
      const v = clean(b);
      transition(store, 'diet', id, 'SUPERSEDED', who, finding);
      store.run('UPDATE diet_order SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), finding, id);
      result = newId();
      store.insert('diet_order', { id: result, person_id: personId, service_id: ctx.serviceId, ...v, state: 'ACTIVE', ordered_by: ctx.workerId, ordered_at: now(), supersedes_id: id });
      recordInitial(store, 'diet', result, 'ACTIVE', who, `Changed to ${TEXTURES[v.texture]}, drinks ${DRINKS[v.drinks]}`);
    } else {
      transition(store, 'diet', id, 'CEASED', who, finding);
      store.run('UPDATE diet_order SET closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?', ctx.workerId, now(), finding, id);
    }
    logged(store, ctx, `DIET_${outcome}`, personId, id, finding);
  });
  return shape(store, ctx, load(store, result));
}

// Home → Diets and meals: this service's patients with a diet, swallowing concerns first.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('meal.record') && !ctx.role.capabilities.includes('diet.order')) {
    throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include meals`);
  }
  const rows = store.all<Row>(`${SELECT} WHERE d.service_id = ? AND d.state = 'ACTIVE' ORDER BY p.family_name`, ctx.serviceId).map((d) => shape(store, ctx, d));
  rows.sort((a, b) => Number(!!b.concern) - Number(!!a.concern) || Number(b.modified) - Number(a.modified));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_MEALS', decision: 'ALLOW', outcome: 'VIEWED', engines: [42] });
  return { orders: rows, options: options() };
}

// For the alert engine: coughing or choking at a meal since the diet was last reviewed.
export function swallowConcerns(store: Store, serviceId: string) {
  return store.all<Row>(`${SELECT} WHERE d.service_id = ? AND d.state = 'ACTIVE'`, serviceId)
    .map((d) => ({ d, c: concern(store, d) }))
    .filter((x) => x.c)
    .map(({ d, c }) => ({
      personId: String(d.personId), objectId: String(d.id),
      title: `${TOLERANCE[String(c!.tolerance)]} at ${MEALS[String(c!.meal)].label.toLowerCase()}`,
      detail: `${c!.note ?? ''} On ${TEXTURES[String(d.texture)]}, drinks ${DRINKS[String(d.drinks)]}.`.trim(),
    }));
}
