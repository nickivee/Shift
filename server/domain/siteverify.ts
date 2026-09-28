import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { SIDES, CHECK_KINDS, SOURCES, OUTCOMES, OUTCOMES_FOR } from '../config/siteverify.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Procedure Site / Laterality Verification (Shared Lifecycle Object 291):
//   procedure planned → intended site/laterality → source evidence → patient/team verification
//   where applicable → discrepancy → resolution → final verified state → procedure linkage.
// Whoever plans a procedure records the intended site and side. Before it happens the site is
// checked against at least one document, with the person (or recorded why they cannot confirm),
// marked (or recorded why no mark is needed), and confirmed by the team at a time-out. Any check that
// does not match stops the procedure: the discrepancy must be resolved by the proceduralist before
// checking starts again, and the team time-out is always done again after a stop. Once every check agrees the site is verified, and the procedure is linked
// when done, with the site it was actually done on. Anyone can stop a verified site with a concern.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  PLANNED: 'Being checked', DISCREPANCY: 'Stop: site does not match', VERIFIED: 'Site verified', DONE: 'Procedure done', CANCELLED: 'Cancelled',
  ENTERED_IN_ERROR: 'Entered in error',
};
const OPEN = ['PLANNED', 'DISCREPANCY', 'VERIFIED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-SITE-001'];

const Q = `
  SELECT v.id, v.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = v.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         v.service_id AS serviceId, s.name AS service, v.procedure, v.planned_for AS plannedFor, v.site, v.side, v.detail, v.state,
         pb.display_name AS plannedBy, v.planned_by AS plannedById, v.planned_at AS plannedAt,
         vb.display_name AS verifiedBy, v.verified_at AS verifiedAt,
         db.display_name AS doneBy, v.done_at AS doneAt, v.done_ref AS doneRef, v.done_mismatch AS doneMismatch, v.done_note AS doneNote,
         eb.display_name AS endedBy, v.ended_at AS endedAt, v.ended_note AS endedNote
    FROM site_verification v
    JOIN person p ON p.id = v.person_id
    JOIN service s ON s.id = v.service_id
    JOIN workforce_person pb ON pb.id = v.planned_by
    LEFT JOIN workforce_person vb ON vb.id = v.verified_by
    LEFT JOIN workforce_person db ON db.id = v.done_by
    LEFT JOIN workforce_person eb ON eb.id = v.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'SITE_CHECK', personId }).decision === 'ALLOW';
const resolver = (ctx: WorkContext) => ctx.role.capabilities.includes('sitecheck.resolve');
const where = (r: Record<string, unknown>) => {
  const site = String(r.site).toLowerCase();
  const text = r.side === 'BILATERAL' ? `${site}, both sides` : `${r.side && r.side !== 'NOT_APPLICABLE' ? `${SIDES[String(r.side)]} ` : ''}${site}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${r.detail ? ` (${r.detail})` : ''}`;
};

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'site_verification', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addCheck = (store: Store, ctx: WorkContext, id: string, kind: string, x: { source?: string | null; outcome?: string | null; stated?: string | null; note?: string | null }) =>
  store.insert('site_check', {
    id: newId(), verification_id: id, kind, source: x.source ?? null, outcome: x.outcome ?? null, stated: x.stated ?? null, note: x.note ?? null,
    superseded: 0, by_id: ctx.workerId, at: now(),
  });

function checks(store: Store, id: string) {
  return store.all<Row>(`SELECT c.id, c.kind, c.source, c.outcome, c.stated, c.note, c.superseded, w.display_name AS "by", c.at FROM site_check c
      JOIN workforce_person w ON w.id = c.by_id WHERE c.verification_id = ? ORDER BY c.at, c.rowid`, id)
    .map((c) => ({
      ...c, kind: String(c.kind), outcome: c.outcome ? String(c.outcome) : null, superseded: Boolean(c.superseded),
      kindLabel: CHECK_KINDS[String(c.kind)] ?? ({ PLANNED: 'Planned', RESOLVED: 'Discrepancy resolved', CONCERN: 'Concern raised', VERIFIED: 'Verified', DONE: 'Procedure done', CANCELLED: 'Cancelled', ERROR: 'Entered in error' } as Record<string, string>)[String(c.kind)] ?? String(c.kind),
      sourceLabel: c.source ? SOURCES[String(c.source)] ?? String(c.source) : null,
      outcomeLabel: c.outcome ? OUTCOMES[String(c.outcome)] ?? String(c.outcome) : null,
    }));
}

// What is still needed before the site can be verified.
function missing(live: ReturnType<typeof checks>, side: string) {
  const has = (kind: string, ...o: string[]) => live.some((c) => c.kind === kind && o.includes(String(c.outcome)));
  const out: string[] = [];
  if (!has('SOURCE', 'MATCH')) out.push('Check against a document');
  if (!has('PATIENT', 'MATCH', 'UNABLE')) out.push('Check with the person');
  if (!has('MARK', 'MATCH', 'NOT_REQUIRED')) out.push(side === 'NOT_APPLICABLE' || side === 'MIDLINE' ? 'Mark the site, or record why not' : 'Mark the site');
  if (!has('TEAM', 'MATCH')) out.push('Team time-out');
  return out;
}

// Sites that do not match, and procedures done on a different site, for the record's header.
export function current(store: Store, personId: string) {
  return store.all<Row>(`SELECT procedure, site, side, detail, state FROM site_verification WHERE person_id = ?
      AND (state = 'DISCREPANCY' OR (state = 'DONE' AND done_mismatch = 1 AND done_at >= ?)) ORDER BY planned_for`, personId, new Date(Date.now() - 30 * 86_400_000).toISOString())
    .map((r) => `${r.state === 'DONE' ? 'Done on a different site: ' : ''}${r.procedure} (planned ${where(r)})`);
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const all = checks(store, id);
  const live = all.filter((c) => ['SOURCE', 'PATIENT', 'MARK', 'TEAM'].includes(c.kind) && !c.superseded);
  const todo = missing(live, String(r.side));
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (state === 'PLANNED') actions.push('check');
    if (state === 'PLANNED' && !todo.length) actions.push('verify');
    if (state === 'DISCREPANCY' && resolver(ctx)) actions.push('resolve');
    if (state === 'VERIFIED') actions.push('done', 'concern');
    if (OPEN.includes(state)) actions.push('cancel');
    if (OPEN.includes(state) && (resolver(ctx) || r.plannedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], sideLabel: SIDES[String(r.side)] ?? String(r.side), where: where(r), plannedFor: String(r.plannedFor),
    checks: live, todo, mismatches: live.filter((c) => c.outcome === 'MISMATCH'), doneMismatch: Boolean(r.doneMismatch),
    actions,
    log: all,
    history: history(store, 'sitecheck', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE v.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That site check is no longer in SHIFT.');
  return r;
};

function siteFields(b: { site?: string; side?: string; detail?: string }) {
  const site = text(b.site, 120);
  if (site.length < 3) throw new HttpError(400, 'SITE_REQUIRED', 'Write the site, e.g. "Knee" or "Chest, 5th intercostal space".');
  const side = SIDES[String(b.side)] ? String(b.side) : '';
  if (!side) throw new HttpError(400, 'SIDE_REQUIRED', 'Choose the side. Choose "No side" only if the site has none.');
  return { site, side, detail: text(b.detail, 200) || null };
}

export function plan(store: Store, ctx: WorkContext, personId: string, b: { procedure?: string; plannedFor?: string; site?: string; side?: string; detail?: string }) {
  enforce(store, ctx, { op: 'SITE_CHECK', personId }, personId);
  const procedure = text(b.procedure, 200);
  if (procedure.length < 3) throw new HttpError(400, 'PROCEDURE_REQUIRED', 'Write the procedure, e.g. "Knee aspiration".');
  const when = Date.parse(String(b.plannedFor ?? ''));
  if (Number.isNaN(when) || when < Date.now() - 12 * 3_600_000 || when > Date.now() + 90 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it is planned.');
  const s = siteFields(b);
  store.tx(() => {
    const id = newId();
    store.insert('site_verification', {
      id, person_id: personId, service_id: ctx.serviceId, procedure, planned_for: new Date(when).toISOString(), site: s.site, side: s.side, detail: s.detail,
      state: 'PLANNED', planned_by: ctx.workerId, planned_at: now(), done_mismatch: 0,
    });
    recordInitial(store, 'sitecheck', id, 'PLANNED', { actorId: ctx.workerId, workContextId: ctx.id }, `${procedure}: ${where(s)}`);
    addCheck(store, ctx, id, 'PLANNED', { note: `${procedure}: ${where(s)}.` });
    logged(store, ctx, 'SITE_PLAN', personId, id, `${procedure}: ${where(s)}`);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { kind?: string; source?: string; outcome?: string; stated?: string; note?: string; keep?: string; site?: string; side?: string; detail?: string;
    when?: string; ref?: string; matched?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'SITE_CHECK', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This site check belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This site check is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  switch (action) {
    case 'check': {
      inState('PLANNED');
      const kind = CHECK_KINDS[String(b.kind)] ? String(b.kind) : '';
      if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose the check.');
      const outcome = OUTCOMES_FOR[kind].includes(String(b.outcome)) ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what the check found.');
      const source = kind === 'SOURCE' ? (SOURCES[String(b.source)] ? String(b.source) : '') : null;
      if (kind === 'SOURCE' && !source) throw new HttpError(400, 'SOURCE_REQUIRED', 'Choose the document you checked.');
      const stated = text(b.stated, 200);
      if (outcome === 'MISMATCH' && stated.length < 3) throw new HttpError(400, 'STATED_REQUIRED', 'Write what it says instead, e.g. "Left knee".');
      if (outcome === 'UNABLE') need(5, 'Say why they cannot confirm, and who else you checked with, e.g. "Drowsy; confirmed with daughter Mere".');
      if (outcome === 'NOT_REQUIRED') need(5, 'Say why no mark is needed, e.g. "Midline, no side".');
      store.tx(() => {
        addCheck(store, ctx, id, kind, { source, outcome, stated: stated || null, note: note || null });
        if (outcome === 'MISMATCH') {
          transition(store, 'sitecheck', id, 'DISCREPANCY', who, `${CHECK_KINDS[kind]}: ${stated}`);
          logged(store, ctx, 'SITE_DISCREPANCY', personId, id, `${CHECK_KINDS[kind]}: ${stated}`);
        } else logged(store, ctx, `SITE_CHECK_${kind}`, personId, id, outcome);
      });
      break;
    }
    case 'resolve': {
      if (!resolver(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot resolve a site discrepancy. Ask the person doing the procedure.`);
      inState('DISCREPANCY');
      need(10, 'Write how you resolved it and what you checked, e.g. "Rechecked the CT with radiology: the effusion is on the right".');
      const keep = b.keep === 'KEEP';
      const s = keep ? null : siteFields(b);
      store.tx(() => {
        store.run('UPDATE site_check SET superseded = 1 WHERE verification_id = ? AND kind IN (\'SOURCE\', \'PATIENT\', \'MARK\', \'TEAM\')' + (keep ? " AND (outcome = 'MISMATCH' OR kind = 'TEAM')" : ''), id);
        if (s) store.run('UPDATE site_verification SET site = ?, side = ?, detail = ? WHERE id = ?', s.site, s.side, s.detail, id);
        transition(store, 'sitecheck', id, 'PLANNED', who, note.slice(0, 200));
        addCheck(store, ctx, id, 'RESOLVED', { note: `${keep ? `Planned site stands: ${where(r)}; the team time-out must be done again` : `Planned site changed to ${where(s!)}; every check must be done again`}. ${note}` });
        logged(store, ctx, 'SITE_RESOLVE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'verify': {
      inState('PLANNED');
      const live = checks(store, id).filter((c) => ['SOURCE', 'PATIENT', 'MARK', 'TEAM'].includes(c.kind) && !c.superseded);
      const todo = missing(live, String(r.side));
      if (todo.length) throw new HttpError(409, 'CHECKS_MISSING', `Still needed: ${todo.join('; ')}.`);
      store.tx(() => {
        transition(store, 'sitecheck', id, 'VERIFIED', who, where(r));
        store.run('UPDATE site_verification SET verified_by = ?, verified_at = ? WHERE id = ?', ctx.workerId, at, id);
        addCheck(store, ctx, id, 'VERIFIED', { note: `${where(r)}.${note ? ` ${note}` : ''}` });
        logged(store, ctx, 'SITE_VERIFY', personId, id, where(r));
      });
      break;
    }
    case 'concern': {
      inState('VERIFIED');
      need(5, 'Say what worries you, e.g. "He says it is the other knee that hurts".');
      store.tx(() => {
        transition(store, 'sitecheck', id, 'DISCREPANCY', who, note.slice(0, 200));
        addCheck(store, ctx, id, 'CONCERN', { outcome: 'MISMATCH', note });
        logged(store, ctx, 'SITE_CONCERN', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'done': {
      inState('VERIFIED');
      const ref = text(b.ref, 200);
      if (ref.length < 3) throw new HttpError(400, 'REF_REQUIRED', 'Say where the procedure is recorded, e.g. "Procedure note 1030".');
      const matched = b.matched === 'YES' ? true : b.matched === 'NO' ? false : null;
      if (matched === null) throw new HttpError(400, 'MATCHED_REQUIRED', 'Say whether it was done on the verified site and side.');
      if (!matched) need(10, 'Say where it was done and what happened. Report this as an incident too.');
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when > Date.now() + 5 * 60_000 || when < Date.now() - 7 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it was done, in the last week.');
      store.tx(() => {
        transition(store, 'sitecheck', id, 'DONE', who, matched ? ref : `Different site: ${note.slice(0, 150)}`);
        store.run('UPDATE site_verification SET done_by = ?, done_at = ?, done_ref = ?, done_mismatch = ?, done_note = ? WHERE id = ?',
          ctx.workerId, new Date(when).toISOString(), ref, matched ? 0 : 1, note || null, id);
        addCheck(store, ctx, id, 'DONE', { outcome: matched ? 'MATCH' : 'MISMATCH', note: `${ref}.${matched ? ' Done on the verified site.' : ` Done on a different site. ${note}`}` });
        logged(store, ctx, matched ? 'SITE_DONE' : 'SITE_DONE_WRONG_SITE', personId, id, ref);
      });
      break;
    }
    case 'cancel':
    case 'error': {
      inState(...OPEN);
      if (action === 'error' && !resolver(ctx) && r.plannedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who planned it, or the proceduralist, can mark it as an error.');
      need(action === 'error' ? 10 : 5, action === 'error' ? 'Write why this was entered in error, e.g. "Planned for the wrong person".' : 'Say why it is cancelled, e.g. "Effusion too small to tap".');
      store.tx(() => {
        transition(store, 'sitecheck', id, action === 'error' ? 'ENTERED_IN_ERROR' : 'CANCELLED', who, note.slice(0, 200));
        store.run('UPDATE site_verification SET ended_by = ?, ended_at = ?, ended_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        addCheck(store, ctx, id, action === 'error' ? 'ERROR' : 'CANCELLED', { note });
        logged(store, ctx, action === 'error' ? 'SITE_ERROR' : 'SITE_CANCEL', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Site checks view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE v.person_id = ? ORDER BY v.planned_for DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)).sort((a, b) => a.plannedFor.localeCompare(b.plannedFor)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canPlan: can,
    options: { sides: SIDES, kinds: CHECK_KINDS, sources: SOURCES, outcomes: OUTCOMES, outcomesFor: OUTCOMES_FOR },
  };
}

// Home → Site checks for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('sitecheck.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include site checks`);
  const rows = store.all<Row>(`${Q} WHERE v.service_id = ? AND v.state IN ('PLANNED', 'DISCREPANCY', 'VERIFIED') ORDER BY v.planned_for`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_SITE_CHECKS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    discrepancies: rows.filter((x) => x.state === 'DISCREPANCY'),
    checking: rows.filter((x) => x.state === 'PLANNED'),
    verified: rows.filter((x) => x.state === 'VERIFIED'),
  };
}
