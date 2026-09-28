import type { Store } from '../db/database.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Shared lifecycle machine (Package 5 §4 and the Transitions document). Each governed
// object moves only along its declared chain, and every move is recorded as evidence.
// Sent, received, reviewed and actioned are distinct states; none implies the next.
export const LIFECYCLES: Record<string, { table: string; initial: string; next: Record<string, string[]> }> = {
  route: {
    table: 'route',
    initial: 'SENT',
    next: {
      SENT: ['DELIVERED'],
      DELIVERED: ['RECEIVED'],
      RECEIVED: ['REVIEWED'],
      REVIEWED: ['ACCEPTED', 'ACTIONED'],
      ACCEPTED: ['ACTIONED'],
    },
  },
  task: {
    table: 'task',
    initial: 'CREATED',
    next: {
      CREATED: ['ASSIGNED', 'ACCEPTED', 'CANCELLED'],
      ASSIGNED: ['ACCEPTED', 'REASSIGNED', 'CANCELLED'],
      REASSIGNED: ['ASSIGNED'],
      ACCEPTED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: ['CLOSED'],
    },
  },
  transfer: {
    table: 'transfer',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
      ACCEPTED: ['BED_ALLOCATED', 'CANCELLED'],
      BED_ALLOCATED: ['ARRIVED', 'BED_ALLOCATED', 'CANCELLED'],
      ARRIVED: ['RESPONSIBILITY_ACCEPTED'],
    },
  },
  discharge: {
    table: 'discharge',
    initial: 'CONSIDERED',
    next: {
      CONSIDERED: ['DECIDED', 'CANCELLED'],
      DECIDED: ['DISCHARGED', 'CONSIDERED', 'CANCELLED'],
    },
  },
  escalation: {
    table: 'escalation',
    initial: 'RAISED',
    next: {
      RAISED: ['RECEIVED', 'ESCALATED', 'RESOLVED'],
      RECEIVED: ['ACKNOWLEDGED', 'ESCALATED', 'RESOLVED'],
      ACKNOWLEDGED: ['RESPONDED', 'ESCALATED', 'RESOLVED'],
      RESPONDED: ['RESOLVED', 'ESCALATED'],
    },
  },
  consultation: {
    table: 'consultation',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['RECEIVED', 'WITHDRAWN'],
      RECEIVED: ['ACCEPTED', 'DECLINED', 'WITHDRAWN'],
      ACCEPTED: ['ADVISED', 'WITHDRAWN'],
      ADVISED: ['ADVICE_RECEIVED'],
      ADVICE_RECEIVED: ['CLOSED'],
    },
  },
  wound: {
    table: 'wound',
    initial: 'IDENTIFIED',
    next: {
      IDENTIFIED: ['ASSESSED', 'CLOSED'],
      ASSESSED: ['PLANNED', 'HEALED', 'CLOSED'],
      PLANNED: ['PLANNED', 'HEALED', 'CLOSED'],
    },
  },
  careplan: {
    table: 'care_plan_item',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACHIEVED', 'CEASED', 'SUPERSEDED'] },
  },
  referral: {
    table: 'referral',
    initial: 'DRAFT',
    next: {
      DRAFT: ['AUTHORISED', 'CANCELLED'],
      AUTHORISED: ['SENT', 'CANCELLED'],
      SENT: ['RECEIVED', 'CANCELLED'],
      RECEIVED: ['TRIAGED', 'CANCELLED'],
      TRIAGED: ['ACCEPTED', 'DECLINED', 'REDIRECTED', 'CANCELLED'],
      ACCEPTED: ['SCHEDULED', 'SEEN', 'CANCELLED'],
      SCHEDULED: ['SCHEDULED', 'SEEN', 'CANCELLED'],
      SEEN: ['RESPONSIBILITY_ACCEPTED', 'OUTCOME_RECORDED'],
      RESPONSIBILITY_ACCEPTED: ['OUTCOME_RECORDED'],
      OUTCOME_RECORDED: ['CLOSED'],
    },
  },
  appointment: {
    table: 'appointment',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['OFFERED', 'BOOKED', 'CANCELLED'],
      OFFERED: ['BOOKED', 'REQUESTED', 'CANCELLED'],
      BOOKED: ['CONFIRMED', 'ARRIVED', 'BOOKED', 'CANCELLED', 'DID_NOT_ATTEND'],
      CONFIRMED: ['ARRIVED', 'BOOKED', 'CANCELLED', 'DID_NOT_ATTEND'],
      ARRIVED: ['COMMENCED', 'UNABLE_TO_COMPLETE'],
      COMMENCED: ['COMPLETED', 'UNABLE_TO_COMPLETE'],
    },
  },
  alert: {
    table: 'alert',
    initial: 'GENERATED',
    next: {
      GENERATED: ['VISIBLE', 'EXPIRED', 'RESOLVED'],
      VISIBLE: ['ACKNOWLEDGED', 'EXPIRED', 'RESOLVED'],
      ACKNOWLEDGED: ['ACTIONED', 'RESOLVED', 'EXPIRED'],
      ACTIONED: ['ACTIONED', 'RESOLVED', 'EXPIRED'],
    },
  },
  communication: {
    table: 'communication',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['ATTEMPTED', 'CONVEYED', 'CANCELLED'],
      ATTEMPTED: ['ATTEMPTED', 'CONVEYED', 'CANCELLED'],
      CONVEYED: ['FOLLOW_UP', 'COMPLETED'],
      FOLLOW_UP: ['COMPLETED'],
    },
  },
  bedmove: {
    table: 'bed_move',
    initial: 'REQUESTED',
    next: { REQUESTED: ['ALLOCATED', 'CANCELLED'], ALLOCATED: ['MOVED', 'REQUESTED', 'CANCELLED'] },
  },
  equipment: {
    table: 'equipment',
    initial: 'AVAILABLE',
    next: {
      AVAILABLE: ['IN_USE', 'QUARANTINED', 'IN_REPAIR', 'RETIRED'],
      IN_USE: ['AVAILABLE', 'QUARANTINED'],
      QUARANTINED: ['IN_REPAIR', 'AVAILABLE', 'RETIRED'],
      IN_REPAIR: ['AVAILABLE', 'RETIRED'],
    },
  },
  diet: {
    table: 'diet_order',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  instrument: {
    table: 'instrument_use',
    initial: 'REQUESTED',
    next: { REQUESTED: ['COMPLETED', 'DECLINED', 'CANCELLED'], COMPLETED: ['INTERPRETED'] },
  },
  function: {
    table: 'function_assessment',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  functionplan: {
    table: 'function_intervention',
    initial: 'PLANNED',
    next: { PLANNED: ['IN_PLACE', 'STOPPED'], IN_PLACE: ['STOPPED'] },
  },
  usual: {
    table: 'usual_state',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  difference: {
    table: 'usual_difference',
    initial: 'NOTICED',
    next: { NOTICED: ['ACTING', 'CLOSED'], ACTING: ['CLOSED'] },
  },
  assignment: {
    table: 'assignment',
    initial: 'PROPOSED',
    next: { PROPOSED: ['CONFIRMED', 'DECLINED'], CONFIRMED: ['ACTIVE', 'ENDED'], ACTIVE: ['ENDED'] },
  },
  allocplan: {
    table: 'allocation_plan',
    initial: 'DRAFT',
    next: { DRAFT: ['SUBMITTED', 'CANCELLED'], SUBMITTED: ['CONFIRMED', 'DRAFT'], CONFIRMED: ['ACTIVE', 'CANCELLED'], ACTIVE: ['ENDED'] },
  },
  acuity: {
    table: 'acuity_assessment',
    initial: 'CURRENT',
    next: { CURRENT: ['SUPERSEDED', 'ENTERED_IN_ERROR'] },
  },
  deterioration: {
    table: 'deterioration_event',
    initial: 'DETECTED',
    next: {
      // CLOSED from any state only when the person dies (death record closure); the view closes from REASSESSED.
      DETECTED: ['ESCALATED', 'REASSESSED', 'CLOSED'], ESCALATED: ['RESPONDING', 'REASSESSED', 'CLOSED'], RESPONDING: ['ESCALATED', 'REASSESSED', 'CLOSED'],
      REASSESSED: ['ESCALATED', 'RESPONDING', 'CLOSED'],
    },
  },
  incident: {
    table: 'incident',
    initial: 'REPORTED',
    next: { REPORTED: ['REVIEWED'], REVIEWED: ['INVESTIGATING', 'ACTIONS'], INVESTIGATING: ['ACTIONS'], ACTIONS: ['CLOSED'] },
  },
  death: {
    table: 'death_event',
    initial: 'IDENTIFIED',
    next: { IDENTIFIED: ['VERIFIED', 'ENTERED_IN_ERROR'], VERIFIED: ['CLOSED', 'ENTERED_IN_ERROR'] },
  },
  problem: {
    table: 'clinical_problem',
    initial: 'CONCERN',
    next: {
      CONCERN: ['PROVISIONAL', 'ACTIVE', 'RULED_OUT', 'RESOLVED', 'ENTERED_IN_ERROR'], PROVISIONAL: ['ACTIVE', 'RULED_OUT', 'RESOLVED', 'ENTERED_IN_ERROR'],
      ACTIVE: ['RESOLVED', 'INACTIVE', 'ENTERED_IN_ERROR'], RESOLVED: ['ACTIVE', 'ENTERED_IN_ERROR'], INACTIVE: ['ACTIVE', 'ENTERED_IN_ERROR'],
      RULED_OUT: ['ENTERED_IN_ERROR'],
    },
  },
  symptom: {
    table: 'symptom',
    initial: 'RECORDED',
    next: {
      RECORDED: ['ASSESSED', 'INTERVENTION', 'REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'], ASSESSED: ['INTERVENTION', 'REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'],
      INTERVENTION: ['REASSESSED', 'CLOSED', 'ENTERED_IN_ERROR'], REASSESSED: ['INTERVENTION', 'CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  intervention: {
    table: 'intervention',
    initial: 'ACTIVE',
    next: {
      CONSIDERED: ['AWAITING_AUTHORISATION', 'ACTIVE', 'CEASED', 'ENTERED_IN_ERROR'], AWAITING_AUTHORISATION: ['ACTIVE', 'DECLINED', 'CEASED', 'ENTERED_IN_ERROR'],
      ACTIVE: ['AWAITING_AUTHORISATION', 'CEASED', 'ENTERED_IN_ERROR'],
    },
  },
  treatment_plan: {
    table: 'treatment_plan',
    initial: 'DRAFT',
    next: {
      DRAFT: ['AWAITING_AGREEMENT', 'AGREED', 'STOPPED', 'ENTERED_IN_ERROR'], AWAITING_AGREEMENT: ['DRAFT', 'AGREED', 'ACTIVE', 'STOPPED', 'ENTERED_IN_ERROR'],
      AGREED: ['ACTIVE', 'STOPPED', 'ENTERED_IN_ERROR'], ACTIVE: ['AWAITING_AGREEMENT', 'COMPLETED', 'STOPPED', 'ENTERED_IN_ERROR'],
    },
  },
  pathway: {
    table: 'pathway_instance',
    initial: 'SUGGESTED',
    next: {
      SUGGESTED: ['ACTIVE', 'DECLINED', 'ENTERED_IN_ERROR'], ACTIVE: ['COMPLETED', 'EXITED', 'ENTERED_IN_ERROR'],
    },
  },
  checklist: {
    table: 'checklist',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['IN_PROGRESS', 'CANCELLED', 'ENTERED_IN_ERROR'], IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  recommendation: {
    table: 'recommendation',
    initial: 'RECOMMENDED',
    next: {
      RECOMMENDED: ['COMMUNICATED', 'WITHDRAWN', 'ENTERED_IN_ERROR'], COMMUNICATED: ['ACCEPTED', 'MODIFIED', 'DECLINED', 'WITHDRAWN', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'ENTERED_IN_ERROR'], MODIFIED: ['IMPLEMENTED', 'NOT_IMPLEMENTED', 'ENTERED_IN_ERROR'],
      DECLINED: ['REVIEWED', 'ENTERED_IN_ERROR'], IMPLEMENTED: ['REVIEWED', 'ENTERED_IN_ERROR'], NOT_IMPLEMENTED: ['REVIEWED', 'ENTERED_IN_ERROR'],
    },
  },
  requirement: {
    table: 'requirement',
    initial: 'PENDING',
    next: {
      PENDING: ['ASSIGNED', 'DEFERRED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      ASSIGNED: ['ASSIGNED', 'PENDING', 'ACTIONED', 'DEFERRED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      DEFERRED: ['PENDING', 'ASSIGNED', 'CANCELLED', 'CLOSED', 'ENTERED_IN_ERROR'],
      ACTIONED: ['CLOSED', 'ENTERED_IN_ERROR'], CANCELLED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  due_item: {
    table: 'due_item',
    initial: 'ACTIVE',
    next: { ACTIVE: ['COMPLETED', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  due_occurrence: {
    table: 'due_occurrence',
    initial: 'SCHEDULED',
    next: { SCHEDULED: ['COMPLETED', 'RESCHEDULED', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  recall: {
    table: 'recall',
    initial: 'SCHEDULED',
    next: {
      SCHEDULED: ['INVITED', 'EXITED', 'ENTERED_IN_ERROR'], INVITED: ['BOOKED', 'EXITED', 'ENTERED_IN_ERROR'],
      BOOKED: ['DONE', 'DID_NOT_ATTEND', 'EXITED', 'ENTERED_IN_ERROR'], DID_NOT_ATTEND: ['INVITED', 'EXITED', 'ENTERED_IN_ERROR'],
    },
  },
  followup: {
    table: 'followup',
    initial: 'REQUIRED',
    next: {
      REQUIRED: ['ACCEPTED', 'DECLINED', 'CANCELLED', 'ENTERED_IN_ERROR'], DECLINED: ['CANCELLED', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['ARRANGED', 'CANCELLED', 'ENTERED_IN_ERROR'], ARRANGED: ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      SCHEDULED: ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'ENTERED_IN_ERROR'], COMPLETED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  survplan: {
    table: 'surveillance_plan',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACTIVE', 'CEASED', 'ENTERED_IN_ERROR'] },
  },
  survcheck: {
    table: 'surveillance_check',
    initial: 'DUE',
    next: {
      DUE: ['PERFORMED', 'NOT_DONE', 'CANCELLED', 'ENTERED_IN_ERROR'], PERFORMED: ['RESULTED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      RESULTED: ['REVIEWED', 'ENTERED_IN_ERROR'], NOT_DONE: ['REVIEWED', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  screening: {
    table: 'screening',
    initial: 'ELIGIBLE',
    next: {
      ELIGIBLE: ['OFFERED', 'EXITED', 'ENTERED_IN_ERROR'], OFFERED: ['OFFERED', 'ACCEPTED', 'DECLINED', 'EXITED', 'ENTERED_IN_ERROR'],
      ACCEPTED: ['SCREENED', 'DECLINED', 'EXITED', 'ENTERED_IN_ERROR'], SCREENED: ['RESULTED', 'ENTERED_IN_ERROR'], RESULTED: ['REVIEWED', 'ENTERED_IN_ERROR'],
      REVIEWED: ['COMMUNICATED', 'ENTERED_IN_ERROR'], COMMUNICATED: ['CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  infection: {
    table: 'infection',
    initial: 'SUSPECTED',
    next: {
      SUSPECTED: ['CONFIRMED', 'NOT_INFECTION', 'ENTERED_IN_ERROR'], CONFIRMED: ['ONGOING', 'RESOLVED', 'ENTERED_IN_ERROR'],
      ONGOING: ['RESOLVED', 'ENTERED_IN_ERROR'], RESOLVED: ['RECURRED'],
    },
  },
  antimicrobial: {
    table: 'antimicrobial_course',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ACTIVE', 'CHANGED', 'COMPLETED', 'STOPPED', 'ENTERED_IN_ERROR'] },
  },
  sitecheck: {
    table: 'site_verification',
    initial: 'PLANNED',
    next: {
      PLANNED: ['DISCREPANCY', 'VERIFIED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      DISCREPANCY: ['PLANNED', 'CANCELLED', 'ENTERED_IN_ERROR'],
      VERIFIED: ['DONE', 'DISCREPANCY', 'CANCELLED', 'ENTERED_IN_ERROR'],
    },
  },
  readiness: {
    table: 'readiness',
    initial: 'ASSESSING',
    next: {
      ASSESSING: ['READY', 'CONDITIONAL', 'NOT_READY', 'CLOSED', 'ENTERED_IN_ERROR'],
      READY: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
      CONDITIONAL: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
      NOT_READY: ['ASSESSING', 'CLOSED', 'ENTERED_IN_ERROR'],
    },
  },
  report: {
    table: 'patient_report',
    initial: 'RECORDED',
    next: { RECORDED: ['REVIEWED', 'SUPERSEDED'], REVIEWED: ['SUPERSEDED'] },
  },
  coding: {
    table: 'coding_case',
    initial: 'REQUIRED',
    next: { REQUIRED: ['IN_PROGRESS'], IN_PROGRESS: ['FINALISED'], FINALISED: ['IN_PROGRESS'] },
  },
  codingquery: {
    table: 'coding_query',
    initial: 'OPEN',
    next: { OPEN: ['ANSWERED', 'WITHDRAWN'] },
  },
  external: {
    table: 'external_info',
    initial: 'RECEIVED',
    next: { RECEIVED: ['MATCHED', 'NOT_OURS'], MATCHED: ['INCORPORATED', 'REFERENCED', 'SUPERSEDED'], INCORPORATED: ['SUPERSEDED'], REFERENCED: ['SUPERSEDED'] },
  },
  commneed: {
    table: 'comm_need',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ENDED'] },
  },
  interpreter: {
    table: 'interpreter_booking',
    initial: 'REQUESTED',
    next: { REQUESTED: ['BOOKED', 'CANCELLED'], BOOKED: ['PROVIDED', 'NOT_PROVIDED', 'CANCELLED'] },
  },
  supportperson: {
    table: 'support_person',
    initial: 'ACTIVE',
    next: { ACTIVE: ['ENDED'] },
  },
  capacity: {
    table: 'capacity_assessment',
    initial: 'RAISED',
    next: { RAISED: ['DETERMINED', 'WITHDRAWN'], DETERMINED: ['SUPERSEDED'] },
  },
  preference: {
    table: 'preference',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'WITHDRAWN'] },
  },
  leave: {
    table: 'leave_of_absence',
    initial: 'REQUESTED',
    next: {
      REQUESTED: ['APPROVED', 'DECLINED', 'CANCELLED'],
      APPROVED: ['AWAY', 'CANCELLED'],
      AWAY: ['RETURNED', 'NOT_RETURNED'],
      NOT_RETURNED: ['RETURNED'],
    },
  },
  restriction: {
    table: 'restriction',
    initial: 'PROPOSED',
    next: { PROPOSED: ['ACTIVE', 'DECLINED'], ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  monitoring: {
    table: 'monitoring_plan',
    initial: 'ACTIVE',
    next: { ACTIVE: ['SUPERSEDED', 'CEASED'] },
  },
  result: {
    table: 'result',
    initial: 'AVAILABLE',
    next: { AVAILABLE: ['REVIEWED'], REVIEWED: ['ACTIONED'] },
  },
};

export interface TransitionActor {
  actorId: string | null;
  workContextId: string | null;
  transactionId?: string | null;
}

export function recordInitial(store: Store, type: string, objectId: string, state: string, a: TransitionActor, reason?: string): void {
  store.insert('state_transition', {
    id: newId(), object_type: type, object_id: objectId, from_state: null, to_state: state,
    actor_id: a.actorId, work_context_id: a.workContextId, at: now(), reason: reason ?? null, transaction_id: a.transactionId ?? null,
  });
}

export function transition(store: Store, type: string, objectId: string, to: string, a: TransitionActor, reason?: string): string {
  const lc = LIFECYCLES[type];
  if (!lc) throw new Error(`Unknown lifecycle ${type}`);
  return store.tx(() => {
    const row = store.get<{ state: string }>(`SELECT state FROM ${lc.table} WHERE id = ?`, objectId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That item no longer exists.');
    const allowed = lc.next[row.state] ?? [];
    if (!allowed.includes(to)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `This ${type} is ${row.state.toLowerCase().replace('_', ' ')} and cannot move to ${to.toLowerCase().replace('_', ' ')}.`);
    }
    store.run(`UPDATE ${lc.table} SET state = ? WHERE id = ?`, to, objectId);
    store.insert('state_transition', {
      id: newId(), object_type: type, object_id: objectId, from_state: row.state, to_state: to,
      actor_id: a.actorId, work_context_id: a.workContextId, at: now(), reason: reason ?? null, transaction_id: a.transactionId ?? null,
    });
    return row.state;
  });
}

export function history(store: Store, type: string, objectId: string) {
  return store.all<{ from_state: string | null; to_state: string; at: string; actor: string | null; reason: string | null }>(
    `SELECT t.from_state, t.to_state, t.at, w.display_name AS actor, t.reason
       FROM state_transition t LEFT JOIN workforce_person w ON w.id = t.actor_id
      WHERE t.object_type = ? AND t.object_id = ? ORDER BY t.at, t.rowid`,
    type, objectId,
  );
}
