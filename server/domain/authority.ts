import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import type { Capability } from '../config/workstations.ts';
import { now } from '../lib/util.ts';

export type Decision = 'ALLOW' | 'BLOCK' | 'HOLD' | 'UNRESOLVED';

export interface AuthorityResult {
  decision: Decision;
  reasons: string[];
  ruleRefs: string[];
}

export type Operation =
  | { op: 'VIEW_RECORD'; personId: string }
  | { op: 'RETRIEVE'; personId: string; view: string }
  | { op: 'CREATE'; personId: string; key: string }
  | { op: 'AMEND'; personId: string; authorId: string | null }
  | { op: 'ROUTE'; personId: string; destinationOrgId: string }
  | { op: 'TASK'; serviceId: string }
  | { op: 'HANDOVER'; personId: string }
  | { op: 'RECEIVE'; destinationServiceId: string; destinationRoleKey: string | null }
  | { op: 'REVIEW_RESULT'; personId: string }
  | { op: 'KNOWLEDGE' }
  | { op: 'ROSTER_DECIDE'; serviceId: string }
  | { op: 'TRANSFER_REQUEST'; personId: string }
  | { op: 'TRANSFER_RESPOND'; toServiceId: string; step: 'accept' | 'arrive' | 'responsibility' }
  | { op: 'TRANSFER_VIEW'; serviceIds: string[] }
  | { op: 'BED_MANAGE'; serviceId: string; organisationId: string }
  | { op: 'ESCALATE'; personId: string }
  | { op: 'CAREPLAN'; personId: string }
  | { op: 'REFERRAL_REQUEST'; personId: string; cap: 'referral.request' | 'referral.authorise' }
  | { op: 'REFERRAL_TRIAGE'; serviceId: string }
  | { op: 'APPOINTMENT_REQUEST'; personId: string }
  | { op: 'ALERT_RAISE'; personId: string }
  | { op: 'COMMUNICATION'; personId: string }
  | { op: 'MONITORING_PLAN'; personId: string }
  | { op: 'RESTRICTION'; personId: string }
  | { op: 'DIET_ORDER'; personId: string }
  | { op: 'EQUIPMENT_USE'; personId: string }
  | { op: 'BED_MOVE_REQUEST'; personId: string }
  | { op: 'LEAVE'; personId: string; cap: 'leave.manage' | 'leave.approve' }
  | { op: 'PREFERENCE'; personId: string }
  | { op: 'WHANAU'; personId: string }
  | { op: 'ACCESS'; personId: string }
  | { op: 'EXTERNAL'; personId: string }
  | { op: 'CAPACITY'; personId: string; cap: 'capacity.concern' | 'capacity.assess' }
  | { op: 'MEAL_RECORD'; personId: string }
  | { op: 'RESTRICTION_CHECK'; personId: string }
  | { op: 'COMMUNICATION_ACT'; serviceId: string }
  | { op: 'ALERT_RECEIVE'; serviceId: string; capability: string }
  | { op: 'APPOINTMENT_MANAGE'; serviceId: string; clinical: boolean }
  | { op: 'WOUND'; personId: string; cap: 'wound.identify' | 'wound.manage' }
  | { op: 'CONSULT_REQUEST'; personId: string }
  | { op: 'CONSULT_RESPOND'; serviceId: string; roleKey: string }
  | { op: 'ESCALATION_RESPOND'; serviceId: string; roleKey: string }
  | { op: 'DISCHARGE'; personId: string; cap: 'discharge.plan' | 'discharge.decide' | 'discharge.complete' }
  | { op: 'PRESCRIBE' | 'ADMINISTER' | 'CONTROLLED_DRUG' | 'EARLY_WARNING_SCORE' };

const ORG = 'ORG-SYN-001 v1';
const allow = (refs: string[] = [ORG]): AuthorityResult => ({ decision: 'ALLOW', reasons: [], ruleRefs: refs });
const block = (reason: string, refs: string[] = [ORG]): AuthorityResult => ({ decision: 'BLOCK', reasons: [reason], ruleRefs: refs });

// Every operation is evaluated against actor, active context, relationship and object.
// Unknown operations and missing context fail closed. Creating a record, routing it and
// disclosing it are separate authorities (Package 6).
export function evaluate(store: Store, ctx: WorkContext | null, o: Operation): AuthorityResult {
  if (!ctx) return block('No active WORK context', ['WORK-CTX-001']);

  switch (o.op) {
    case 'PRESCRIBE':
    case 'ADMINISTER':
      return { decision: 'UNRESOLVED', reasons: ['Medicines requirements are not yet mapped for this profession and setting'], ruleRefs: ['LAW-NZ-008', 'LAW-NZ-009', 'RR-MED-001'] };
    case 'CONTROLLED_DRUG':
      return { decision: 'UNRESOLVED', reasons: ['Controlled-drug requirements need a current-version review'], ruleRefs: ['LAW-NZ-010', 'LAW-NZ-011', 'RR-CD-001'] };
    case 'EARLY_WARNING_SCORE':
      return { decision: 'UNRESOLVED', reasons: ['NZ early-warning thresholds have not been researched for this service'], ruleRefs: ['RR-EWS-001'] };
    case 'KNOWLEDGE':
      return need(ctx, 'knowledge.use') ?? professional(ctx) ?? allow();
    case 'TRANSFER_RESPOND': {
      if (o.toServiceId !== ctx.serviceId) return block('This transfer is addressed to another service');
      // Accepting a patient and accepting responsibility are clinical acts for the
      // receiving clinician; confirming physical arrival is for the receiving nurse.
      const cap = o.step === 'arrive' ? 'transfer.arrive' : 'transfer.accept';
      return need(ctx, cap) ?? professional(ctx) ?? allow();
    }
    case 'TRANSFER_VIEW':
      if (ctx.role.capabilities.includes('bed.manage') && !ctx.role.capabilities.includes('record.view')) return allow();
      return need(ctx, 'route.receive') ?? (o.serviceIds.includes(ctx.serviceId) ? allow() : block('This transfer does not involve your service'));
    case 'BED_MANAGE':
      if (o.organisationId !== ctx.organisationId) return block('That bed belongs to another organisation');
      if (!ctx.role.capabilities.includes('record.view')) return need(ctx, 'bed.manage') ?? allow();
      return need(ctx, 'bed.manage') ?? (o.serviceId === ctx.serviceId ? allow() : block('That bed belongs to another service'));
    case 'ESCALATION_RESPOND':
      // Only the addressed role in the responsible service receives and answers an escalation.
      if (o.serviceId !== ctx.serviceId) return block('This escalation is addressed to another service');
      if (o.roleKey !== ctx.role.roleKey) return block('This escalation is addressed to another role');
      return need(ctx, 'escalation.respond') ?? professional(ctx) ?? allow();
    case 'CONSULT_RESPOND':
      if (o.serviceId !== ctx.serviceId) return block('This consultation is addressed to another service');
      if (o.roleKey !== ctx.role.roleKey) return block('This consultation is addressed to another role');
      return need(ctx, 'consult.respond') ?? professional(ctx) ?? allow();
    case 'REFERRAL_TRIAGE':
      // Receiving, triaging and deciding on a referral belong to the receiving service.
      if (o.serviceId !== ctx.serviceId) return block('This referral is addressed to another service');
      return need(ctx, 'referral.triage') ?? professional(ctx) ?? allow();
    case 'APPOINTMENT_MANAGE': {
      // A service runs its own appointments. Starting and finishing one is clinical work.
      if (o.serviceId !== ctx.serviceId) return block('This appointment belongs to another service');
      return need(ctx, 'appointment.manage') ?? (o.clinical ? professional(ctx) : null) ?? allow();
    }
    case 'ALERT_RECEIVE':
      // An alert is for the recipients it names: its service, and roles holding the
      // capability that can act on it.
      if (o.serviceId !== ctx.serviceId) return block('This alert is for another service');
      return ctx.role.capabilities.includes(o.capability as Capability) ? allow() : block('This alert is for another role');
    case 'COMMUNICATION_ACT':
      if (o.serviceId !== ctx.serviceId) return block('This communication belongs to another service');
      return need(ctx, 'communication.manage') ?? professional(ctx) ?? allow();
    case 'ROSTER_DECIDE':
      return need(ctx, 'roster.decide') ?? (o.serviceId === ctx.serviceId ? allow() : block('That roster belongs to another service'));
    case 'TASK':
      return need(ctx, 'task.manage') ?? (o.serviceId === ctx.serviceId ? allow() : block('Task belongs to another service'));
    case 'RECEIVE':
      if (o.destinationServiceId !== ctx.serviceId) return block('Destination is not your active service');
      if (o.destinationRoleKey && o.destinationRoleKey !== ctx.role.roleKey) return block('Destination is addressed to another role');
      return need(ctx, 'route.receive') ?? allow();
    default:
      break;
  }

  const rel = relationship(store, ctx, o.personId);
  if (!rel) {
    return {
      decision: 'BLOCK',
      reasons: [`No care relationship with this ${ctx.subjectLabel.toLowerCase()} in ${ctx.serviceName}. Exceptional access needs a recorded reason.`],
      ruleRefs: [ORG, 'LAW-NZ-002'],
    };
  }

  switch (o.op) {
    case 'VIEW_RECORD':
      return need(ctx, 'record.view') ?? allow([ORG, 'LAW-NZ-002']);
    case 'RETRIEVE':
      return need(ctx, 'record.view') ?? (ctx.role.views.includes(o.view) ? allow([ORG, 'LAW-NZ-002']) : block(`?${o.view} is not part of your workstation`));
    case 'CREATE':
      return need(ctx, 'event.create') ?? professional(ctx) ?? (ctx.role.keys.includes(o.key) ? allow() : block(`${o.key} is not part of your workstation`));
    case 'AMEND':
      return need(ctx, 'event.amend') ?? professional(ctx) ?? (o.authorId === ctx.workerId ? allow() : block('Only the original author can amend or mark this entry in error'));
    case 'HANDOVER':
      return need(ctx, 'handover.use') ?? allow();
    case 'TRANSFER_REQUEST':
      return need(ctx, 'transfer.request') ?? professional(ctx) ?? allow();
    case 'CONSULT_REQUEST':
      return need(ctx, 'consult.request') ?? professional(ctx) ?? (rel === 'CONSULTATION' ? block('A consulting service gives advice; it does not ask for further consultations') : allow([ORG, 'LAW-NZ-002']));
    case 'WOUND':
      return need(ctx, o.cap) ?? professional(ctx) ?? allow([ORG, 'LAW-NZ-002']);
    case 'REFERRAL_REQUEST':
      // A referral comes from a service caring for the person, not from one only reading
      // the record because it was asked for advice or to take the person on.
      return need(ctx, o.cap) ?? professional(ctx) ?? (rel === 'ENCOUNTER' || rel === 'CARE_RELATIONSHIP'
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can refer them`));
    case 'APPOINTMENT_REQUEST':
      return need(ctx, 'appointment.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP', 'REFERRAL'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Your service needs a care relationship or a referral for this ${ctx.subjectLabel.toLowerCase()} to book them`));
    case 'ALERT_RAISE':
      return need(ctx, 'alert.raise') ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can raise an alert about them`));
    case 'COMMUNICATION':
      return need(ctx, 'communication.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP', 'REFERRAL'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Your service needs a care relationship with this ${ctx.subjectLabel.toLowerCase()} to arrange communication about them`));
    case 'MONITORING_PLAN':
      // Only the service caring for the person sets how they are monitored.
      return need(ctx, 'monitoring.plan') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can set their monitoring`));
    case 'RESTRICTION':
      // Only a service caring for the person proposes, changes or stops a restriction.
      return need(ctx, 'restriction.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can set restrictions`));
    case 'DIET_ORDER':
      // Only a service caring for the person orders their diet.
      return need(ctx, 'diet.order') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can order their diet`));
    case 'BED_MOVE_REQUEST':
      return need(ctx, 'bed.request') ?? (rel === 'ENCOUNTER'
        ? allow([ORG])
        : block(`Only the service where this ${ctx.subjectLabel.toLowerCase()} is staying can ask to move them`));
    case 'CAPACITY':
      return need(ctx, o.cap) ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-005'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can ${o.cap === 'capacity.assess' ? 'assess' : 'raise a concern about'} their capacity`));
    case 'ACCESS':
      return need(ctx, 'access.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-005'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can record their communication needs or book an interpreter`));
    case 'EXTERNAL':
      return need(ctx, 'external.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can match or review information about them from other providers`));
    case 'WHANAU':
      return need(ctx, 'whanau.manage') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002', 'LAW-NZ-005'])
        : block(`Only a service caring for this ${ctx.subjectLabel.toLowerCase()} can record their whānau and support people`));
    case 'PREFERENCE':
      return need(ctx, 'preference.record') ?? professional(ctx) ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-005'])
        : block(`Only staff caring for this ${ctx.subjectLabel.toLowerCase()} record their preferences`));
    case 'LEAVE':
      // Leave is arranged and approved by the service the person is staying with.
      return need(ctx, o.cap) ?? professional(ctx) ?? (rel === 'ENCOUNTER'
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only the service where this ${ctx.subjectLabel.toLowerCase()} is staying can arrange their leave`));
    case 'EQUIPMENT_USE':
      return need(ctx, 'equipment.use') ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only staff caring for this ${ctx.subjectLabel.toLowerCase()} can set up equipment for them`));
    case 'MEAL_RECORD':
      return need(ctx, 'meal.record') ?? (rel === 'ENCOUNTER'
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Meals are recorded by the service where this ${ctx.subjectLabel.toLowerCase()} is staying`));
    case 'RESTRICTION_CHECK':
      return need(ctx, 'restriction.check') ?? (['ENCOUNTER', 'CARE_RELATIONSHIP'].includes(rel)
        ? allow([ORG, 'LAW-NZ-002'])
        : block(`Only staff caring for this ${ctx.subjectLabel.toLowerCase()} record checks`));
    case 'CAREPLAN':
      return need(ctx, 'careplan.manage') ?? professional(ctx) ?? allow([ORG, 'LAW-NZ-002']);
    case 'ESCALATE':
      return need(ctx, 'escalation.raise') ?? professional(ctx) ?? allow([ORG, 'LAW-NZ-002']);
    case 'DISCHARGE':
      // Only the service the person is admitted to can discharge them.
      return need(ctx, o.cap) ?? professional(ctx) ?? (rel === 'ENCOUNTER' ? allow() : block(`Only the service this ${ctx.subjectLabel.toLowerCase()} is admitted to can discharge them`));
    case 'REVIEW_RESULT':
      return need(ctx, 'result.review') ?? professional(ctx) ?? allow();
    case 'ROUTE': {
      const denied = need(ctx, 'route.send');
      if (denied) return denied;
      if (o.destinationOrgId !== ctx.organisationId) {
        return { decision: 'UNRESOLVED', reasons: ['Routing to another organisation is a disclosure; the HIPC rule 11 mapping is still a research requirement'], ruleRefs: ['LAW-NZ-002', 'RR-DISC-001'] };
      }
      return allow([ORG, 'LAW-NZ-002']);
    }
  }
}

function need(ctx: WorkContext, cap: Capability): AuthorityResult | null {
  return ctx.role.capabilities.includes(cap) ? null : block(`Your ${ctx.role.label} workstation does not include this function`);
}

// Clinical action requires current, effective-dated professional authority when the role
// is a regulated one. Registration comes from law; mapping it to this role is org config.
function professional(ctx: WorkContext): AuthorityResult | null {
  if (!ctx.role.profession) return null;
  if (!ctx.authority) return block(`No ${ctx.role.profession} authority is recorded for you`, ['LAW-NZ-007', ORG]);
  if (!ctx.authority.current) return block(`Your ${ctx.role.profession} practising authority is ${ctx.authority.status.toLowerCase()}`, ['LAW-NZ-007', ORG]);
  return null;
}

export type Relationship = 'ENCOUNTER' | 'CARE_RELATIONSHIP' | 'TRANSFER' | 'CONSULTATION' | 'REFERRAL' | 'EXCEPTIONAL';

export function relationship(store: Store, ctx: WorkContext, personId: string): Relationship | null {
  const enc = store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId);
  if (enc) return 'ENCOUNTER';
  const cr = store.get('SELECT 1 FROM care_relationship WHERE person_id = ? AND service_id = ? AND ended_at IS NULL', personId, ctx.serviceId);
  if (cr) return 'CARE_RELATIONSHIP';
  // A receiving service may read the record of a person it has been asked to take.
  const tr = store.get(
    "SELECT 1 FROM transfer WHERE person_id = ? AND to_service_id = ? AND state IN ('REQUESTED', 'ACCEPTED', 'BED_ALLOCATED', 'ARRIVED')", personId, ctx.serviceId,
  );
  if (tr) return 'TRANSFER';
  // A consulted role may read the record while the consultation is open.
  const cs = store.get(
    "SELECT 1 FROM consultation WHERE person_id = ? AND to_service_id = ? AND to_role_key = ? AND state IN ('REQUESTED', 'RECEIVED', 'ACCEPTED')",
    personId, ctx.serviceId, ctx.role.roleKey,
  );
  if (cs) return 'CONSULTATION';
  // A service that has been sent a referral may read the record: its triaging clinicians
  // from the moment it arrives, the rest of the service once the referral is accepted.
  const triage = ctx.role.capabilities.includes('referral.triage');
  const rf = store.get(
    `SELECT 1 FROM referral WHERE person_id = ? AND to_service_id = ? AND state IN (${triage ? "'SENT', 'RECEIVED', 'TRIAGED', " : ''}'ACCEPTED', 'SCHEDULED', 'SEEN')`,
    personId, ctx.serviceId,
  );
  if (rf) return 'REFERRAL';
  const ex = store.get(
    'SELECT 1 FROM exceptional_access WHERE work_context_id = ? AND person_id = ? AND expires_at > ?',
    ctx.id, personId, now(),
  );
  return ex ? 'EXCEPTIONAL' : null;
}
