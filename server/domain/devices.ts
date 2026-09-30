import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { KINDS, SITE, CONFIRM, REMOVED, STATES, REFS } from '../config/devices.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Lines, tubes and catheters (entries 186, 187; Shared Lifecycle Object 214):
//   inserted (here or before they came) → position confirmed before use where the kind needs it
//   → site checked by a set time → still needed? → problem found → removed, and whether it came
//   out whole.
// Nurses and doctors record and check them. Caregivers, who see catheters and feeding tubes all
// day, report a problem, which becomes a task for the nurse. Which kinds need a position check
// and how often each is checked are organisational settings (ORG-SYN-001); national requirements
// are RR-DEVICE-001.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const hoursFrom = (h: number, from = Date.now()) => new Date(from + h * 3600_000).toISOString();
const EARLIER = [0, 1, 4, 12, 24, 48, 72];

const may = (store: Store, ctx: WorkContext, personId: string, op: 'DEVICE' | 'DEVICE_REPORT') =>
  evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'device', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS,
  });
}
const note = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('device_log', { id: newId(), device_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT d.id, d.person_id AS personId, d.kind, d.site, d.size, d.reason, d.state, d.inserted_at AS insertedAt, d.inserted_where AS insertedWhere,
         ib.display_name AS insertedBy, cb.display_name AS confirmedBy, d.confirmed_at AS confirmedAt, d.confirm_how AS confirmHow,
         d.check_due AS checkDue, d.last_check_at AS lastCheckAt, d.last_site AS lastSite, d.needed_at AS neededAt, d.needed_why AS neededWhy,
         rb.display_name AS removedBy, d.removed_at AS removedAt, d.remove_reason AS removeReason, d.intact, d.remove_note AS removeNote
    FROM device d
    JOIN workforce_person ib ON ib.id = d.inserted_by
    LEFT JOIN workforce_person cb ON cb.id = d.confirmed_by
    LEFT JOIN workforce_person rb ON rb.id = d.removed_by`;

const days = (from: unknown) => Math.max(1, Math.floor((Date.now() - Date.parse(String(from))) / 86_400_000) + 1);
const label = (r: Row) => `${KINDS[String(r.kind)].short}${r.site ? `, ${r.site}` : ''}`;

function shape(store: Store, r: Row, manage: boolean, report: boolean) {
  const state = String(r.state);
  const k = KINDS[String(r.kind)];
  const actions: string[] = [];
  if (state !== 'REMOVED') {
    if (manage) {
      if (state === 'NEEDS_CHECK') actions.push('confirm');
      else actions.push('check', 'needed');
      actions.push('remove');
    } else if (report) actions.push('report');
  }
  return {
    ...r, state, stateLabel: STATES[state], kindLabel: k.label, short: label(r), line: k.line,
    day: state !== 'REMOVED' ? days(r.insertedAt) : null,
    overdue: state === 'IN_PLACE' && !!r.checkDue && String(r.checkDue) < now(),
    siteLabel: r.lastSite ? SITE[String(r.lastSite)] : null, problem: !!r.lastSite && r.lastSite !== 'OK',
    confirmLabel: r.confirmHow ? CONFIRM[String(r.confirmHow)] : null, removeLabel: r.removeReason ? REMOVED[String(r.removeReason)] : null,
    actions,
    log: store.all<Row>('SELECT l.kind, l.body, w.display_name AS "by", l.at FROM device_log l JOIN workforce_person w ON w.id = l.by_id WHERE l.device_id = ? ORDER BY l.at, l.rowid', String(r.id)),
  };
}

export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const manage = may(store, ctx, personId, 'DEVICE');
  const report = manage || may(store, ctx, personId, 'DEVICE_REPORT');
  const all = store.all<Row>(`${Q} WHERE d.person_id = ? ORDER BY d.inserted_at DESC`, personId).map((r) => shape(store, r, manage, report));
  return {
    devices: all.filter((d) => d.state !== 'REMOVED'),
    removed: all.filter((d) => d.state === 'REMOVED'),
    canInsert: manage,
    options: {
      kinds: Object.fromEntries(Object.entries(KINDS).map(([id, k]) => [id, { label: k.label, position: k.position, line: k.line, checkHours: k.checkHours }])),
      site: SITE, confirm: CONFIRM, removed: REMOVED, earlier: EARLIER,
    },
  };
}

// For the record header, for everyone who opens it.
export function current(store: Store, personId: string) {
  const rows = store.all<Row>(`${Q} WHERE d.person_id = ? AND d.state != 'REMOVED' ORDER BY d.inserted_at`, personId);
  if (!rows.length) return null;
  return rows.map((r) => ({
    short: label(r), day: days(r.insertedAt), needsCheck: r.state === 'NEEDS_CHECK',
    overdue: r.state === 'IN_PLACE' && !!r.checkDue && String(r.checkDue) < now(), problem: !!r.lastSite && r.lastSite !== 'OK',
  }));
}

interface Body {
  kind?: string; site?: string; size?: string; reason?: string; hoursAgo?: unknown; where?: string;
  how?: string; note?: string; siteLook?: string; needed?: string; reasonRemoved?: string; intact?: string;
}

export function insert(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'DEVICE', personId }, personId);
  const kind = pick(KINDS, b.kind);
  if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what kind of line or tube it is.');
  const k = KINDS[kind];
  const site = text(b.site, 80);
  if (site.length < 3 && !['IDC', 'NGT'].includes(kind)) throw new HttpError(400, 'SITE_REQUIRED', 'Write where it is, e.g. "Left forearm" or "Right chest".');
  const reason = text(b.reason, 300);
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Write why it is needed, e.g. "IV antibiotics".');
  const hoursAgo = Number(b.hoursAgo ?? 0);
  if (!EARLIER.includes(hoursAgo)) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose when it went in.');
  const where = text(b.where, 120);
  if (hoursAgo > 0 && where.length < 2) throw new HttpError(400, 'WHERE_REQUIRED', 'Write where it went in, e.g. "Emergency department" or "Before admission".');
  const at = hoursFrom(-hoursAgo);
  const state = k.position ? 'NEEDS_CHECK' : 'IN_PLACE';
  const id = newId();
  const size = text(b.size, 30) || null;
  const say = `${k.label}${site ? `, ${site}` : ''}${size ? ` (${size})` : ''}. For: ${reason}.${where ? ` Put in: ${where}.` : ''}`;
  store.tx(() => {
    store.insert('device', {
      id, person_id: personId, service_id: ctx.serviceId, kind, site: site || null, size, reason, state,
      inserted_by: ctx.workerId, inserted_at: at, inserted_where: where || null,
      check_due: k.position ? null : hoursFrom(k.checkHours), recorded_at: now(),
    });
    recordInitial(store, 'device', id, state, { actorId: ctx.workerId, workContextId: ctx.id }, say);
    note(store, id, 'INSERTED', `${say}${k.position ? ' Position to be confirmed before use.' : ''}${b.note ? ` ${sentence(text(b.note))}` : ''}`, ctx.workerId);
    logged(store, ctx, 'DEVICE_INSERT', personId, id, say);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE d.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That line or tube is no longer in SHIFT.');
  const personId = String(r.personId);
  enforce(store, ctx, { op: action === 'report' ? 'DEVICE_REPORT' : 'DEVICE', personId }, personId);
  const state = String(r.state);
  if (state === 'REMOVED') throw new HttpError(409, 'REMOVED', 'It has already been removed.');
  const k = KINDS[String(r.kind)];
  const say = text(b.note);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  store.tx(() => {
    switch (action) {
      case 'confirm': {
        if (state !== 'NEEDS_CHECK') throw new HttpError(409, 'STATE', 'Its position is already confirmed.');
        const how = pick(CONFIRM, b.how);
        if (!how) throw new HttpError(400, 'HOW_REQUIRED', 'Choose how the position was confirmed.');
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what was seen, e.g. "Tip in the lower SVC on the chest X-ray" or "pH 4".');
        transition(store, 'device', id, 'IN_PLACE', who, 'Position confirmed');
        store.run('UPDATE device SET confirmed_by = ?, confirmed_at = ?, confirm_how = ?, check_due = ? WHERE id = ?', ctx.workerId, now(), how, hoursFrom(k.checkHours), id);
        note(store, id, 'CONFIRMED', `Position confirmed: ${CONFIRM[how]}. ${sentence(say)} Safe to use.`, ctx.workerId);
        logged(store, ctx, 'DEVICE_CONFIRM', personId, id, CONFIRM[how]);
        break;
      }
      case 'check': {
        if (state !== 'IN_PLACE') throw new HttpError(409, 'STATE', 'Confirm its position first.');
        const look = pick(SITE, b.siteLook);
        if (!look) throw new HttpError(400, 'SITE_REQUIRED', 'Choose how the site looks.');
        if (look !== 'OK' && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you found and who you told, e.g. "Red 2 cm around the site; told Dr Li".');
        store.run('UPDATE device SET last_check_at = ?, last_site = ?, check_due = ? WHERE id = ?', now(), look, hoursFrom(k.checkHours), id);
        note(store, id, look === 'OK' ? 'CHECKED' : 'PROBLEM', `${SITE[look]}.${say ? ` ${sentence(say)}` : ''}`, ctx.workerId);
        logged(store, ctx, look === 'OK' ? 'DEVICE_CHECK' : 'DEVICE_PROBLEM', personId, id, SITE[look]);
        break;
      }
      case 'needed': {
        if (state !== 'IN_PLACE') throw new HttpError(409, 'STATE', 'Confirm its position first.');
        if (b.needed !== 'yes') throw new HttpError(400, 'USE_REMOVE', 'If it is no longer needed, remove it.');
        if (say.length < 3) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is still needed, e.g. "IV antibiotics until Friday".');
        store.run('UPDATE device SET needed_at = ?, needed_why = ? WHERE id = ?', now(), say, id);
        note(store, id, 'NEEDED', `Still needed: ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'DEVICE_NEEDED', personId, id, 'Still needed');
        break;
      }
      case 'remove': {
        const reason = pick(REMOVED, b.reasonRemoved);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Choose why it came out.');
        const intact = b.intact === 'yes' ? 1 : b.intact === 'no' ? 0 : null;
        if (k.line && reason !== 'ERROR' && reason !== 'LEFT' && intact === null) throw new HttpError(400, 'INTACT_REQUIRED', 'Say whether it came out whole.');
        if ((intact === 0 || reason === 'PROBLEM' || reason === 'CAME_OUT') && say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what happened and who you told.');
        transition(store, 'device', id, 'REMOVED', who, REMOVED[reason]);
        store.run('UPDATE device SET removed_by = ?, removed_at = ?, remove_reason = ?, intact = ?, remove_note = ? WHERE id = ?', ctx.workerId, now(), reason, intact, say || null, id);
        note(store, id, 'REMOVED', `${REMOVED[reason]}.${intact === 1 ? ' Came out whole.' : intact === 0 ? ' Did not come out whole.' : ''}${say ? ` ${sentence(say)}` : ''} In for ${days(r.insertedAt)} day${days(r.insertedAt) === 1 ? '' : 's'}.`, ctx.workerId);
        logged(store, ctx, 'DEVICE_REMOVE', personId, id, REMOVED[reason]);
        break;
      }
      case 'report': {
        if (say.length < 10) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what you saw, e.g. "Catheter bag empty all morning and her tummy is sore".');
        note(store, id, 'REPORTED', say, ctx.workerId);
        const taskId = newId();
        store.insert('task', {
          id: taskId, person_id: personId, source_event_id: null, service_id: ctx.serviceId, assigned_to: null, state: 'CREATED', created_by: ctx.workerId, created_at: now(), due_at: null,
          description: `Check their ${k.short.toLowerCase()}: ${say}`,
        });
        recordInitial(store, 'task', taskId, 'CREATED', who, 'Problem with a line or tube reported');
        logged(store, ctx, 'DEVICE_REPORT', personId, id, 'Problem reported');
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
