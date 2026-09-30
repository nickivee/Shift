import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, revise } from './lifecycle.ts';
import { PLACES, STATES, END, REVIEW_HOURS, REFS } from '../config/endoflife.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Palliative and end-of-life care (entries 53, 54, 166):
//   recognised as needing palliative care → discussed with the person and whānau → wishes recorded
//   (where to be cared for and to die, what matters, who to call) → reviewed by a set time →
//   last days of life recognised and whānau told → comfort checked → death (death_event, deaths.ts)
//   → whānau followed up after the death.
// A nurse or doctor records the plan and its changes; caregivers, who give most of the comfort
// care, record comfort checks. The plan shows at the top of the record for everyone. It records
// wishes; it is not an advance directive (RR-ADVDIR-001) and holds no resuscitation or treatment
// limitation decision, anticipatory prescribing or assisted dying process (RR-EOL-001).

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const pick = (map: Record<string, string>, v: unknown) => (map[String(v)] ? String(v) : '');
const hoursFrom = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const may = (store: Store, ctx: WorkContext, personId: string, op: 'PALLIATIVE' | 'PALLIATIVE_COMFORT') =>
  evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'eol_plan', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('eol_log', { id: newId(), plan_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT e.id, e.person_id AS personId, e.state, e.basis, e.agreed_with AS agreedWith, e.discussed, e.place_care AS placeCare, e.place_death AS placeDeath,
         e.wishes, e.call, e.anticipatory, e.review_due AS reviewDue, rb.display_name AS recordedBy, e.recorded_at AS recordedAt,
         lb.display_name AS lastDaysBy, e.last_days_at AS lastDaysAt, e.last_days_note AS lastDaysNote,
         eb.display_name AS endedBy, e.ended_at AS endedAt, e.end_reason AS endReason, e.end_note AS endNote, e.death_id AS deathId
    FROM eol_plan e
    JOIN workforce_person rb ON rb.id = e.recorded_by
    LEFT JOIN workforce_person lb ON lb.id = e.last_days_by
    LEFT JOIN workforce_person eb ON eb.id = e.ended_by`;

function shape(store: Store, r: Row, manage: boolean, comfort: boolean) {
  const state = String(r.state);
  const actions: string[] = [];
  if (state !== 'ENDED') {
    if (comfort) actions.push('comfort');
    if (manage) actions.push('review', 'change', state === 'PALLIATIVE' ? 'lastdays' : 'stable', 'end');
  } else if (manage && r.endReason === 'DIED') actions.push('bereavement');
  return {
    ...r, state, stateLabel: STATES[state],
    placeCareLabel: PLACES[String(r.placeCare)] ?? r.placeCare, placeDeathLabel: PLACES[String(r.placeDeath)] ?? r.placeDeath,
    endLabel: r.endReason ? END[String(r.endReason)] : null,
    overdue: state !== 'ENDED' && !!r.reviewDue && String(r.reviewDue) < now(),
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM eol_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.plan_id = ? ORDER BY l.at, l.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId, 'PALLIATIVE');
  const comfort = manage || may(store, ctx, personId, 'PALLIATIVE_COMFORT');
  const all = store.all<Row>(`${Q} WHERE e.person_id = ? ORDER BY e.recorded_at DESC`, personId).map((r) => shape(store, r, manage, comfort));
  return {
    plan: all.find((x) => x.state !== 'ENDED') ?? null,
    ended: all.filter((x) => x.state === 'ENDED'),
    canStart: manage,
    options: { places: PLACES, end: END, reviewHours: REVIEW_HOURS },
  };
}

// For the record header, for everyone who opens it.
export function current(store: Store, personId: string) {
  const r = store.get<Row>("SELECT state, place_death AS placeDeath, call FROM eol_plan WHERE person_id = ? AND state IN ('PALLIATIVE', 'LAST_DAYS')", personId);
  return r ? { state: String(r.state), label: STATES[String(r.state)], placeDeath: PLACES[String(r.placeDeath)] ?? null, call: r.call } : null;
}

function wishes(b: Body) {
  const placeCare = pick(PLACES, b.placeCare);
  if (!placeCare) throw new HttpError(400, 'PLACE_REQUIRED', 'Choose where they want to be cared for, or "Not said yet".');
  const placeDeath = pick(PLACES, b.placeDeath);
  if (!placeDeath) throw new HttpError(400, 'PLACE_REQUIRED', 'Choose where they want to be when they die, or "Not said yet".');
  return { place_care: placeCare, place_death: placeDeath, wishes: text(b.wishes) || null, call: text(b.call, 300) || null };
}

interface Body {
  basis?: string; agreedWith?: string; discussed?: string; placeCare?: string; placeDeath?: string; wishes?: string; call?: string; anticipatory?: string;
  reviewHours?: unknown; note?: string; whanauTold?: string; reason?: string;
}

const reviewDue = (v: unknown) => {
  const h = Number(v);
  if (!REVIEW_HOURS.includes(h)) throw new HttpError(400, 'REVIEW_REQUIRED', 'Choose when to look at the plan again.');
  return hoursFrom(h);
};

export function start(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'PALLIATIVE', personId }, personId);
  if (store.get("SELECT 1 FROM eol_plan WHERE person_id = ? AND state IN ('PALLIATIVE', 'LAST_DAYS')", personId)) {
    throw new HttpError(409, 'ALREADY', 'They already have a palliative care plan. Review or change that one.');
  }
  if (store.get("SELECT 1 FROM death_event WHERE person_id = ? AND state != 'ENTERED_IN_ERROR'", personId)) {
    throw new HttpError(409, 'DIED', 'Their death is already recorded.');
  }
  const basis = text(b.basis);
  if (basis.length < 10) throw new HttpError(400, 'BASIS_REQUIRED', 'Write why they need palliative care now, e.g. "Heart failure, more breathless at rest, eating less".');
  const agreedWith = text(b.agreedWith, 300);
  if (agreedWith.length < 3) throw new HttpError(400, 'AGREED_REQUIRED', 'Write who agreed this, e.g. "Dr Anna Whyte (GP) at review".');
  const discussed = text(b.discussed);
  if (discussed.length < 10) throw new HttpError(400, 'DISCUSSED_REQUIRED', 'Write what was talked about with them and their whānau, and who was there.');
  const w = wishes(b);
  const due = reviewDue(b.reviewHours);
  const id = newId();
  const say = `Palliative care. ${basis} Agreed with ${agreedWith}.`;
  store.tx(() => {
    store.insert('eol_plan', {
      id, person_id: personId, service_id: ctx.serviceId, state: 'PALLIATIVE', basis, agreed_with: agreedWith, discussed, ...w,
      anticipatory: text(b.anticipatory, 300) || null, review_due: due, recorded_by: ctx.workerId, recorded_at: now(),
    });
    recordInitial(store, 'eol_plan', id, 'PALLIATIVE', { actorId: ctx.workerId, workContextId: ctx.id }, say);
    note(store, id, 'STARTED', `${say} Talked about: ${discussed}`, ctx.workerId);
    logged(store, ctx, 'EOL_START', personId, id, say);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE e.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That plan is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: action === 'comfort' ? 'PALLIATIVE_COMFORT' : 'PALLIATIVE', personId }, personId);
  const state = String(r.state);
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  if (state === 'ENDED' && action !== 'bereavement') throw new HttpError(409, 'ENDED', 'This plan has ended.');
  store.tx(() => {
    switch (action) {
      case 'comfort': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you checked and did, e.g. "Mouth care, turned to left side, settled, no signs of pain".');
        note(store, id, 'COMFORT', say, ctx.workerId);
        logged(store, ctx, 'EOL_COMFORT', personId, id, say);
        break;
      }
      case 'review': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you found, e.g. "Settled; eating a little; wishes unchanged".');
        store.run('UPDATE eol_plan SET review_due = ? WHERE id = ?', reviewDue(b.reviewHours), id);
        note(store, id, 'REVIEWED', say, ctx.workerId);
        logged(store, ctx, 'EOL_REVIEW', personId, id, say);
        break;
      }
      case 'change': {
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write who said so and why, e.g. "Losa told Mele she wants to stay here".');
        const after = wishes(b);
        const changed = revise(store, 'eol_plan', id,
          { place_care: r.placeCare, place_death: r.placeDeath, wishes: r.wishes, call: r.call }, after,
          { place_care: ['Where to be cared for', PLACES], place_death: ['Where to be when they die', PLACES], wishes: 'What matters', call: 'Who to call' }, who, say);
        if (!changed) throw new HttpError(409, 'UNCHANGED', 'Nothing was changed.');
        store.run('UPDATE eol_plan SET place_care = ?, place_death = ?, wishes = ?, call = ? WHERE id = ?', after.place_care, after.place_death, after.wishes, after.call, id);
        note(store, id, 'CHANGED', `${changed}. ${say}`, ctx.workerId);
        logged(store, ctx, 'EOL_CHANGE', personId, id, changed);
        break;
      }
      case 'lastdays': {
        if (state !== 'PALLIATIVE') throw new HttpError(409, 'STATE', 'The last days of life are already recognised.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you saw and who agreed, e.g. "Not eating or drinking, sleeping most of the day; Dr Whyte agrees".');
        const told = text(b.whanauTold, 300);
        if (told.length < 3) throw new HttpError(400, 'TOLD_REQUIRED', 'Write which whānau were told and how, or why not yet.');
        transition(store, 'eol_plan', id, 'LAST_DAYS', who, say);
        store.run('UPDATE eol_plan SET last_days_by = ?, last_days_at = ?, last_days_note = ? WHERE id = ?', ctx.workerId, now(), `${say.replace(/\.?$/, '.')} Whānau: ${told}`, id);
        note(store, id, 'LAST_DAYS', `${say.replace(/\.?$/, '.')} Whānau: ${told}`, ctx.workerId);
        logged(store, ctx, 'EOL_LAST_DAYS', personId, id, say);
        break;
      }
      case 'stable': {
        if (state !== 'LAST_DAYS') throw new HttpError(409, 'STATE', 'Only a plan in the last days of life can go back.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what changed, e.g. "Eating and talking again after two days".');
        transition(store, 'eol_plan', id, 'PALLIATIVE', who, say);
        note(store, id, 'STABLE', say, ctx.workerId);
        logged(store, ctx, 'EOL_STABLE', personId, id, say);
        break;
      }
      case 'end': {
        const reason = pick(END, b.reason);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why the plan is ending.');
        if (reason === 'DIED') throw new HttpError(400, 'USE_DEATH', 'Record their death with "They have died" below. The plan ends with it.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what the decision was based on.');
        transition(store, 'eol_plan', id, 'ENDED', who, say);
        store.run('UPDATE eol_plan SET ended_by = ?, ended_at = ?, end_reason = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), reason, say, id);
        note(store, id, 'ENDED', `${END[reason]}. ${say}`, ctx.workerId);
        logged(store, ctx, 'EOL_END', personId, id, `${END[reason]}. ${say}`);
        break;
      }
      case 'bereavement': {
        if (r.endReason !== 'DIED') throw new HttpError(409, 'STATE', 'Whānau follow-up is recorded after a death.');
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write who you spoke with and what was offered, e.g. "Phoned Mele; offered the hospice bereavement service".');
        note(store, id, 'BEREAVEMENT', say, ctx.workerId);
        logged(store, ctx, 'EOL_BEREAVEMENT', personId, id, say);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}

// Called when a death is recorded: the plan ends with it, so it leaves the header.
export function endForDeath(store: Store, ctx: WorkContext, personId: string, deathId: string) {
  for (const r of store.all<Row>("SELECT id FROM eol_plan WHERE person_id = ? AND state IN ('PALLIATIVE', 'LAST_DAYS')", personId)) {
    const id = String(r.id);
    transition(store, 'eol_plan', id, 'ENDED', { actorId: ctx.workerId, workContextId: ctx.id }, 'Died');
    store.run("UPDATE eol_plan SET ended_by = ?, ended_at = ?, end_reason = 'DIED', end_note = 'Death recorded', death_id = ? WHERE id = ?", ctx.workerId, now(), deathId, id);
    note(store, id, 'ENDED', 'Died. Their death is recorded.', ctx.workerId);
  }
}
