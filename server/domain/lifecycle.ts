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
