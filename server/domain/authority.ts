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

export type Relationship = 'ENCOUNTER' | 'CARE_RELATIONSHIP' | 'EXCEPTIONAL';

export function relationship(store: Store, ctx: WorkContext, personId: string): Relationship | null {
  const enc = store.get("SELECT 1 FROM encounter WHERE person_id = ? AND service_id = ? AND state = 'ACTIVE'", personId, ctx.serviceId);
  if (enc) return 'ENCOUNTER';
  const cr = store.get('SELECT 1 FROM care_relationship WHERE person_id = ? AND service_id = ? AND ended_at IS NULL', personId, ctx.serviceId);
  if (cr) return 'CARE_RELATIONSHIP';
  const ex = store.get(
    'SELECT 1 FROM exceptional_access WHERE work_context_id = ? AND person_id = ? AND expires_at > ?',
    ctx.id, personId, now(),
  );
  return ex ? 'EXCEPTIONAL' : null;
}
