import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { evaluate } from './authority.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { recordInitial, transition } from './lifecycle.ts';
import { KEY_BY_CODE, type KeyTemplate } from '../config/keys.ts';
import { fromEntry as problemFromEntry } from './problems.ts';
import { newId, now, HttpError } from '../lib/util.ts';

export interface CommandInput {
  personId: string;
  key?: string;                       // .key being recorded
  fields?: Record<string, unknown>;
  eventId?: string;                   // existing canonical event being routed or handed over
  destinations?: string[];            // +aliases
  handover?: boolean;
  urgent?: boolean;
  from?: string | null;
  to?: string | null;
  idempotencyKey: string;
}

const ROUTE_ENGINES = [1, 5, 13, 264];
const HANDOVER_ENGINES = [16, 219];

interface Destination {
  id: string; alias: string; label: string; service_id: string; role_key: string | null;
  requires_acceptance: number; organisation_id: string;
}

export function destinationsFor(store: Store, ctx: WorkContext) {
  return store.all<{ alias: string; label: string }>(
    'SELECT alias, label FROM destination WHERE organisation_id = ? AND active = 1 ORDER BY alias', ctx.organisationId,
  );
}

function resolveDestination(store: Store, ctx: WorkContext, alias: string): Destination {
  const a = alias.replace(/^\+/, '').toLowerCase();
  const d = store.get<Destination>(
    `SELECT d.id, d.alias, d.label, d.service_id, d.role_key, d.requires_acceptance, s.organisation_id
       FROM destination d JOIN service s ON s.id = d.service_id
      WHERE d.organisation_id = ? AND d.alias = ? AND d.active = 1`,
    ctx.organisationId, a,
  );
  if (!d) throw new HttpError(400, 'UNKNOWN_DESTINATION', `+${a} is not a registered destination in ${ctx.organisationName}.`);
  return d;
}

// Validate only what the worker entered. Blank fields are dropped, never defaulted.
export function cleanFields(t: KeyTemplate, input: Record<string, unknown> = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const problems: string[] = [];
  for (const f of t.fields) {
    const raw = input[f.id];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const s = String(raw).trim();
    if (f.type === 'number') {
      const n = Number(s);
      if (!Number.isFinite(n)) problems.push(`${f.label} must be a number`);
      else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) problems.push(`${f.label} ${s} is outside the possible range`);
      else out[f.id] = n;
    } else if (f.type === 'bp') {
      const m = /^(\d{2,3})\s*\/\s*(\d{2,3})$/.exec(s);
      if (!m || Number(m[1]) <= Number(m[2])) problems.push('BP must be systolic/diastolic, e.g. 128/76');
      else out[f.id] = `${Number(m[1])}/${Number(m[2])}`;
    } else if (f.type === 'choice') {
      const match = f.options!.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!match) problems.push(`${f.label} must be one of ${f.options!.join(', ')}`);
      else out[f.id] = match;
    } else {
      out[f.id] = s.slice(0, f.type === 'longtext' ? 8000 : 500);
    }
  }
  if (problems.length) throw new HttpError(400, 'INVALID_ENTRY', problems.join('. ') + '.');
  if (!Object.keys(out).length) throw new HttpError(400, 'EMPTY_ENTRY', 'Nothing was entered, so nothing was recorded.');
  return out;
}

export function render(t: KeyTemplate, fields: Record<string, string | number>): string {
  if (t.fields.length === 1 && t.fields[0].type === 'longtext') return String(fields[t.fields[0].id]);
  return t.fields
    .filter((f) => fields[f.id] !== undefined)
    .map((f) => {
      const v = fields[f.id];
      if (!f.unit) return `${f.label} ${v}`;
      return f.unit === '%' || f.unit === '°C' || f.unit.startsWith('/') ? `${f.label} ${v}${f.unit}` : `${f.label} ${v} ${f.unit}`;
    })
    .join(' · ');
}

function validPeriod(from?: string | null, to?: string | null): { start: string; end: string | null } {
  const at = now();
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if ((from && Number.isNaN(start!.getTime())) || (to && Number.isNaN(end!.getTime()))) throw new HttpError(400, 'INVALID_PERIOD', 'From/To must be valid times.');
  if (start && start.getTime() > Date.now() + 5 * 60 * 1000) throw new HttpError(400, 'INVALID_PERIOD', 'From cannot be in the future.');
  if (start && end && end < start) throw new HttpError(400, 'INVALID_PERIOD', 'To must be after From.');
  return { start: start ? start.toISOString() : at, end: end ? end.toISOString() : null };
}

// One enter-once transaction: the canonical event, its routes and its handover mark commit
// together or not at all. A retried request with the same idempotency key returns the
// original result and creates nothing new.
export function execute(store: Store, ctx: WorkContext, input: CommandInput) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 100) throw new HttpError(400, 'IDEMPOTENCY_KEY', 'Missing request key.');
  const prior = store.get<{ result_json: string }>(
    'SELECT result_json FROM command_transaction WHERE actor_id = ? AND idempotency_key = ?', ctx.workerId, input.idempotencyKey,
  );
  if (prior) return { ...JSON.parse(prior.result_json), replayed: true };

  const person = store.get<{ id: string }>('SELECT id FROM person WHERE id = ?', input.personId);
  if (!person) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  const dests = [...new Set((input.destinations ?? []).map((d) => d.replace(/^\+/, '').toLowerCase()))].map((a) => resolveDestination(store, ctx, a));

  const template = input.key ? KEY_BY_CODE.get(input.key) : undefined;
  if (input.key && !template) throw new HttpError(400, 'UNKNOWN_KEY', `${input.key} is not a SHIFT .key.`);
  if (!template && !input.eventId) throw new HttpError(400, 'NOTHING_TO_DO', 'Enter a .key, or choose an entry to route.');

  // Authority for every part is decided before anything is written.
  if (template) enforce(store, ctx, { op: 'CREATE', personId: person.id, key: template.code }, person.id);
  else enforce(store, ctx, { op: 'VIEW_RECORD', personId: person.id }, person.id);
  if (!template?.createsTask) for (const d of dests) enforce(store, ctx, { op: 'ROUTE', personId: person.id, destinationOrgId: d.organisation_id }, person.id);
  if (input.handover) enforce(store, ctx, { op: 'HANDOVER', personId: person.id }, person.id);
  if (template?.createsTask && dests.length > 1) throw new HttpError(400, 'ONE_ASSIGNEE', 'A task goes to one destination.');

  const txId = newId();
  const engines = new Set<number>([5, 6, 26]);
  const actor = { actorId: ctx.workerId, workContextId: ctx.id, transactionId: txId };
  const auditBase = { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK' as const, subjectPersonId: person.id, purpose: 'DIRECT_CARE', decision: 'ALLOW', outcome: 'COMMITTED' as const, transactionId: txId };

  return store.tx(() => {
    const result: { transactionId: string; eventId?: string; taskId?: string; routes: { id: string; destination: string; state: string }[]; handover: boolean; engines: number[] } = {
      transactionId: txId, routes: [], handover: false, engines: [],
    };
    let event: { id: string; lineage_id: string } | undefined;

    if (template?.createsTask) {
      const fields = cleanFields(template, input.fields);
      if (!fields.task) throw new HttpError(400, 'INVALID_ENTRY', 'Say what the task is.');
      const d = dests[0];
      if (d) enforce(store, ctx, { op: 'ROUTE', personId: person.id, destinationOrgId: d.organisation_id }, person.id);
      const id = newId();
      const serviceId = d?.service_id ?? ctx.serviceId;
      store.insert('task', {
        id, person_id: person.id, source_event_id: input.eventId ?? null, description: String(fields.task), due_at: fields.due ? String(fields.due) : null,
        service_id: serviceId, assigned_to: d?.role_key ? `role:${d.role_key}` : null, state: 'CREATED', created_by: ctx.workerId, created_at: now(), transaction_id: txId,
      });
      recordInitial(store, 'task', id, 'CREATED', actor);
      if (d?.role_key) transition(store, 'task', id, 'ASSIGNED', actor, `Assigned to ${d.label}`);
      template.engines.forEach((e) => engines.add(e));
      audit(store, { ...auditBase, operation: 'CREATE_TASK', objectType: 'task', objectId: id, ruleRefs: ['ORG-SYN-001 v1'], engines: template.engines });
      result.taskId = id;
    } else if (template) {
      const fields = cleanFields(template, input.fields);
      const period = validPeriod(input.from, input.to);
      const id = newId();
      store.insert('clinical_event', {
        id, lineage_id: id, version: 1, person_id: person.id,
        encounter_id: store.get<{ id: string }>("SELECT id FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", person.id, ctx.serviceId)?.id ?? null,
        category: template.category, key_code: template.code, key_version: template.version, fields_json: JSON.stringify(fields),
        rendered_text: render(template, fields), author_id: ctx.workerId, author_position_id: ctx.positionId,
        author_role_label: `${ctx.role.label}, ${ctx.serviceName}`, service_id: ctx.serviceId, recorded_at: now(),
        effective_at: period.start, effective_end: period.end, state: 'CURRENT', urgent: Boolean(input.urgent),
        collection: 'DIRECT', data_source: 'SHIFT', transaction_id: txId,
      });
      template.engines.forEach((e) => engines.add(e));
      audit(store, { ...auditBase, operation: 'CREATE_EVENT', objectType: 'clinical_event', objectId: id, reason: template.code, ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002'], engines: template.engines });
      // A .problem entry keeps the problem list (Object 273) in step.
      if (template.code === '.problem') problemFromEntry(store, ctx, person.id, fields, id);
      event = { id, lineage_id: id };
      result.eventId = id;
    } else {
      event = store.get<{ id: string; lineage_id: string }>(
        "SELECT id, lineage_id FROM clinical_event WHERE id = ? AND person_id = ? AND state = 'CURRENT'", input.eventId, person.id,
      );
      if (!event) throw new HttpError(409, 'NOT_CURRENT', 'Only the current version of an entry can be routed or handed over.');
      result.eventId = event.id;
    }

    if (event) {
      for (const d of dests) {
        const rid = newId();
        store.insert('route', {
          id: rid, source_event_id: event.id, source_lineage_id: event.lineage_id, person_id: person.id, destination_id: d.id,
          purpose: 'DIRECT_CARE', actor_id: ctx.workerId, actor_position_id: ctx.positionId, state: 'SENT',
          requires_acceptance: d.requires_acceptance, created_at: now(), transaction_id: txId,
        });
        recordInitial(store, 'route', rid, 'SENT', actor);
        // The destination is registered and its queue exists, so the system records
        // delivery. Receipt, review and acceptance remain separate human acts.
        transition(store, 'route', rid, 'DELIVERED', { ...actor, actorId: null }, 'Available at destination queue');
        ROUTE_ENGINES.forEach((e) => engines.add(e));
        audit(store, { ...auditBase, operation: 'ROUTE', objectType: 'route', objectId: rid, reason: `To ${d.label}`, ruleRefs: ['ORG-SYN-001 v1', 'LAW-NZ-002'], engines: ROUTE_ENGINES });
        result.routes.push({ id: rid, destination: d.label, state: 'DELIVERED' });
      }
      if (input.handover) {
        const existing = store.get('SELECT 1 FROM handover_mark WHERE event_lineage_id = ? AND service_id = ? AND cleared_at IS NULL', event.lineage_id, ctx.serviceId);
        if (!existing) {
          const mid = newId();
          store.insert('handover_mark', { id: mid, event_lineage_id: event.lineage_id, person_id: person.id, service_id: ctx.serviceId, marked_by: ctx.workerId, marked_at: now() });
          audit(store, { ...auditBase, operation: 'HANDOVER_MARK', objectType: 'handover_mark', objectId: mid, ruleRefs: ['ORG-SYN-001 v1'], engines: HANDOVER_ENGINES });
        }
        HANDOVER_ENGINES.forEach((e) => engines.add(e));
        result.handover = true;
      }
    }

    result.engines = [...engines].sort((a, b) => a - b);
    store.insert('command_transaction', {
      id: txId, idempotency_key: input.idempotencyKey, actor_id: ctx.workerId,
      command: [input.key, input.eventId ? `#${input.eventId}` : null, ...dests.map((d) => `+${d.alias}`), input.handover ? 'handover' : null, input.urgent ? 'urgent' : null].filter(Boolean).join(' '),
      engines: result.engines.join(','), created_at: now(), result_json: JSON.stringify(result),
    });
    return result;
  });
}

// Amendment keeps the original: a new version supersedes it. Entered-in-error keeps the
// entry visible in history with its state changed.
export function amend(store: Store, ctx: WorkContext, eventId: string, body: { fields?: Record<string, unknown>; reason?: string; enteredInError?: boolean }) {
  const e = store.get<Record<string, string | number | null>>('SELECT * FROM clinical_event WHERE id = ?', eventId);
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Entry not found.');
  enforce(store, ctx, { op: 'AMEND', personId: String(e.person_id), authorId: e.author_id as string | null }, String(e.person_id));
  if (e.state !== 'CURRENT') throw new HttpError(409, 'NOT_CURRENT', 'Only the current version can be amended.');
  const reason = (body.reason ?? '').trim();
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Give a reason for the change.');
  const txId = newId();
  return store.tx(() => {
    if (body.enteredInError) {
      store.run("UPDATE clinical_event SET state = 'ENTERED_IN_ERROR', amendment_reason = ? WHERE id = ?", reason, eventId);
      store.run('UPDATE handover_mark SET cleared_by = ?, cleared_at = ? WHERE event_lineage_id = ? AND cleared_at IS NULL', ctx.workerId, now(), e.lineage_id);
      audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: String(e.person_id), operation: 'ENTERED_IN_ERROR', objectType: 'clinical_event', objectId: eventId, decision: 'ALLOW', outcome: 'COMMITTED', reason, engines: [230], transactionId: txId });
      return { eventId, state: 'ENTERED_IN_ERROR' };
    }
    const t = KEY_BY_CODE.get(String(e.key_code));
    if (!t) throw new HttpError(409, 'NOT_AMENDABLE', 'This entry was not made with a .key and cannot be amended here.');
    const fields = cleanFields(t, body.fields);
    const id = newId();
    store.run("UPDATE clinical_event SET state = 'SUPERSEDED' WHERE id = ?", eventId);
    store.insert('clinical_event', {
      ...e, id, version: Number(e.version) + 1, fields_json: JSON.stringify(fields), rendered_text: render(t, fields),
      author_id: ctx.workerId, author_position_id: ctx.positionId, author_role_label: `${ctx.role.label}, ${ctx.serviceName}`,
      recorded_at: now(), state: 'CURRENT', supersedes_id: eventId, amendment_reason: reason, transaction_id: txId,
    });
    audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: String(e.person_id), operation: 'AMEND', objectType: 'clinical_event', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, engines: [230, 271], transactionId: txId });
    return { eventId: id, supersedes: eventId, state: 'CURRENT' };
  });
}

export function capabilitiesSummary(store: Store, ctx: WorkContext) {
  return {
    prescribe: evaluate(store, ctx, { op: 'PRESCRIBE' }),
    earlyWarning: evaluate(store, ctx, { op: 'EARLY_WARNING_SCORE' }),
  };
}
