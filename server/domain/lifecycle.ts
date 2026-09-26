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
