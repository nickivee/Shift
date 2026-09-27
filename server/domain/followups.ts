import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { ROLES } from '../config/workstations.ts';
import { LINKS, TOLD, OUTCOMES } from '../config/followups.ts';
import { newId, now, todayLocal, addDays, HttpError } from '../lib/util.ts';

// Follow-up requirement (Shared Lifecycle Object 284):
//   follow-up required → arrangement responsibility → referral/appointment/task linkage →
//   scheduled → completed → outcome → further follow-up/closure.
// A clinician records what follow-up is needed, by when, and who is responsible: a role in a
// service of this organisation, or an outside provider such as the GP. A service inside SHIFT
// accepts or declines it; for an outside provider, the making service records how they were
// told. The responsible side links it to a referral, appointment, task or letter, schedules it,
// and records that it happened. Either side records the outcome, which closes it or starts a
// further follow-up.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  REQUIRED: 'Waiting for someone to take responsibility', DECLINED: 'Declined', ACCEPTED: 'Responsibility taken', ARRANGED: 'Arranged',
  SCHEDULED: 'Scheduled', COMPLETED: 'Happened; outcome needed', CLOSED: 'Closed', CANCELLED: 'Cancelled', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  REQUIRED: 'Follow-up needed', ACCEPTED: 'Responsibility taken', DECLINED: 'Declined', ARRANGED: 'Arranged', SCHEDULED: 'Scheduled',
  COMPLETED: 'Happened', CLOSED: 'Outcome', FURTHER: 'Further follow-up', CANCELLED: 'Cancelled', ERROR: 'Entered in error',
};
const OPEN = ['REQUIRED', 'DECLINED', 'ACCEPTED', 'ARRANGED', 'SCHEDULED', 'COMPLETED'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-FU-001'];
const roleLabel = (key: string) => ROLES.find((r) => r.roleKey === key)?.label ?? key;

const Q = `
  SELECT f.id, f.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = f.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         f.state, f.what, f.reason, f.due_by AS dueBy, f.previous_id AS previousId,
         f.from_service_id AS fromServiceId, fs.name AS fromService, f.from_role_key AS fromRoleKey, mb.display_name AS madeBy, f.made_by AS madeById, f.made_at AS madeAt,
         f.resp_kind AS respKind, f.to_service_id AS toServiceId, ts.name AS toService, f.to_role_key AS toRoleKey, f.external_name AS externalName,
         ab.display_name AS acceptedBy, f.accepted_at AS acceptedAt, f.told, f.accept_note AS acceptNote,
         f.link_kind AS linkKind, f.link_ref AS linkRef, rb.display_name AS arrangedBy, f.arranged_at AS arrangedAt,
         f.scheduled_for AS scheduledFor, f.scheduled_where AS scheduledWhere,
         cb.display_name AS completedBy, f.completed_at AS completedAt, f.completed_note AS completedNote,
         f.outcome, f.outcome_note AS outcomeNote, xb.display_name AS closedBy, f.closed_at AS closedAt, f.ended_note AS endedNote
    FROM followup f
    JOIN person p ON p.id = f.person_id
    JOIN service fs ON fs.id = f.from_service_id
    LEFT JOIN service ts ON ts.id = f.to_service_id
    JOIN workforce_person mb ON mb.id = f.made_by
    LEFT JOIN workforce_person ab ON ab.id = f.accepted_by
    LEFT JOIN workforce_person rb ON rb.id = f.arranged_by
    LEFT JOIN workforce_person cb ON cb.id = f.completed_by
    LEFT JOIN workforce_person xb ON xb.id = f.closed_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'FOLLOWUP', personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'followup', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addLog = (store: Store, ctx: WorkContext, id: string, kind: string, body: string) =>
  store.insert('followup_log', { id: newId(), followup_id: id, kind, body, by_id: ctx.workerId, at: now() });

// Who can be responsible: roles in services of this organisation that manage follow-ups, or an outside provider.
export function responsibles(store: Store, ctx: WorkContext) {
  const managers = new Set(ROLES.filter((r) => r.capabilities.includes('followup.manage')).map((r) => r.roleKey));
  return store.all<{ serviceId: string; service: string; roleKey: string }>(`SELECT DISTINCT p.service_id AS serviceId, s.name AS service, p.role_key AS roleKey
      FROM position p JOIN service s ON s.id = p.service_id
     WHERE s.organisation_id = ? AND (p.end_date IS NULL OR p.end_date >= ?) ORDER BY s.name, p.role_key`, ctx.organisationId, todayLocal())
    .filter((r) => managers.has(r.roleKey))
    .map((r) => ({ id: `${r.serviceId}|${r.roleKey}`, label: `${roleLabel(r.roleKey)}, ${r.service}` }));
}

const external = (r: Row) => r.respKind === 'EXTERNAL';
// The side that carries the follow-up out: the named service, or the making service for an outside provider.
const responsibleHere = (ctx: WorkContext, r: Row) => (external(r) ? ctx.serviceId === r.fromServiceId : ctx.serviceId === r.toServiceId);
const makerHere = (ctx: WorkContext, r: Row) => ctx.serviceId === r.fromServiceId;

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const actions: string[] = [];
  if (can) {
    const recipient = !external(r) && ctx.serviceId === r.toServiceId && ctx.role.roleKey === r.toRoleKey;
    if (state === 'REQUIRED' && (recipient || (external(r) && makerHere(ctx, r)))) actions.push('accept');
    if (state === 'REQUIRED' && recipient) actions.push('decline');
    if (state === 'ACCEPTED' && responsibleHere(ctx, r)) actions.push('arrange');
    if (['ARRANGED', 'SCHEDULED'].includes(state) && responsibleHere(ctx, r)) actions.push('schedule');
    if (['ARRANGED', 'SCHEDULED'].includes(state) && (responsibleHere(ctx, r) || makerHere(ctx, r))) actions.push('complete');
    if (state === 'COMPLETED' && (responsibleHere(ctx, r) || makerHere(ctx, r))) actions.push('close');
    if (OPEN.includes(state) && state !== 'COMPLETED' && makerHere(ctx, r)) actions.push('cancel');
    if (OPEN.includes(state) && makerHere(ctx, r)) actions.push('error');
  }
  const responsible = external(r) ? String(r.externalName) : `${roleLabel(String(r.toRoleKey))}, ${r.toService}`;
  return {
    ...r, id, state, stateLabel: STATES[state], dueBy: r.dueBy as string | null, scheduledFor: r.scheduledFor as string | null, responsible,
    fromRole: roleLabel(String(r.fromRoleKey)),
    toldLabel: r.told ? TOLD[String(r.told)] ?? String(r.told) : null,
    linkLabel: r.linkKind ? LINKS[String(r.linkKind)] ?? String(r.linkKind) : null,
    outcomeLabel: r.outcome ? OUTCOMES[String(r.outcome)] ?? String(r.outcome) : null,
    overdue: ['REQUIRED', 'DECLINED', 'ACCEPTED', 'ARRANGED'].includes(state) && !!r.dueBy && String(r.dueBy) < todayLocal(),
    mine: responsibleHere(ctx, r), made: makerHere(ctx, r),
    actions,
    log: store.all<Row>(`SELECT l.kind, l.body, w.display_name AS "by", l.at FROM followup_log l JOIN workforce_person w ON w.id = l.by_id
      WHERE l.followup_id = ? ORDER BY l.at, l.rowid`, id).map((l) => ({ ...l, kindLabel: LOG[String(l.kind)] ?? String(l.kind) })),
    history: history(store, 'followup', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE f.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That follow-up is no longer in SHIFT.');
  return r;
};

function insert(store: Store, ctx: WorkContext, x: { personId: string; what: string; reason: string | null; dueBy: string; to: string; externalName: string; previousId: string | null;
  fromServiceId?: string; fromRoleKey?: string }) {
  const id = newId();
  const ext = x.to === 'EXTERNAL';
  const [toService, toRole] = ext ? [null, null] : x.to.split('|');
  store.insert('followup', {
    id, person_id: x.personId, what: x.what, reason: x.reason, due_by: x.dueBy, state: 'REQUIRED', previous_id: x.previousId,
    from_service_id: x.fromServiceId ?? ctx.serviceId, from_role_key: x.fromRoleKey ?? ctx.role.roleKey, made_by: ctx.workerId, made_at: now(),
    resp_kind: ext ? 'EXTERNAL' : 'INTERNAL', to_service_id: toService, to_role_key: toRole, external_name: ext ? x.externalName : null,
  });
  recordInitial(store, 'followup', id, 'REQUIRED', { actorId: ctx.workerId, workContextId: ctx.id }, x.what.slice(0, 200));
  const who = ext ? x.externalName : responsiblesLabel(x.to);
  addLog(store, ctx, id, 'REQUIRED', `${x.what}. By ${x.dueBy}. Responsible: ${who}.${x.reason ? ` Why: ${x.reason}` : ''}`);
  return id;
}
const responsiblesLabel = (to: string) => { const [, role] = to.split('|'); return roleLabel(role); };

export function make(store: Store, ctx: WorkContext, personId: string, b: { what?: string; reason?: string; dueBy?: string; to?: string; externalName?: string }) {
  enforce(store, ctx, { op: 'FOLLOWUP', personId }, personId);
  const what = text(b.what, 300);
  if (what.length < 5) throw new HttpError(400, 'WHAT_REQUIRED', 'Say what follow-up is needed, e.g. "GP to recheck potassium".');
  const dueBy = date(b.dueBy);
  if (!dueBy || dueBy < todayLocal() || dueBy > addDays(todayLocal(), 2 * 365)) throw new HttpError(400, 'DATE', 'Choose when it is needed by, from today to two years ahead.');
  const to = String(b.to ?? '');
  const externalName = text(b.externalName, 200);
  if (to === 'EXTERNAL') { if (externalName.length < 3) throw new HttpError(400, 'EXTERNAL_REQUIRED', 'Name the outside provider, e.g. "Dr Priya Nair, Onehunga Health (GP)".'); }
  else if (!responsibles(store, ctx).some((x) => x.id === to)) throw new HttpError(400, 'RESPONSIBLE_REQUIRED', 'Choose who is responsible.');
  store.tx(() => {
    const id = insert(store, ctx, { personId, what, reason: text(b.reason, 1000) || null, dueBy, to, externalName, previousId: null });
    logged(store, ctx, 'FOLLOWUP_MAKE', personId, id, what.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { note?: string; told?: string; link?: string; ref?: string; when?: string; where?: string; outcome?: string; furtherWhat?: string; furtherDue?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'FOLLOWUP', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This follow-up is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const responsibleOnly = () => { if (!responsibleHere(ctx, r)) throw new HttpError(403, 'BLOCK', `Only ${external(r) ? r.fromService : r.toService} can do that.`); };
  const makerOnly = () => { if (!makerHere(ctx, r)) throw new HttpError(403, 'BLOCK', `Only ${r.fromService}, which asked for it, can do that.`); };
  const eitherSide = () => { if (!responsibleHere(ctx, r) && !makerHere(ctx, r)) throw new HttpError(403, 'BLOCK', 'Only the services involved can do that.'); };
  const step = (to: string, kind: string, body: string, update: [string, ...unknown[]]) => store.tx(() => {
    transition(store, 'followup', id, to, who, body.slice(0, 200));
    store.run(update[0], ...(update.slice(1) as (string | null)[]));
    addLog(store, ctx, id, kind, body);
    logged(store, ctx, `FOLLOWUP_${kind}`, personId, id, body.slice(0, 200));
  });
  switch (action) {
    case 'accept': {
      inState('REQUIRED');
      if (external(r)) {
        makerOnly();
        const told = TOLD[String(b.told)] ? String(b.told) : '';
        if (!told) throw new HttpError(400, 'TOLD_REQUIRED', `Choose how ${r.externalName} was told.`);
        need(5, 'Say who agreed to take it on, e.g. "Practice nurse Sue confirmed Dr Nair will see him".');
        step('ACCEPTED', 'ACCEPTED', `${r.externalName}: ${TOLD[told]}. ${note}`, ['UPDATE followup SET accepted_by = ?, accepted_at = ?, told = ?, accept_note = ? WHERE id = ?', ctx.workerId, at, told, note, id]);
      } else {
        if (!(ctx.serviceId === r.toServiceId && ctx.role.roleKey === r.toRoleKey)) throw new HttpError(403, 'BLOCK', `Only the ${roleLabel(String(r.toRoleKey))} in ${r.toService} can take this on.`);
        step('ACCEPTED', 'ACCEPTED', note || `${r.toService} will arrange it.`, ['UPDATE followup SET accepted_by = ?, accepted_at = ?, accept_note = ? WHERE id = ?', ctx.workerId, at, note || null, id]);
      }
      break;
    }
    case 'decline':
      inState('REQUIRED');
      if (external(r) || !(ctx.serviceId === r.toServiceId && ctx.role.roleKey === r.toRoleKey)) throw new HttpError(403, 'BLOCK', 'Only the service asked can decline it.');
      need(5, 'Say why, and who should do it instead.');
      step('DECLINED', 'DECLINED', note, ['UPDATE followup SET accepted_by = ?, accepted_at = ?, accept_note = ? WHERE id = ?', ctx.workerId, at, note, id]);
      break;
    case 'arrange': {
      inState('ACCEPTED');
      responsibleOnly();
      const link = LINKS[String(b.link)] ? String(b.link) : '';
      if (!link) throw new HttpError(400, 'LINK_REQUIRED', 'Choose how it was arranged.');
      const ref = text(b.ref, 300);
      if (ref.length < 3) throw new HttpError(400, 'REF_REQUIRED', 'Say what was sent or booked, e.g. "eReferral to Cardiology, 25 Sept".');
      step('ARRANGED', 'ARRANGED', `${LINKS[link]}: ${ref}`, ['UPDATE followup SET link_kind = ?, link_ref = ?, arranged_by = ?, arranged_at = ? WHERE id = ?', link, ref, ctx.workerId, at, id]);
      break;
    }
    case 'schedule': {
      inState('ARRANGED', 'SCHEDULED');
      responsibleOnly();
      const when = Date.parse(String(b.when ?? ''));
      if (Number.isNaN(when) || when < Date.now() - 86_400_000 || when > Date.now() + 2 * 365 * 86_400_000) throw new HttpError(400, 'DATE', 'Choose when it is booked for.');
      const where = text(b.where, 200);
      if (where.length < 3) throw new HttpError(400, 'WHERE_REQUIRED', 'Say where, e.g. "Cardiology outpatients, Clinic 4".');
      const iso = new Date(when).toISOString();
      step('SCHEDULED', 'SCHEDULED', `${state === 'SCHEDULED' ? 'Moved. ' : ''}${where}.${note ? ` ${note}` : ''}`,
        ['UPDATE followup SET scheduled_for = ?, scheduled_where = ? WHERE id = ?', iso, where, id]);
      break;
    }
    case 'complete':
      inState('ARRANGED', 'SCHEDULED');
      eitherSide();
      need(5, 'Say what happened, e.g. "Seen in clinic; letter received".');
      step('COMPLETED', 'COMPLETED', note, ['UPDATE followup SET completed_by = ?, completed_at = ?, completed_note = ? WHERE id = ?', ctx.workerId, at, note, id]);
      break;
    case 'close': {
      inState('COMPLETED');
      eitherSide();
      const outcome = OUTCOMES[String(b.outcome)] ? String(b.outcome) : '';
      if (!outcome) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Choose the outcome.');
      if (outcome !== 'RESOLVED') need(5, 'Say what the outcome was.');
      const furtherWhat = text(b.furtherWhat, 300);
      const furtherDue = date(b.furtherDue);
      if (outcome === 'FURTHER' && (furtherWhat.length < 5 || !furtherDue || furtherDue < todayLocal())) throw new HttpError(400, 'FURTHER_REQUIRED', 'Say what further follow-up is needed and by when.');
      store.tx(() => {
        step('CLOSED', 'CLOSED', `${OUTCOMES[outcome]}.${note ? ` ${note}` : ''}`,
          ['UPDATE followup SET outcome = ?, outcome_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', outcome, note || null, ctx.workerId, at, id]);
        if (outcome === 'FURTHER') {
          const to = external(r) ? 'EXTERNAL' : `${r.toServiceId}|${r.toRoleKey}`;
          const next = insert(store, ctx, { personId, what: furtherWhat, reason: `Further follow-up after: ${r.what}`, dueBy: furtherDue, to, externalName: String(r.externalName ?? ''), previousId: id,
            fromServiceId: String(r.fromServiceId), fromRoleKey: String(r.fromRoleKey) });
          store.run('UPDATE followup SET further_id = ? WHERE id = ?', next, id);
          addLog(store, ctx, id, 'FURTHER', `${furtherWhat}, by ${furtherDue}.`);
        }
      });
      break;
    }
    case 'cancel':
    case 'error': {
      if (action === 'cancel') { inState('REQUIRED', 'DECLINED', 'ACCEPTED', 'ARRANGED', 'SCHEDULED'); need(5, 'Say why it is no longer needed.'); }
      else { inState(...OPEN); need(10, 'Write why this was entered in error, e.g. "Recorded on the wrong person".'); }
      makerOnly();
      const to = action === 'cancel' ? 'CANCELLED' : 'ENTERED_IN_ERROR';
      step(to, action === 'cancel' ? 'CANCELLED' : 'ERROR', note, ['UPDATE followup SET ended_note = ?, closed_by = ?, closed_at = ? WHERE id = ?', note, ctx.workerId, at, id]);
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Follow-ups view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE f.person_id = ? ORDER BY f.due_by, f.made_at`, personId).map((r) => shape(store, ctx, r, can));
  return {
    open: all.filter((x) => OPEN.includes(x.state)),
    ended: all.filter((x) => !OPEN.includes(x.state)),
    canMake: can,
    options: { responsibles: can ? responsibles(store, ctx) : [], links: LINKS, told: TOLD, outcomes: OUTCOMES },
  };
}

// Home → Follow-ups for this service.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('followup.manage')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include follow-ups`);
  const rows = store.all<Row>(`${Q} WHERE f.state IN ('REQUIRED', 'DECLINED', 'ACCEPTED', 'ARRANGED', 'SCHEDULED', 'COMPLETED')
      AND (f.from_service_id = ? OR f.to_service_id = ?) ORDER BY f.due_by`, ctx.serviceId, ctx.serviceId).map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_FOLLOWUPS', decision: 'ALLOW', outcome: 'VIEWED' });
  return {
    toTake: rows.filter((r) => r.actions.includes('accept') || (['REQUIRED', 'DECLINED'].includes(r.state) && r.made)),
    toArrange: rows.filter((r) => r.actions.includes('arrange')),
    scheduled: rows.filter((r) => ['ARRANGED', 'SCHEDULED'].includes(r.state)).sort((a, b) => String(a.scheduledFor ?? a.dueBy).localeCompare(String(b.scheduledFor ?? b.dueBy))),
    outcome: rows.filter((r) => r.actions.includes('close')),
  };
}
