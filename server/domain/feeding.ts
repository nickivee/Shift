import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { nilByMouth } from './restrictions.ts';
import { KINDS as TUBE_KINDS, STATES as TUBE_STATES } from '../config/devices.ts';
import { STATES, METHOD, ORAL, GIVEN, TOLERANCE, CONCERN, REVIEW, TUBES, REFS } from '../config/feeding.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// Tube feeding (entries 103, 188, 189, 191):
//   tube in place (Lines and tubes) → feed plan as the dietitian or doctor prescribed it: feed,
//   pump or bolus, rate and volumes, flushes, daily amount, and what they may have by mouth →
//   each feed, flush or hold given, and how it was tolerated → review → changed or stopped.
// Feeding needs the tube's position confirmed in Lines and tubes; SHIFT never feeds through a
// tube marked "do not use". Nothing by mouth on the plan stops meals being recorded as given.
// Ward doctors and nurses plan; nurses give; ARC caregivers see it.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Op = 'FEED_PLAN' | 'FEED_GIVE';

const may = (store: Store, ctx: WorkContext, personId: string, op: Op) => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'feed_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [103],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('feed_step', { id: newId(), plan_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT f.id, f.person_id AS personId, f.service_id AS serviceId, f.device_id AS deviceId, f.state, f.feed, f.method, f.regimen, f.flushes,
         f.target_ml AS targetMl, f.oral, f.prescribed_by AS prescribedBy, f.reason, f.review_date AS reviewDate,
         sb.display_name AS startedBy, f.started_at AS startedAt, xb.display_name AS stoppedBy, f.stopped_at AS stoppedAt, f.stop_reason AS stopReason,
         d.kind AS tubeKind, d.site AS tubeSite, d.state AS tubeState
    FROM feed_plan f
    JOIN workforce_person sb ON sb.id = f.started_by
    LEFT JOIN workforce_person xb ON xb.id = f.stopped_by
    JOIN device d ON d.id = f.device_id`;

const tubeLabel = (kind: unknown, site: unknown) => `${TUBE_KINDS[String(kind)]?.short ?? 'Tube'}${site ? `, ${site}` : ''}`;

// Tubes they have in now that a feed could go through.
const tubes = (store: Store, personId: string) => store.all<Row>(
  `SELECT id, kind, site, state FROM device WHERE person_id = ? AND state != 'REMOVED' AND kind IN (${TUBES.map(() => '?').join(',')}) ORDER BY inserted_at DESC`, personId, ...TUBES,
).map((t) => ({ id: String(t.id), label: tubeLabel(t.kind, t.site), state: String(t.state), stateLabel: TUBE_STATES[String(t.state)] }));

function given(store: Store, id: string) {
  return store.all<Row>(
    `SELECT g.kind, g.ml, g.tolerance, g.note, w.display_name AS "by", g.at FROM feed_given g JOIN workforce_person w ON w.id = g.by_id
      WHERE g.plan_id = ? ORDER BY g.at DESC, g.rowid DESC LIMIT 60`, id,
  ).map((g): Record<string, any> => ({ ...g, kindLabel: GIVEN[String(g.kind)], toleranceLabel: g.tolerance ? TOLERANCE[String(g.tolerance)] : null, concern: CONCERN.includes(String(g.tolerance)) }));
}

// Why a feed cannot go through the tube right now, in words, or null when it can.
function blocked(r: Row) {
  if (r.state !== 'ACTIVE') return 'Tube feeding has stopped.';
  if (r.tubeState === 'REMOVED') return 'The tube has been removed. Review the plan to choose the new tube.';
  if (r.tubeState !== 'IN_PLACE') return 'The tube position is not confirmed: do not use it. Confirm it in Lines and tubes first.';
  return null;
}

function shape(store: Store, ctx: WorkContext, r: Row, can: { plan: boolean; give: boolean }): Record<string, any> {
  const id = String(r.id);
  const personId = String(r.personId);
  const active = r.state === 'ACTIVE';
  const all = given(store, id);
  const today = todayLocal();
  const ofToday = all.filter((g) => todayLocal(new Date(String(g.at))) === today);
  const sum = (kinds: string[]) => ofToday.filter((g) => kinds.includes(String(g.kind))).reduce((n, g) => n + Number(g.ml ?? 0), 0);
  const lastReview = store.get<{ at: string | null }>("SELECT MAX(at) AS at FROM feed_step WHERE plan_id = ? AND kind IN ('REVIEW', 'CHANGED', 'STARTED')", id)?.at ?? '';
  const concern = active ? all.find((g) => g.concern && String(g.at) > lastReview) ?? null : null;
  const why = active ? blocked(r) : null;
  return {
    ...r, stateLabel: STATES[String(r.state)], methodLabel: METHOD[String(r.method)], oralLabel: ORAL[String(r.oral)],
    tube: tubeLabel(r.tubeKind, r.tubeSite), tubeStateLabel: TUBE_STATES[String(r.tubeState)],
    today: { feed: sum(['FEED']), water: sum(['FLUSH', 'WATER']), held: ofToday.some((g) => g.kind === 'HELD') },
    recent: all.slice(0, 10), concern, blocked: why,
    reviewDue: active && !!r.reviewDate && String(r.reviewDate) <= today,
    nbm: active ? nilByMouth(store, personId) : null,
    canGive: active && can.give && !why, canReview: active && can.plan,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM feed_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.plan_id = ? ORDER BY s.at, s.rowid', id),
  };
}

const options = () => ({ method: METHOD, oral: ORAL, given: GIVEN, tolerance: TOLERANCE, review: REVIEW });

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const caps = ctx.role.capabilities as string[];
  if (!['feed.plan', 'feed.give', 'feed.view'].some((c) => caps.includes(c))) return null;
  const can = { plan: may(store, ctx, personId, 'FEED_PLAN'), give: may(store, ctx, personId, 'FEED_GIVE') };
  const all = store.all<Row>(`${Q} WHERE f.person_id = ? ORDER BY f.started_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  const current = all.filter((x) => x.state === 'ACTIVE');
  const available = tubes(store, personId);
  if (!all.length && !(can.plan && available.length)) return null;
  return { current, past: all.filter((x) => x.state !== 'ACTIVE').slice(0, 5), canStart: can.plan && !current.length, tubes: available, options: options() };
}

// For the record header: they are tube fed, through what, and what they may have by mouth.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE f.person_id = ? AND f.state = 'ACTIVE' ORDER BY f.started_at DESC LIMIT 1`, personId);
  if (!r) return null;
  return { tube: tubeLabel(r.tubeKind, r.tubeSite), method: METHOD[String(r.method)], oral: ORAL[String(r.oral)], nothingByMouth: r.oral === 'NIL', blocked: blocked(r) };
}

// For meals: a feed plan that allows nothing by mouth.
export function nothingByMouth(store: Store, personId: string) {
  return !!store.get("SELECT 1 FROM feed_plan WHERE person_id = ? AND state = 'ACTIVE' AND oral = 'NIL'", personId);
}

interface Body {
  deviceId?: string; feed?: string; method?: string; regimen?: string; flushes?: string; targetMl?: unknown; oral?: string;
  prescribedBy?: string; reason?: string; reviewDate?: string;
  kind?: string; ml?: unknown; tolerance?: string; note?: string; outcome?: string; finding?: string;
}

function clean(store: Store, personId: string, b: Body) {
  const deviceId = String(b.deviceId ?? '');
  const tube = tubes(store, personId).find((t) => t.id === deviceId);
  if (!tube) throw new HttpError(400, 'TUBE_REQUIRED', 'Choose the feeding tube. If it is not listed, record it in Lines and tubes first.');
  const feed = text(b.feed, 120);
  if (feed.length < 3) throw new HttpError(400, 'FEED_REQUIRED', 'Write the feed, as prescribed, e.g. "Standard 1.5 kcal/mL feed".');
  const method = pick(METHOD, b.method);
  if (!method) throw new HttpError(400, 'METHOD_REQUIRED', 'Choose how the feed is given.');
  const regimen = text(b.regimen, 600);
  if (regimen.length < 5) throw new HttpError(400, 'REGIMEN_REQUIRED', 'Write the rate or volumes and times, exactly as prescribed.');
  const oral = pick(ORAL, b.oral);
  if (!oral) throw new HttpError(400, 'ORAL_REQUIRED', 'Choose what they may have by mouth.');
  const prescribedBy = text(b.prescribedBy, 160);
  if (prescribedBy.length < 3) throw new HttpError(400, 'PRESCRIBER_REQUIRED', 'Write who prescribed the feed and when, e.g. "Dietitian A. Smith, 30 Sep".');
  const raw = String(b.targetMl ?? '').trim();
  const target = raw === '' ? null : Number(raw);
  if (target !== null && (!Number.isInteger(target) || target < 1 || target > 5000)) throw new HttpError(400, 'TARGET', 'Write the prescribed feed per day in mL, or leave it empty.');
  return {
    device_id: deviceId, feed, method, regimen, flushes: text(b.flushes, 300) || null, target_ml: target, oral, prescribed_by: prescribedBy,
    review_date: DAY.test(String(b.reviewDate)) ? String(b.reviewDate) : null,
  };
}

export function start(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'FEED_PLAN', personId }, personId);
  if (store.get("SELECT 1 FROM feed_plan WHERE person_id = ? AND state = 'ACTIVE'", personId)) throw new HttpError(409, 'ALREADY', 'Tube feeding is already planned. Review it to change it.');
  const v = clean(store, personId, b);
  const reason = text(b.reason, 400);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why they need tube feeding, e.g. "Unsafe swallow after stroke".');
  const id = newId();
  store.tx(() => {
    store.insert('feed_plan', { id, person_id: personId, service_id: ctx.serviceId, state: 'ACTIVE', ...v, reason, started_by: ctx.workerId, started_at: now() });
    recordInitial(store, 'feed_plan', id, 'ACTIVE', { actorId: ctx.workerId, workContextId: ctx.id }, v.feed);
    step(store, id, 'STARTED', `${v.feed}, ${METHOD[v.method].toLowerCase()}: ${sentence(v.regimen)}${v.flushes ? ` Flushes: ${sentence(v.flushes)}` : ''} By mouth: ${ORAL[v.oral].toLowerCase()}. Prescribed by ${v.prescribed_by}. For: ${sentence(reason)}`, ctx.workerId);
    logged(store, ctx, 'FEED_START', personId, id, v.feed);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE f.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That feed plan is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: action === 'give' ? 'FEED_GIVE' : 'FEED_PLAN', personId }, personId);
  if (r.state !== 'ACTIVE') throw new HttpError(409, 'STOPPED', 'Tube feeding has stopped.');
  const note = text(b.note);
  store.tx(() => {
    switch (action) {
      case 'give': {
        const why = blocked(r);
        if (why) throw new HttpError(409, 'TUBE_NOT_READY', why);
        const kind = pick(GIVEN, b.kind);
        if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what was given.');
        const held = kind === 'HELD';
        const ml = held ? null : Number(b.ml);
        if (!held && (!Number.isInteger(ml) || ml! < 1 || ml! > 2000)) throw new HttpError(400, 'ML_REQUIRED', 'Write how many mL were given.');
        const tolerance = held ? null : pick(TOLERANCE, b.tolerance) || 'FINE';
        if ((held || tolerance !== 'FINE') && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', held ? 'Write why the feed was held and who you told.' : 'Write what happened and who you told.');
        store.insert('feed_given', { id: newId(), plan_id: id, kind, ml, tolerance, note: note || null, by_id: ctx.workerId, at: now() });
        logged(store, ctx, `FEED_${kind}`, personId, id, `${GIVEN[kind]}${ml ? ` ${ml} mL` : ''}${tolerance && tolerance !== 'FINE' ? `, ${TOLERANCE[tolerance]}` : ''}`);
        break;
      }
      case 'review': {
        const outcome = pick(REVIEW, b.outcome);
        if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose continue, change or stop.');
        const finding = text(b.finding);
        if (finding.length < 3) throw new HttpError(400, 'FINDING_REQUIRED', 'Write what the review found, e.g. weight, bowels, how the feeds are going.');
        if (outcome === 'CONTINUE') {
          store.run('UPDATE feed_plan SET review_date = ? WHERE id = ?', DAY.test(String(b.reviewDate)) ? String(b.reviewDate) : null, id);
          step(store, id, 'REVIEW', `Reviewed, continue: ${sentence(finding)}`, ctx.workerId);
        } else if (outcome === 'CHANGED') {
          const v = clean(store, personId, b);
          store.run('UPDATE feed_plan SET device_id = ?, feed = ?, method = ?, regimen = ?, flushes = ?, target_ml = ?, oral = ?, prescribed_by = ?, review_date = ? WHERE id = ?',
            v.device_id, v.feed, v.method, v.regimen, v.flushes, v.target_ml, v.oral, v.prescribed_by, v.review_date, id);
          step(store, id, 'CHANGED', `Changed: ${sentence(finding)} Now ${v.feed}, ${METHOD[v.method].toLowerCase()}: ${sentence(v.regimen)}${v.flushes ? ` Flushes: ${sentence(v.flushes)}` : ''} By mouth: ${ORAL[v.oral].toLowerCase()}. Prescribed by ${v.prescribed_by}.`, ctx.workerId);
        } else {
          transition(store, 'feed_plan', id, 'STOPPED', { actorId: ctx.workerId, workContextId: ctx.id }, finding);
          store.run('UPDATE feed_plan SET stopped_by = ?, stopped_at = ?, stop_reason = ? WHERE id = ?', ctx.workerId, now(), finding, id);
          step(store, id, 'STOPPED', `Stopped: ${sentence(finding)}`, ctx.workerId);
        }
        logged(store, ctx, `FEED_${outcome}`, personId, id, finding);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
