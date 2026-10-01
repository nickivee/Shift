import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { evaluate } from './authority.ts';
import { audit } from './audit.ts';
import { transition, recordInitial } from './lifecycle.ts';
import { STATES, HOW, NO_CONSENT, REFS } from '../config/procedures.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Procedure (Shared Lifecycle Object 211):
//   proposed, with why → planned: when, where, who does it, the person's consent (or an emergency
//   with no time to ask), and the site check where there is one → started (only if the consent still
//   stands and the site is verified) → done as planned, changed or stopped, with what was found and
//   any complications → recovery with an observation plan → recovered, outcome and follow-up.
// Doctors propose, plan and do procedures. Nurses look after recovery and say when the person has
// recovered; anyone caring for them can add a complication noticed later. Marking it done also
// marks the linked consent done.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 1500) => String(v ?? '').trim().slice(0, max);
const pick = <T>(map: Record<string, T>, v: unknown) => (map[String(v)] ? String(v) : '');
const sentence = (s: string) => s.replace(/\.?$/, '.');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPEN = ['PROPOSED', 'PLANNED', 'IN_PROGRESS', 'RECOVERY'];

const may = (store: Store, ctx: WorkContext, personId: string, op: 'PROCEDURE' | 'PROCEDURE_RECOVERY') => evaluate(store, ctx, { op, personId }).decision === 'ALLOW';

function logged(store: Store, ctx: WorkContext, operation: string, personId: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: personId,
    operation, objectType: 'clinical_procedure', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: REFS, engines: [211],
  });
}
const step = (store: Store, id: string, kind: string, body: string, by: string) =>
  store.insert('clinical_procedure_step', { id: newId(), procedure_id: id, kind, body, by_id: by, at: now() });

const Q = `
  SELECT p.id, p.person_id AS personId, p.service_id AS serviceId, p.what, p.why, p.state, pb.display_name AS proposedBy, p.proposed_at AS proposedAt,
         p.consent_id AS consentId, c.what AS consentWhat, c.state AS consentState, p.no_consent AS noConsent, p.no_consent_note AS noConsentNote,
         p.site_id AS siteId, sv.state AS siteState, sv.site AS siteName, sv.side AS siteSide, p.planned_for AS plannedFor, p.place,
         p.operator_id AS operatorId, ob.display_name AS operator, p.started_at AS startedAt, p.ended_at AS endedAt, p.how, p.findings,
         p.complications, p.recovery_plan AS recoveryPlan, rb.display_name AS recoveredBy, p.recovered_at AS recoveredAt, p.outcome,
         p.follow_up_on AS followUpOn, p.follow_up_what AS followUpWhat, p.cancel_note AS cancelNote
    FROM clinical_procedure p
    JOIN workforce_person pb ON pb.id = p.proposed_by
    LEFT JOIN workforce_person ob ON ob.id = p.operator_id
    LEFT JOIN workforce_person rb ON rb.id = p.recovered_by
    LEFT JOIN consent c ON c.id = p.consent_id
    LEFT JOIN site_verification sv ON sv.id = p.site_id`;

// What stops it starting now, in plain words; empty when it can start.
function blockers(r: Row): string[] {
  const out: string[] = [];
  if (r.consentId && r.consentState !== 'CONSENTED') out.push(`their consent is ${String(r.consentState).toLowerCase()}`);
  if (r.siteId && r.siteState !== 'VERIFIED') out.push(r.siteState === 'DISCREPANCY' ? 'the site check does not match' : 'the site is not checked yet');
  return out;
}

function shape(store: Store, r: Row, doctor: boolean, nurse: boolean): Record<string, any> {
  const state = String(r.state);
  const stop = blockers(r);
  const acts: string[] = [];
  if (doctor && state === 'PROPOSED') acts.push('plan');
  if (doctor && state === 'PLANNED') acts.push('start');
  if (doctor && state === 'IN_PROGRESS') acts.push('done');
  if ((doctor || nurse) && state === 'RECOVERY') acts.push('recovered');
  if ((doctor || nurse) && ['RECOVERY', 'FINISHED'].includes(state)) acts.push('complication');
  if (doctor && ['PROPOSED', 'PLANNED'].includes(state)) acts.push('cancel');
  return {
    ...r, state, stateLabel: STATES[state], howLabel: r.how ? HOW[String(r.how)] : null, blockers: state === 'PLANNED' ? stop : [], acts,
    steps: store.all<Row>('SELECT s.kind, s.body, w.display_name AS "by", s.at FROM clinical_procedure_step s JOIN workforce_person w ON w.id = s.by_id WHERE s.procedure_id = ? ORDER BY s.at, s.rowid', String(r.id)),
  };
}

// The Procedures view (ED, and ward doctors and nurses).
export function forPerson(store: Store, ctx: WorkContext, personId: string) {
  const doctor = may(store, ctx, personId, 'PROCEDURE');
  const nurse = may(store, ctx, personId, 'PROCEDURE_RECOVERY');
  const all = store.all<Row>(`${Q} WHERE p.person_id = ? ORDER BY COALESCE(p.planned_for, p.proposed_at) DESC`, personId).map((r) => shape(store, r, doctor, nurse));
  return {
    current: all.filter((x) => OPEN.includes(x.state)),
    past: all.filter((x) => !OPEN.includes(x.state)),
    canPropose: doctor,
    options: doctor ? {
      how: HOW, noConsent: NO_CONSENT,
      consents: store.all<Row>("SELECT id, what, recorded_at AS at FROM consent WHERE person_id = ? AND state = 'CONSENTED' ORDER BY recorded_at DESC", personId),
      sites: store.all<Row>("SELECT id, procedure, site, side, state FROM site_verification WHERE person_id = ? AND state IN ('PLANNED', 'DISCREPANCY', 'VERIFIED') ORDER BY planned_for", personId),
      operators: store.all<Row>(
        `SELECT DISTINCT w.id, w.display_name AS name FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id
          WHERE pos.service_id = ? AND pos.role_key IN ('genmed-physician', 'ed-doctor') AND (pos.end_date IS NULL OR pos.end_date >= date('now')) AND w.status = 'ACTIVE' ORDER BY w.display_name`, ctx.serviceId),
    } : null,
  };
}

// For the record header: someone recovering after a procedure, and what to watch.
export function current(store: Store, personId: string) {
  const r = store.get<Row>(`${Q} WHERE p.person_id = ? AND p.state = 'RECOVERY' ORDER BY p.ended_at DESC LIMIT 1`, personId);
  return r ? { what: r.what, endedAt: r.endedAt, plan: r.recoveryPlan } : null;
}

interface Body {
  what?: string; why?: string; when?: string; place?: string; operator?: string; consent?: string; noConsent?: string; noConsentNote?: string; site?: string;
  how?: string; findings?: string; complications?: string; recoveryPlan?: string; outcome?: string; followUpOn?: string; followUpWhat?: string; note?: string; siteMatched?: string;
}

export function propose(store: Store, ctx: WorkContext, personId: string, b: Body) {
  enforce(store, ctx, { op: 'PROCEDURE', personId }, personId);
  const what = text(b.what, 200);
  if (what.length < 3) throw new HttpError(400, 'WHAT_REQUIRED', 'Write the procedure, e.g. "Diagnostic pleural tap".');
  const why = text(b.why, 800);
  if (why.length < 5) throw new HttpError(400, 'WHY_REQUIRED', 'Write why it is needed.');
  const id = newId();
  store.tx(() => {
    store.insert('clinical_procedure', { id, person_id: personId, service_id: ctx.serviceId, what, why, state: 'PROPOSED', proposed_by: ctx.workerId, proposed_at: now() });
    recordInitial(store, 'clinical_procedure', id, 'PROPOSED', { actorId: ctx.workerId, workContextId: ctx.id }, what);
    step(store, id, 'PROPOSED', `Proposed: ${what}. ${sentence(why)}`, ctx.workerId);
    logged(store, ctx, 'PROCEDURE_PROPOSE', personId, id, what);
  });
  return forPerson(store, ctx, personId);
}

export function act(store: Store, ctx: WorkContext, id: string, action: string, b: Body) {
  const r = store.get<Row>(`${Q} WHERE p.id = ?`, id);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'That procedure is no longer in SHIFT.');
  const personId = String(r.personId);
  const state = String(r.state);
  const nurseWork = ['recovered', 'complication'].includes(action);
  enforce(store, ctx, { op: nurseWork && !may(store, ctx, personId, 'PROCEDURE') ? 'PROCEDURE_RECOVERY' : 'PROCEDURE', personId }, personId);
  const who = { actorId: ctx.workerId, workContextId: ctx.id };
  const say = text(b.note);
  const must = (ok: boolean) => { if (!ok) throw new HttpError(409, 'STATE', `This procedure is ${STATES[state].toLowerCase()}; that cannot be done now.`); };
  store.tx(() => {
    switch (action) {
      case 'plan': {
        must(state === 'PROPOSED');
        const when = text(b.when, 30);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) throw new HttpError(400, 'WHEN_REQUIRED', 'Choose when it will be done.');
        const place = text(b.place, 120);
        if (place.length < 2) throw new HttpError(400, 'PLACE_REQUIRED', 'Write where, e.g. "Bedside, Ward K Bed 5" or "ED procedure room".');
        const operator = store.get<{ id: string; name: string }>("SELECT id, display_name AS name FROM workforce_person WHERE id = ? AND status = 'ACTIVE'", text(b.operator, 60));
        if (!operator) throw new HttpError(400, 'OPERATOR_REQUIRED', 'Choose who will do it.');
        const consent = b.consent ? store.get<Row>("SELECT id, what FROM consent WHERE id = ? AND person_id = ? AND state = 'CONSENTED'", b.consent, personId) : null;
        const noConsent = pick(NO_CONSENT, b.noConsent);
        const noConsentNote = text(b.noConsentNote, 500);
        if (!consent && !noConsent) throw new HttpError(400, 'CONSENT_REQUIRED', 'Link their consent for this procedure (record it under Consent and capacity first), or say why there is no time to ask.');
        if (!consent && noConsentNote.length < 10) throw new HttpError(400, 'CONSENT_NOTE', 'Write why it cannot wait to ask them.');
        const site = b.site ? store.get<Row>("SELECT id FROM site_verification WHERE id = ? AND person_id = ? AND state IN ('PLANNED', 'DISCREPANCY', 'VERIFIED')", b.site, personId) : null;
        transition(store, 'clinical_procedure', id, 'PLANNED', who, 'Planned');
        store.run('UPDATE clinical_procedure SET planned_for = ?, place = ?, operator_id = ?, consent_id = ?, no_consent = ?, no_consent_note = ?, site_id = ? WHERE id = ?',
          new Date(when).toISOString(), place, operator.id, consent?.id ?? null, consent ? null : noConsent, consent ? null : noConsentNote, site?.id ?? null, id);
        step(store, id, 'PLANNED', `Planned for ${when.replace('T', ' ')} at ${place}, by ${operator.name}. ${consent ? `Consent: ${consent.what}.` : `No consent: ${noConsentNote}`}`, ctx.workerId);
        logged(store, ctx, 'PROCEDURE_PLAN', personId, id, String(r.what));
        break;
      }
      case 'start': {
        must(state === 'PLANNED');
        const stop = blockers(r);
        if (stop.length) throw new HttpError(409, 'NOT_READY', `It cannot start: ${stop.join('; ')}.`);
        transition(store, 'clinical_procedure', id, 'IN_PROGRESS', who, 'Started');
        store.run('UPDATE clinical_procedure SET started_at = ? WHERE id = ?', now(), id);
        step(store, id, 'STARTED', 'Started.', ctx.workerId);
        logged(store, ctx, 'PROCEDURE_START', personId, id, String(r.what));
        break;
      }
      case 'done': {
        must(state === 'IN_PROGRESS');
        const how = pick(HOW, b.how);
        if (!how) throw new HttpError(400, 'HOW_REQUIRED', 'Choose how it went.');
        const findings = text(b.findings, 2000);
        if (findings.length < 5) throw new HttpError(400, 'FINDINGS_REQUIRED', how === 'ABANDONED' ? 'Write why it was stopped.' : 'Write what was done and found.');
        const complications = text(b.complications, 1000);
        const plan = text(b.recoveryPlan, 800);
        if (plan.length < 5) throw new HttpError(400, 'RECOVERY_REQUIRED', 'Write the recovery plan, e.g. "Obs every 15 min for 1 hour; lie flat".');
        // The linked site check closes with the procedure, saying whether it was done on the checked site.
        const siteOpen = r.siteId && r.siteState === 'VERIFIED' && how !== 'ABANDONED';
        const matched = b.siteMatched === 'YES' ? true : b.siteMatched === 'NO' ? false : null;
        if (siteOpen && matched === null) throw new HttpError(400, 'SITE_REQUIRED', 'Say whether it was done on the checked site and side.');
        if (siteOpen && !matched && complications.length < 5) throw new HttpError(400, 'SITE_NOTE', 'Write under Complications where it was done and what happened. Report this as an incident too.');
        transition(store, 'clinical_procedure', id, 'RECOVERY', who, HOW[how]);
        store.run('UPDATE clinical_procedure SET ended_at = ?, how = ?, findings = ?, complications = ?, recovery_plan = ? WHERE id = ?', now(), how, findings, complications || null, plan, id);
        if (r.consentId && r.consentState === 'CONSENTED') {
          transition(store, 'consent', String(r.consentId), 'DONE', who, `${r.what}: ${HOW[how].toLowerCase()}`);
          store.run('UPDATE consent SET ended_by = ?, ended_at = ?, end_note = ? WHERE id = ?', ctx.workerId, now(), `${r.what}: ${HOW[how].toLowerCase()}`, r.consentId);
          store.insert('consent_log', { id: newId(), consent_id: r.consentId, kind: 'DONE', body: `${r.what}: ${HOW[how].toLowerCase()}.`, by_id: ctx.workerId, at: now() });
        }
        if (siteOpen) {
          const sid = String(r.siteId);
          transition(store, 'sitecheck', sid, 'DONE', who, matched ? 'Procedure record' : `Different site: ${complications.slice(0, 150)}`);
          store.run('UPDATE site_verification SET done_by = ?, done_at = ?, done_ref = ?, done_mismatch = ?, done_note = ? WHERE id = ?',
            ctx.workerId, now(), 'Procedure record', matched ? 0 : 1, matched ? null : complications, sid);
          store.insert('site_check', { id: newId(), verification_id: sid, kind: 'DONE', source: null, outcome: matched ? 'MATCH' : 'MISMATCH', stated: null,
            note: `Procedure record.${matched ? ' Done on the verified site.' : ` Done on a different site. ${complications}`}`, superseded: 0, by_id: ctx.workerId, at: now() });
          logged(store, ctx, matched ? 'SITE_DONE' : 'SITE_DONE_WRONG_SITE', personId, id, `Site check closed: ${matched ? 'done on the verified site' : 'done on a different site'}`);
        }
        step(store, id, 'DONE', `${HOW[how]}. ${sentence(findings)}${complications ? ` Complications: ${sentence(complications)}` : ' No complications.'} Recovery: ${sentence(plan)}`, ctx.workerId);
        logged(store, ctx, 'PROCEDURE_DONE', personId, id, `${r.what}: ${HOW[how]}`);
        break;
      }
      case 'recovered': {
        must(state === 'RECOVERY');
        const outcome = text(b.outcome, 800);
        if (outcome.length < 5) throw new HttpError(400, 'OUTCOME_REQUIRED', 'Write how they are now, e.g. "Obs normal for an hour; up and walking".');
        const on = text(b.followUpOn, 10);
        if (on && !DAY.test(on)) throw new HttpError(400, 'FOLLOW_UP', 'Choose a follow-up date, or leave it empty.');
        const fwhat = text(b.followUpWhat, 300);
        if (on && fwhat.length < 3) throw new HttpError(400, 'FOLLOW_UP_WHAT', 'Write what the follow-up is.');
        transition(store, 'clinical_procedure', id, 'FINISHED', who, 'Recovered');
        store.run('UPDATE clinical_procedure SET recovered_by = ?, recovered_at = ?, outcome = ?, follow_up_on = ?, follow_up_what = ? WHERE id = ?', ctx.workerId, now(), outcome, on || null, on ? fwhat : null, id);
        step(store, id, 'RECOVERED', `Recovered: ${sentence(outcome)}${on ? ` Follow-up ${on}: ${sentence(fwhat)}` : ''}`, ctx.workerId);
        logged(store, ctx, 'PROCEDURE_RECOVERED', personId, id, String(r.what));
        break;
      }
      case 'complication': {
        must(['RECOVERY', 'FINISHED'].includes(state));
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write what happened, e.g. "Bleeding from the site at 3pm; pressure for 10 min".');
        store.run("UPDATE clinical_procedure SET complications = CASE WHEN complications IS NULL THEN ? ELSE complications || '; ' || ? END WHERE id = ?", say, say, id);
        step(store, id, 'COMPLICATION', `Complication: ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'PROCEDURE_COMPLICATION', personId, id, say);
        break;
      }
      case 'cancel': {
        must(['PROPOSED', 'PLANNED'].includes(state));
        if (say.length < 5) throw new HttpError(400, 'NOTE_REQUIRED', 'Write why it is cancelled.');
        transition(store, 'clinical_procedure', id, 'CANCELLED', who, say);
        store.run('UPDATE clinical_procedure SET cancel_note = ? WHERE id = ?', say, id);
        step(store, id, 'CANCELLED', `Cancelled: ${sentence(say)}`, ctx.workerId);
        logged(store, ctx, 'PROCEDURE_CANCEL', personId, id, say);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return forPerson(store, ctx, personId);
}
