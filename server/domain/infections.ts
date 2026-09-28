import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial, history } from './lifecycle.ts';
import { SITES, ENTRY_KINDS, RESISTANCE, SUSCEPTIBILITY, RESPONSES, SOURCE_STATUS } from '../config/infections.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Infection Episode (Shared Lifecycle Object 289):
//   suspected infection → evidence → site/source → organism where identified →
//   susceptibility/resistance evidence → treatment → response → source control → complications →
//   resolved/ongoing/recurrence.
// Anyone caring for the person can raise a suspected infection and add what is found as it comes:
// evidence, the organism, its sensitivities and any resistance flag, treatment, how they respond,
// source control (a drain, removing a line) and complications. A doctor, or a rest home nurse
// recording the GP's diagnosis, confirms it with its source or rules it out, and later records it
// resolved or ongoing. A resolved infection that comes back is raised again, linked to the last.

type Row = Record<string, string | number | null>;
const STATES: Record<string, string> = {
  SUSPECTED: 'Suspected', CONFIRMED: 'Confirmed', NOT_INFECTION: 'Not an infection', ONGOING: 'Ongoing', RESOLVED: 'Resolved',
  RECURRED: 'Resolved, then came back', ENTERED_IN_ERROR: 'Entered in error',
};
const LOG: Record<string, string> = {
  ...ENTRY_KINDS, RAISED: 'Suspected', CONFIRMED: 'Confirmed', RULED_OUT: 'Ruled out', ONGOING: 'Ongoing', RESOLVED: 'Resolved',
  RECURRED: 'Came back', ERROR: 'Entered in error',
};
const ACTIVE = ['SUSPECTED', 'CONFIRMED', 'ONGOING'];
const REFS = ['ORG-SYN-001 v1', 'LAW-NZ-002', 'LAW-NZ-005', 'RR-INF-001'];

const Q = `
  SELECT i.id, i.person_id AS personId, p.given_name || ' ' || p.family_name AS patient,
         (SELECT location FROM encounter e WHERE e.person_id = i.person_id AND e.state = 'ACTIVE' ORDER BY e.started_at DESC LIMIT 1) AS location,
         i.service_id AS serviceId, s.name AS service, i.site, i.site_detail AS siteDetail, i.suspicion, i.state, i.previous_id AS previousId,
         rb.display_name AS raisedBy, i.raised_by AS raisedById, i.raised_at AS raisedAt,
         i.source, cb.display_name AS confirmedBy, i.confirmed_at AS confirmedAt, i.confirm_note AS confirmNote,
         eb.display_name AS endedBy, i.ended_at AS endedAt, i.outcome_note AS outcomeNote
    FROM infection i
    JOIN person p ON p.id = i.person_id
    JOIN service s ON s.id = i.service_id
    JOIN workforce_person rb ON rb.id = i.raised_by
    LEFT JOIN workforce_person cb ON cb.id = i.confirmed_by
    LEFT JOIN workforce_person eb ON eb.id = i.ended_by`;

const text = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const may = (store: Store, ctx: WorkContext, personId: string) => evaluate(store, ctx, { op: 'INFECTION', personId }).decision === 'ALLOW';
const confirmer = (ctx: WorkContext) => ctx.role.capabilities.includes('infection.confirm');

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason?: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'infection', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason, ruleRefs: REFS,
  });
}
const addEntry = (store: Store, ctx: WorkContext, id: string, kind: string, what: string, value: string | null = null, refId: string | null = null) =>
  store.insert('infection_entry', { id: newId(), infection_id: id, kind, what, value, ref_id: refId, by_id: ctx.workerId, at: now() });

function entries(store: Store, id: string) {
  return store.all<Row>(`SELECT x.id, x.kind, x.what, x.value, x.ref_id AS refId, w.display_name AS "by", x.at FROM infection_entry x
      JOIN workforce_person w ON w.id = x.by_id WHERE x.infection_id = ? ORDER BY x.at, x.rowid`, id)
    .map((x) => {
      const v = x.value ? String(x.value) : null;
      const valueLabel = !v ? null : x.kind === 'ORGANISM' ? RESISTANCE[v] : x.kind === 'SUSCEPTIBILITY' ? SUSCEPTIBILITY[v] : x.kind === 'RESPONSE' ? RESPONSES[v]
        : x.kind === 'SOURCE_CONTROL' ? SOURCE_STATUS[v] : null;
      return { ...x, id: String(x.id), refId: x.refId as string | null, what: String(x.what), kind: String(x.kind), kindLabel: LOG[String(x.kind)] ?? String(x.kind), value: v, valueLabel: valueLabel ?? v };
    });
}

// Resistant organisms recorded in any real episode for this person (for the record's header).
export function current(store: Store, personId: string) {
  return store.all<{ what: string; value: string; site: string }>(`SELECT x.what, x.value, i.site FROM infection_entry x JOIN infection i ON i.id = x.infection_id
      WHERE i.person_id = ? AND x.kind = 'ORGANISM' AND x.value IS NOT NULL AND x.value <> 'NONE' AND i.state NOT IN ('ENTERED_IN_ERROR', 'NOT_INFECTION')
      ORDER BY x.at DESC`, personId)
    .map((x) => `${RESISTANCE[x.value] ?? x.value} in ${SITES[x.site]?.toLowerCase() ?? x.site}: ${x.what}`);
}

function shape(store: Store, ctx: WorkContext, r: Row, can: boolean) {
  const id = String(r.id);
  const state = String(r.state);
  const all = entries(store, id);
  const openSource = all.filter((x) => x.kind === 'SOURCE_CONTROL' && x.value === 'PLANNED' && !all.some((y) => y.refId === x.id));
  const organisms = all.filter((x) => x.kind === 'ORGANISM');
  const last = (k: string) => [...all].reverse().find((x) => x.kind === k) ?? null;
  const actions: string[] = [];
  if (can && ctx.serviceId === r.serviceId) {
    if (ACTIVE.includes(state)) actions.push('add');
    if (state === 'SUSPECTED' && confirmer(ctx)) actions.push('confirm', 'ruleout');
    if (state === 'CONFIRMED' && confirmer(ctx)) actions.push('ongoing');
    if ((state === 'CONFIRMED' || state === 'ONGOING') && confirmer(ctx)) actions.push('resolve');
    if (state === 'RESOLVED') actions.push('recur');
    if (ACTIVE.includes(state) && (confirmer(ctx) || r.raisedById === ctx.workerId)) actions.push('error');
  }
  return {
    ...r, id, state, stateLabel: STATES[state], siteLabel: SITES[String(r.site)] ?? String(r.site),
    evidence: all.filter((x) => x.kind === 'EVIDENCE'),
    organisms,
    resistant: organisms.filter((x) => x.value && x.value !== 'NONE').map((x) => x.valueLabel),
    sensitivities: all.filter((x) => x.kind === 'SUSCEPTIBILITY'),
    treatments: all.filter((x) => x.kind === 'TREATMENT'),
    response: last('RESPONSE'),
    sourceControl: all.filter((x) => x.kind === 'SOURCE_CONTROL' && !x.refId).map((x) => ({ ...x, done: x.value === 'DONE' || all.some((y) => y.refId === x.id) })),
    openSource,
    complications: all.filter((x) => x.kind === 'COMPLICATION'),
    worse: last('RESPONSE')?.value === 'WORSE',
    actions,
    log: all,
    history: history(store, 'infection', id),
  };
}

const load = (store: Store, id: string) => {
  const r = store.get<Row>(`${Q} WHERE i.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That infection episode is no longer in SHIFT.');
  return r;
};

function create(store: Store, ctx: WorkContext, personId: string, site: string, siteDetail: string | null, suspicion: string, previousId: string | null) {
  const id = newId();
  store.insert('infection', {
    id, person_id: personId, service_id: ctx.serviceId, site, site_detail: siteDetail, suspicion, state: 'SUSPECTED', previous_id: previousId,
    raised_by: ctx.workerId, raised_at: now(),
  });
  recordInitial(store, 'infection', id, 'SUSPECTED', { actorId: ctx.workerId, workContextId: ctx.id }, suspicion.slice(0, 200));
  addEntry(store, ctx, id, 'RAISED', `${SITES[site]}${siteDetail ? ` (${siteDetail})` : ''}. ${suspicion}${previousId ? ' Came back after the last episode resolved.' : ''}`);
  return id;
}

export function raise(store: Store, ctx: WorkContext, personId: string, b: { site?: string; siteDetail?: string; suspicion?: string }) {
  enforce(store, ctx, { op: 'INFECTION', personId }, personId);
  const site = SITES[String(b.site)] ? String(b.site) : '';
  if (!site) throw new HttpError(400, 'SITE_REQUIRED', 'Choose where the infection seems to be.');
  const suspicion = text(b.suspicion, 1000);
  if (suspicion.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Say why you suspect an infection, e.g. "Temp 38.4, new cough with green sputum".');
  store.tx(() => {
    const id = create(store, ctx, personId, site, text(b.siteDetail, 200) || null, suspicion, null);
    logged(store, ctx, 'INFECTION_RAISE', personId, id, suspicion.slice(0, 200));
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string,
  b: { kind?: string; what?: string; value?: string; refId?: string; source?: string; note?: string }) {
  const r = load(store, id);
  const personId = String(r.personId);
  const state = String(r.state);
  enforce(store, ctx, { op: 'INFECTION', personId }, personId);
  if (ctx.serviceId !== r.serviceId) throw new HttpError(403, 'BLOCK', `This infection episode belongs to ${r.service}.`);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const at = now();
  const note = text(b.note);
  const what = text(b.what, 1000);
  const inState = (...s: string[]) => { if (!s.includes(state)) throw new HttpError(409, 'WRONG_STATE', `This infection is ${STATES[state].toLowerCase()}.`); };
  const need = (min: number, msg: string) => { if (note.length < min) throw new HttpError(400, 'NOTE_REQUIRED', msg); };
  const mustConfirm = () => { if (!confirmer(ctx)) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation cannot confirm, rule out or resolve an infection.`); };
  const end = (to: string, body: string) => {
    transition(store, 'infection', id, to, who, body.slice(0, 200));
    store.run('UPDATE infection SET ended_by = ?, ended_at = ?, outcome_note = ? WHERE id = ?', ctx.workerId, at, body, id);
  };
  switch (action) {
    case 'add': {
      inState(...ACTIVE);
      const kind = ENTRY_KINDS[String(b.kind)] ? String(b.kind) : '';
      if (!kind) throw new HttpError(400, 'KIND_REQUIRED', 'Choose what you are adding.');
      let value: string | null = null;
      let refId: string | null = null;
      if (kind === 'SOURCE_CONTROL' && b.refId) {
        const planned = store.get<Row>("SELECT id, what FROM infection_entry WHERE id = ? AND infection_id = ? AND kind = 'SOURCE_CONTROL' AND value = 'PLANNED'", String(b.refId), id);
        if (!planned) throw new HttpError(404, 'NOT_FOUND', 'That planned source control is not on this episode.');
        if (store.get('SELECT id FROM infection_entry WHERE ref_id = ?', String(b.refId))) throw new HttpError(409, 'ALREADY_DONE', 'That is already recorded as done.');
        refId = String(planned.id);
        value = 'DONE';
        store.tx(() => {
          addEntry(store, ctx, id, kind, `${planned.what}: done.${what ? ` ${what}` : ''}`, value, refId);
          logged(store, ctx, 'INFECTION_SOURCE_DONE', personId, id, String(planned.what).slice(0, 200));
        });
        break;
      }
      const min: Record<string, [number, string]> = {
        EVIDENCE: [3, 'Write the evidence, e.g. "CRP 142, chest X-ray: right lower lobe consolidation".'],
        ORGANISM: [3, 'Write the organism, e.g. "Staphylococcus aureus".'],
        SUSCEPTIBILITY: [3, 'Write the antibiotic, e.g. "Flucloxacillin".'],
        TREATMENT: [3, 'Write the treatment, e.g. "IV amoxicillin and clavulanic acid started 1400".'],
        RESPONSE: [3, 'Write what you see, e.g. "Afebrile for 24 hours, eating again".'],
        SOURCE_CONTROL: [3, 'Write what, e.g. "Remove the left forearm cannula".'],
        COMPLICATION: [3, 'Write the complication, e.g. "Sepsis: lactate 3.2, BP 88/50".'],
      };
      if (what.length < min[kind][0]) throw new HttpError(400, 'WHAT_REQUIRED', min[kind][1]);
      const pick = (list: Record<string, string>, msg: string) => { const v = list[String(b.value)] ? String(b.value) : ''; if (!v) throw new HttpError(400, 'VALUE_REQUIRED', msg); return v; };
      if (kind === 'ORGANISM') value = pick(RESISTANCE, 'Choose whether it has a resistance flag.');
      if (kind === 'SUSCEPTIBILITY') value = pick(SUSCEPTIBILITY, 'Choose sensitive, intermediate or resistant.');
      if (kind === 'RESPONSE') value = pick(RESPONSES, 'Choose whether they are improving.');
      if (kind === 'SOURCE_CONTROL') value = pick(SOURCE_STATUS, 'Choose whether it is planned or done.');
      store.tx(() => {
        addEntry(store, ctx, id, kind, what, value);
        logged(store, ctx, `INFECTION_${kind}`, personId, id, what.slice(0, 200));
      });
      break;
    }
    case 'confirm': {
      mustConfirm();
      inState('SUSPECTED');
      if (!store.get("SELECT id FROM infection_entry WHERE infection_id = ? AND kind = 'EVIDENCE'", id)) throw new HttpError(409, 'EVIDENCE_FIRST', 'Add the evidence before confirming the infection.');
      const source = text(b.source, 300);
      if (source.length < 3) throw new HttpError(400, 'SOURCE_REQUIRED', 'Say the source, e.g. "Right lower lobe pneumonia".');
      need(5, 'Say who diagnosed it and on what basis, e.g. "Dr Li: clinical and X-ray findings".');
      store.tx(() => {
        transition(store, 'infection', id, 'CONFIRMED', who, source);
        store.run('UPDATE infection SET source = ?, confirmed_by = ?, confirmed_at = ?, confirm_note = ? WHERE id = ?', source, ctx.workerId, at, note, id);
        addEntry(store, ctx, id, 'CONFIRMED', `${source}. ${note}`);
        logged(store, ctx, 'INFECTION_CONFIRM', personId, id, source);
      });
      break;
    }
    case 'ruleout': {
      mustConfirm();
      inState('SUSPECTED');
      need(5, 'Say why it is not an infection, e.g. "Fever from the blood transfusion; cultures negative".');
      store.tx(() => {
        end('NOT_INFECTION', note);
        addEntry(store, ctx, id, 'RULED_OUT', note);
        logged(store, ctx, 'INFECTION_RULE_OUT', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'ongoing': {
      mustConfirm();
      inState('CONFIRMED');
      need(5, 'Say why it is ongoing and the plan, e.g. "Chronic osteomyelitis; long-term suppression, ID clinic follows".');
      store.tx(() => {
        transition(store, 'infection', id, 'ONGOING', who, note.slice(0, 200));
        store.run('UPDATE infection SET outcome_note = ? WHERE id = ?', note, id);
        addEntry(store, ctx, id, 'ONGOING', note);
        logged(store, ctx, 'INFECTION_ONGOING', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'resolve': {
      mustConfirm();
      inState('CONFIRMED', 'ONGOING');
      const open = store.get<Row>(`SELECT x.what FROM infection_entry x WHERE x.infection_id = ? AND x.kind = 'SOURCE_CONTROL' AND x.value = 'PLANNED'
        AND NOT EXISTS (SELECT 1 FROM infection_entry y WHERE y.ref_id = x.id)`, id);
      if (open) throw new HttpError(409, 'SOURCE_OPEN', `Source control is still planned: ${open.what}. Record it as done first.`);
      need(5, 'Say how you know it has resolved, e.g. "Afebrile 48 hours, CRP 18, antibiotics finished".');
      store.tx(() => {
        end('RESOLVED', note);
        addEntry(store, ctx, id, 'RESOLVED', note);
        logged(store, ctx, 'INFECTION_RESOLVE', personId, id, note.slice(0, 200));
      });
      break;
    }
    case 'recur': {
      inState('RESOLVED');
      need(5, 'Say why you think it has come back, e.g. "Temp 38.6 and the wound is red again".');
      store.tx(() => {
        const next = create(store, ctx, personId, String(r.site), r.siteDetail ? String(r.siteDetail) : null, note, id);
        transition(store, 'infection', id, 'RECURRED', who, note.slice(0, 200));
        store.run('UPDATE infection SET recurrence_id = ? WHERE id = ?', next, id);
        addEntry(store, ctx, id, 'RECURRED', note);
        logged(store, ctx, 'INFECTION_RECUR', personId, next, note.slice(0, 200));
      });
      break;
    }
    case 'error': {
      inState(...ACTIVE);
      if (!confirmer(ctx) && r.raisedById !== ctx.workerId) throw new HttpError(403, 'BLOCK', 'Only the person who raised it, or someone who can confirm infections, can mark it as an error.');
      need(10, 'Write why this was entered in error, e.g. "Raised for the wrong person".');
      store.tx(() => {
        end('ENTERED_IN_ERROR', note);
        addEntry(store, ctx, id, 'ERROR', note);
        logged(store, ctx, 'INFECTION_ERROR', personId, id, note.slice(0, 200));
      });
      break;
    }
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
  }
  return forPerson(store, ctx, personId);
}

// The person's Infections view.
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const can = may(store, ctx, personId);
  const all = store.all<Row>(`${Q} WHERE i.person_id = ? ORDER BY i.raised_at DESC`, personId).map((r) => shape(store, ctx, r, can));
  return {
    active: all.filter((x) => ACTIVE.includes(x.state)),
    ended: all.filter((x) => !ACTIVE.includes(x.state)),
    canRaise: can,
    resistant: current(store, personId),
    options: { sites: SITES, kinds: ENTRY_KINDS, resistance: RESISTANCE, susceptibility: SUSCEPTIBILITY, responses: RESPONSES, sourceStatus: SOURCE_STATUS },
  };
}

// Home → Infections for this service: suspected (to confirm or rule out), getting worse or with
// source control waiting, and the rest being treated.
export function list(store: Store, ctx: WorkContext) {
  if (!ctx.role.capabilities.includes('infection.record')) throw new HttpError(403, 'BLOCK', `Your ${ctx.role.label} workstation does not include infections`);
  const rows = store.all<Row>(`${Q} WHERE i.service_id = ? AND i.state IN ('SUSPECTED', 'CONFIRMED', 'ONGOING') ORDER BY i.raised_at`, ctx.serviceId)
    .map((r) => shape(store, ctx, r, true));
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: 'VIEW_INFECTIONS', decision: 'ALLOW', outcome: 'VIEWED' });
  const attention = rows.filter((x) => x.state !== 'SUSPECTED' && (x.worse || x.openSource.length));
  return {
    suspected: rows.filter((x) => x.state === 'SUSPECTED'),
    attention,
    treating: rows.filter((x) => x.state !== 'SUSPECTED' && !attention.includes(x)),
    canConfirm: confirmer(ctx),
  };
}
