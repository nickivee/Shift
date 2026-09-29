import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { audit } from './audit.ts';
import { enforce } from './record.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { FUNCTIONS, STATES, CHECK_OUTCOMES, STARTED_AGO_MINUTES, REFS } from '../config/downtime.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Downtime continuity (Cross-System Capability 317):
//   downtime declared → affected functions → approved continuity process → temporary clinical
//   recording → system restoration → reconciliation → provenance → closure.
// The nurse in charge declares what is down, and everyone in the service sees it with the paper
// process to use. Care goes on paper. When SHIFT is back, each paper record is entered at the time
// the care happened, marked as coming from paper and who wrote it. Every person in the service
// during the downtime is checked off, and the downtime is closed with what was learned.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);
const who = (ctx: WorkContext) => ({ actorId: ctx.workerId, workContextId: ctx.id });
const LOG: Record<string, string> = {
  DECLARED: 'Declared', RESTORED: 'Back up', CANCELLED: 'Cancelled', CHECKED: 'Person checked', CLOSED: 'Closed',
};

const Q = `
  SELECT d.id, d.service_id AS serviceId, s.name AS service, d.functions, d.reason, d.started_at AS startedAt, d.state,
         db.display_name AS declaredBy, d.declared_at AS declaredAt, rb.display_name AS restoredBy, d.restored_at AS restoredAt,
         d.restore_note AS restoreNote, cb.display_name AS closedBy, d.closed_at AS closedAt, d.close_note AS closeNote
    FROM downtime d
    JOIN service s ON s.id = d.service_id
    JOIN workforce_person db ON db.id = d.declared_by
    LEFT JOIN workforce_person rb ON rb.id = d.restored_by
    LEFT JOIN workforce_person cb ON cb.id = d.closed_by`;

const canManage = (ctx: WorkContext) => ctx.role.capabilities.includes('downtime.manage');
const log = (store: Store, id: string, kind: string, body: string, by: string, at = now()) =>
  store.insert('downtime_log', { id: newId(), downtime_id: id, kind, body, by_id: by, at });
function logged(store: Store, ctx: WorkContext, operation: string, id: string, personId: string | null = null, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'downtime', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const functionsOf = (r: Row) => String(r.functions).split(',').filter((f) => FUNCTIONS[f]);

function checks(store: Store, id: string) {
  return store.all<Row>(
    `SELECT c.id, c.person_id AS personId, p.given_name || ' ' || p.family_name AS patient, c.state, c.outcome, c.note,
            w.display_name AS checkedBy, c.checked_at AS checkedAt,
            (SELECT COUNT(*) FROM clinical_event e WHERE e.downtime_id = c.downtime_id AND e.person_id = c.person_id AND e.state = 'CURRENT') AS entries
       FROM downtime_check c JOIN person p ON p.id = c.person_id LEFT JOIN workforce_person w ON w.id = c.checked_by
      WHERE c.downtime_id = ? ORDER BY c.state = 'TO_CHECK' DESC, p.family_name, p.given_name`, id,
  ).map((c): Row => ({ ...c, outcomeLabel: c.outcome ? CHECK_OUTCOMES[String(c.outcome)] : null }));
}

function shape(store: Store, ctx: WorkContext, r: Row): Record<string, unknown> & { state: unknown; open: number } {
  const fns = functionsOf(r);
  const list = r.state === 'DECLARED' ? [] : checks(store, String(r.id));
  const open = list.filter((c) => c.state === 'TO_CHECK').length;
  const manage = canManage(ctx) && r.serviceId === ctx.serviceId;
  const actions: string[] = [];
  if (manage && r.state === 'DECLARED') actions.push('restore', 'cancel');
  if (manage && r.state === 'RESTORED' && !open) actions.push('close');
  return {
    ...r, state: r.state, stateLabel: STATES[String(r.state)], functions: fns.map((f) => ({ id: f, label: FUNCTIONS[f].label, process: FUNCTIONS[f].process })),
    checks: list, open, canCheck: manage && r.state === 'RESTORED', canEnter: r.state === 'RESTORED' && r.serviceId === ctx.serviceId, actions,
    log: store.all<Row>(
      `SELECT l.kind, l.body, w.display_name AS by, l.at FROM downtime_log l LEFT JOIN workforce_person w ON w.id = l.by_id
        WHERE l.downtime_id = ? ORDER BY l.at, l.rowid`, r.id,
    ).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? l.kind })),
    history: history(store, 'downtime', String(r.id)),
  };
}

// What is down in my service right now, for the banner on every screen.
export function current(store: Store, ctx: WorkContext) {
  return store.all<Row>(`${Q} WHERE d.service_id = ? AND d.state = 'DECLARED'`, ctx.serviceId).map((r) => ({
    id: r.id, startedAt: r.startedAt, functions: functionsOf(r).map((f) => FUNCTIONS[f].label),
  }));
}

export function list(store: Store, ctx: WorkContext) {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const rows = store.all<Row>(`${Q} WHERE d.service_id = ? AND (d.state IN ('DECLARED', 'RESTORED') OR d.closed_at >= ? OR d.declared_at >= ?) ORDER BY d.started_at DESC`, ctx.serviceId, since, since)
    .map((r) => shape(store, ctx, r));
  return {
    canManage: canManage(ctx),
    functions: Object.fromEntries(Object.entries(FUNCTIONS).map(([k, v]) => [k, v.label])),
    startedAgo: STARTED_AGO_MINUTES,
    outcomes: CHECK_OUTCOMES,
    current: rows.filter((r) => r.state === 'DECLARED'),
    reconciling: rows.filter((r) => r.state === 'RESTORED'),
    ended: rows.filter((r) => r.state === 'CLOSED' || r.state === 'CANCELLED'),
  };
}

export function declare(store: Store, ctx: WorkContext, b: { functions?: unknown; reason?: string; startedAgo?: number }) {
  enforce(store, ctx, { op: 'DOWNTIME', serviceId: ctx.serviceId });
  const fns = [...new Set((Array.isArray(b.functions) ? b.functions : []).map(String).filter((f) => FUNCTIONS[f]))];
  if (!fns.length) throw new HttpError(400, 'FUNCTIONS_REQUIRED', 'Choose what is down.');
  const reason = text(b.reason);
  if (reason.length < 5) throw new HttpError(400, 'REASON_REQUIRED', 'Say what has happened, e.g. "Screens frozen on every computer since 02:10".');
  const ago = Number(b.startedAgo ?? 0);
  if (!STARTED_AGO_MINUTES.includes(ago)) throw new HttpError(400, 'STARTED_REQUIRED', 'Choose when it started.');
  if (store.get("SELECT 1 FROM downtime WHERE service_id = ? AND state = 'DECLARED'", ctx.serviceId)) {
    throw new HttpError(409, 'ALREADY_DOWN', `Downtime is already declared for ${ctx.serviceName}. Say it is back up before declaring another.`);
  }
  const id = newId();
  const at = now();
  const startedAt = new Date(Date.now() - ago * 60_000).toISOString();
  const list = fns.map((f) => FUNCTIONS[f].label).join(', ');
  store.tx(() => {
    store.insert('downtime', { id, service_id: ctx.serviceId, functions: fns.join(','), reason, started_at: startedAt, state: 'DECLARED', declared_by: ctx.workerId, declared_at: at });
    recordInitial(store, 'downtime', id, 'DECLARED', who(ctx), reason);
    log(store, id, 'DECLARED', `${list}. ${reason}`, ctx.workerId, at);
    logged(store, ctx, 'DOWNTIME_DECLARE', id, null, list);
  });
  return shape(store, ctx, store.get<Row>(`${Q} WHERE d.id = ?`, id)!);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: { note?: string; checkId?: string; outcome?: string }) {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That downtime is no longer in SHIFT.');
  enforce(store, ctx, { op: 'DOWNTIME', serviceId: String(r.serviceId) });
  const note = text(b.note);
  const at = now();
  const inState = (s: string) => { if (r.state !== s) throw new HttpError(409, 'WRONG_STATE', `This downtime is ${STATES[String(r.state)].toLowerCase()}.`); };
  switch (action) {
    case 'restore': {
      inState('DECLARED');
      store.tx(() => {
        transition(store, 'downtime', id, 'RESTORED', who(ctx), note || 'Back up');
        store.run('UPDATE downtime SET restored_by = ?, restored_at = ?, restore_note = ? WHERE id = ?', ctx.workerId, at, note || null, id);
        // Everyone in the service at any point during the downtime needs checking for paper records.
        const people = store.all<{ p: string }>(
          `SELECT DISTINCT person_id AS p FROM encounter WHERE service_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
          r.serviceId, at, r.startedAt,
        );
        for (const { p } of people) store.insert('downtime_check', { id: newId(), downtime_id: id, person_id: p, state: 'TO_CHECK' });
        log(store, id, 'RESTORED', `${note ? `${note}. ` : ''}${people.length} ${people.length === 1 ? 'person' : 'people'} to check for paper records.`, ctx.workerId, at);
        logged(store, ctx, 'DOWNTIME_RESTORE', id, null, note || undefined);
      });
      break;
    }
    case 'cancel': {
      inState('DECLARED');
      if (note.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Say why, e.g. "Declared in error; only one computer was frozen".');
      store.tx(() => {
        transition(store, 'downtime', id, 'CANCELLED', who(ctx), note);
        store.run('UPDATE downtime SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, id, 'CANCELLED', note, ctx.workerId, at);
        logged(store, ctx, 'DOWNTIME_CANCEL', id, null, note);
      });
      break;
    }
    case 'check': {
      inState('RESTORED');
      const c = store.get<{ id: string; person_id: string; state: string; patient: string }>(
        `SELECT c.id, c.person_id, c.state, p.given_name || ' ' || p.family_name AS patient FROM downtime_check c JOIN person p ON p.id = c.person_id
          WHERE c.id = ? AND c.downtime_id = ?`, text(b.checkId, 64), id,
      );
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'That person is not on this downtime.');
      if (c.state !== 'TO_CHECK') throw new HttpError(409, 'ALREADY_CHECKED', `${c.patient} has already been checked.`);
      const outcome = CHECK_OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose what you found.');
      const entries = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM clinical_event WHERE downtime_id = ? AND person_id = ? AND state = 'CURRENT'", id, c.person_id)?.n ?? 0;
      if (outcome === 'ENTERED' && !entries) throw new HttpError(409, 'NOTHING_ENTERED', `Nothing has been entered from paper for ${c.patient} yet. Enter it first, or choose "Nothing on paper for them".`);
      if (outcome === 'NOTHING' && entries) throw new HttpError(409, 'ENTRIES_EXIST', `${entries} ${entries === 1 ? 'entry has' : 'entries have'} been entered from paper for ${c.patient}.`);
      if (outcome === 'NOTHING' && note.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Say how you know, e.g. "Checked the downtime pack; no sheets for Tom".');
      store.tx(() => {
        store.run('UPDATE downtime_check SET state = ?, outcome = ?, note = ?, checked_by = ?, checked_at = ? WHERE id = ?', 'CHECKED', outcome, note || null, ctx.workerId, at, c.id);
        log(store, id, 'CHECKED', `${c.patient}: ${CHECK_OUTCOMES[outcome].toLowerCase()}${entries ? ` (${entries})` : ''}.${note ? ` ${note}` : ''}`, ctx.workerId, at);
        logged(store, ctx, 'DOWNTIME_CHECK', id, c.person_id, outcome);
      });
      break;
    }
    case 'close': {
      inState('RESTORED');
      const open = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM downtime_check WHERE downtime_id = ? AND state = 'TO_CHECK'", id)?.n ?? 0;
      if (open) throw new HttpError(409, 'CHECKS_OPEN', `${open} ${open === 1 ? 'person still needs' : 'people still need'} checking for paper records.`);
      if (note.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what worked and what to change next time, e.g. "Packs were complete; the results sheet ran out".');
      store.tx(() => {
        transition(store, 'downtime', id, 'CLOSED', who(ctx), note);
        store.run('UPDATE downtime SET closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', ctx.workerId, at, note, id);
        log(store, id, 'CLOSED', note, ctx.workerId, at);
        logged(store, ctx, 'DOWNTIME_CLOSE', id, null, note);
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
  }
  return shape(store, ctx, store.get<Row>(`${Q} WHERE d.id = ?`, id)!);
}

// Called when an entry is made from a paper record: the downtime must be back up in this service,
// and the care must have happened while it was down.
export function backEntry(store: Store, ctx: WorkContext, b: { id?: unknown; paperBy?: unknown; paperRef?: unknown }, effectiveAt: string, from: string | null | undefined) {
  const d = store.get<{ id: string; service_id: string; state: string; started_at: string; restored_at: string }>(
    'SELECT id, service_id, state, started_at, restored_at FROM downtime WHERE id = ?', text(b.id, 64),
  );
  if (!d || d.service_id !== ctx.serviceId) throw new HttpError(404, 'NOT_FOUND', 'That downtime is not in your service.');
  if (d.state !== 'RESTORED') throw new HttpError(409, 'WRONG_STATE', 'Paper records are entered once SHIFT is back up and before the downtime is closed.');
  if (!from) throw new HttpError(400, 'TIME_REQUIRED', 'Set From to when the care happened, as written on the paper.');
  // Paper times are written to the minute, so the window is widened to whole minutes.
  const minute = 60_000;
  const t = Date.parse(effectiveAt);
  const outside = t < Math.floor(Date.parse(d.started_at) / minute) * minute || t > Math.ceil(Date.parse(d.restored_at) / minute) * minute;
  if (outside) throw new HttpError(400, 'OUTSIDE_DOWNTIME', 'The time on the paper must be while SHIFT was down.');
  const paperBy = text(b.paperBy, 120);
  if (paperBy.length < 2) throw new HttpError(400, 'PAPER_BY_REQUIRED', 'Write who wrote it on paper.');
  return { downtime_id: d.id, paper_by: paperBy, paper_ref: text(b.paperRef, 120) || null };
}

