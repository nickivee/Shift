import type { Store } from '../db/database.ts';
import { Router, Reply, type Request } from './router.ts';
import { HttpError } from '../lib/util.ts';
import * as identity from '../domain/identity.ts';
import * as record from '../domain/record.ts';
import * as commands from '../domain/commands.ts';
import * as coordination from '../domain/coordination.ts';
import * as workspace from '../domain/workspace.ts';
import * as personal from '../domain/personal.ts';
import * as knowledge from '../domain/knowledge.ts';
import * as rostering from '../domain/rostering.ts';
import * as transfers from '../domain/transfers.ts';
import * as discharges from '../domain/discharges.ts';
import * as escalations from '../domain/escalations.ts';
import * as consultations from '../domain/consultations.ts';
import * as referrals from '../domain/referrals.ts';
import * as appointments from '../domain/appointments.ts';
import * as alerts from '../domain/alerts.ts';
import * as communications from '../domain/communications.ts';
import * as monitoring from '../domain/monitoring.ts';
import * as restrictions from '../domain/restrictions.ts';
import * as leave from '../domain/leave.ts';
import * as preferences from '../domain/preferences.ts';
import * as capacity from '../domain/capacity.ts';
import * as whanau from '../domain/whanau.ts';
import * as access from '../domain/access.ts';
import * as external from '../domain/external.ts';
import * as reconcile from '../domain/reconcile.ts';
import * as coding from '../domain/coding.ts';
import * as reports from '../domain/reports.ts';
import * as questionnaires from '../domain/questionnaires.ts';
import * as functional from '../domain/functional.ts';
import * as usual from '../domain/usual.ts';
import * as assignments from '../domain/assignments.ts';
import * as allocations from '../domain/allocations.ts';
import * as acuity from '../domain/acuity.ts';
import * as deterioration from '../domain/deterioration.ts';
import * as incidents from '../domain/incidents.ts';
import * as deaths from '../domain/deaths.ts';
import * as problems from '../domain/problems.ts';
import * as symptoms from '../domain/symptoms.ts';
import * as interventions from '../domain/interventions.ts';
import * as treatmentplans from '../domain/treatmentplans.ts';
import * as pathways from '../domain/pathways.ts';
import * as checklists from '../domain/checklists.ts';
import * as recommendations from '../domain/recommendations.ts';
import * as requirements from '../domain/requirements.ts';
import * as careDue from '../domain/caredue.ts';
import * as recalls from '../domain/recalls.ts';
import * as followups from '../domain/followups.ts';
import * as surveillance from '../domain/surveillance.ts';
import * as screening from '../domain/screening.ts';
import * as infections from '../domain/infections.ts';
import * as isolation from '../domain/isolation.ts';
import * as allergies from '../domain/allergies.ts';
import * as consent from '../domain/consent.ts';
import * as endoflife from '../domain/endoflife.ts';
import * as safeguarding from '../domain/safeguarding.ts';
import * as residency from '../domain/residency.ts';
import * as complaints from '../domain/complaints.ts';
import * as devices from '../domain/devices.ts';
import * as handovers from '../domain/handovers.ts';
import * as conferences from '../domain/conferences.ts';
import * as rehab from '../domain/rehab.ts';
import * as diagnostics from '../domain/diagnostics.ts';
import * as procedures from '../domain/procedures.ts';
import * as decisions from '../domain/decisions.ts';
import * as poisoning from '../domain/poisoning.ts';
import * as trauma from '../domain/trauma.ts';
import * as feeding from '../domain/feeding.ts';
import * as antimicrobials from '../domain/antimicrobials.ts';
import * as siteverify from '../domain/siteverify.ts';
import * as readiness from '../domain/readiness.ts';
import * as variances from '../domain/variances.ts';
import * as declined from '../domain/declined.ts';
import * as priorities from '../domain/priorities.ts';
import * as identitymatch from '../domain/identitymatch.ts';
import * as duplicates from '../domain/duplicates.ts';
import * as breakglass from '../domain/breakglass.ts';
import * as delegation from '../domain/delegation.ts';
import * as workqueue from '../domain/workqueue.ts';
import * as downtime from '../domain/downtime.ts';
import * as diets from '../domain/diets.ts';
import * as equipment from '../domain/equipment.ts';
import * as locations from '../domain/locations.ts';
import * as wounds from '../domain/wounds.ts';
import * as careplans from '../domain/careplans.ts';
import { KEYS, VIEWS, EMBEDS } from '../config/keys.ts';
import { LEGAL_REGISTER, RESEARCH_REQUIREMENTS, ORG_RULE_PACK } from '../config/legal.ts';

const COOKIE = 'shift_session';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 50).map(String) : []);

export function buildApi(store: Store): Router {
  const r = new Router();

  const session = (req: Request) => {
    const s = identity.resolveSession(store, req.cookies[COOKIE]);
    if (!s) throw new HttpError(401, 'SIGNED_OUT', 'Your session has ended. Sign in again.');
    return s;
  };
  const work = (req: Request) => {
    const s = session(req);
    const ctx = identity.activeContext(store, s);
    if (!ctx) throw new HttpError(409, 'NO_CONTEXT', 'Choose your WORK context first.');
    return ctx;
  };
  const cookie = (req: Request, value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

  // Authentication ---------------------------------------------------------------------
  r.on('POST', '/api/auth/login', (req) => {
    const { token, session: s } = identity.login(store, str(req.body.username), str(req.body.password));
    return new Reply({ worker: { name: s.displayName } }, { cookies: [cookie(req, token, 12 * 3600)] });
  });
  r.on('POST', '/api/auth/logout', (req) => {
    const s = identity.resolveSession(store, req.cookies[COOKIE]);
    if (s) identity.endSession(store, s.id, s.workerId, 'SIGNED_OUT');
    return new Reply({ ok: true }, { cookies: [cookie(req, '', 0)] });
  });
  r.on('GET', '/api/me', (req) => {
    const s = identity.resolveSession(store, req.cookies[COOKIE]);
    if (!s) return null;
    const ctx = identity.activeContext(store, s);
    return {
      worker: { name: s.displayName },
      positions: identity.positionOptions(store, s.workerId),
      context: ctx && contextView(ctx),
    };
  });

  // WORK context -------------------------------------------------------------------------
  r.on('POST', '/api/work/context', (req) => contextView(identity.establishContext(store, session(req), str(req.body.positionId))));
  r.on('DELETE', '/api/work/context', (req) => {
    identity.leaveContext(store, session(req));
    return { ok: true };
  });
  r.on('GET', '/api/work/config', (req) => {
    const ctx = work(req);
    return {
      keys: KEYS.filter((k) => ctx.role.keys.includes(k.code)),
      views: workspace.shownViews(store, ctx).flatMap(({ id, hidden }) => {
        const v = VIEWS.find((x) => x.code === id);
        return !v ? [] : [{ code: v.code, label: v.label, key: v.key ?? null, shown: !hidden, own: !ctx.role.ownViews || ctx.role.ownViews.includes(v.code) }];
      }),
      // Screens that also show inside another screen, where the role has both.
      embeds: Object.fromEntries(Object.entries(EMBEDS).map(([host, inner]) => [host, inner.filter((c) => ctx.role.views.includes(c))]).filter(([, inner]) => inner.length)),
      tabs: ctx.role.tabs,
      destinations: commands.destinationsFor(store, ctx),
      restrictions: commands.capabilitiesSummary(store, ctx),
    };
  });
  r.on('GET', '/api/work/home', (req) => workspace.homeFor(store, work(req)));
  r.on('PUT', '/api/work/home', (req) => workspace.saveHome(store, work(req), req.body as never));
  r.on('DELETE', '/api/work/home', (req) => workspace.saveHome(store, work(req), null));
  r.on('PUT', '/api/work/screens', (req) => workspace.saveViews(store, work(req), req.body as never));

  // Patient records ----------------------------------------------------------------------
  r.on('GET', '/api/work/patients', (req) => record.patientList(store, work(req)));
  r.on('GET', '/api/work/search', (req) => record.search(store, work(req), req.query.get('q') ?? ''));
  r.on('POST', '/api/work/patients/:id/exceptional-access', (req) => breakglass.request(store, work(req), req.params.id, {
    kind: str(req.body.kind), reason: str(req.body.reason), consent: str(req.body.consent), approverId: str(req.body.approverId),
  }));
  r.on('GET', '/api/work/patients/:id', (req) => record.header(store, work(req), req.params.id));
  r.on('GET', '/api/work/patients/:id/views/:code', (req) => record.retrieve(store, work(req), req.params.id, req.params.code));
  r.on('GET', '/api/work/events/:id', (req) => record.eventDetail(store, work(req), req.params.id));
  r.on('POST', '/api/work/events/:id/amend', (req) =>
    commands.amend(store, work(req), req.params.id, { fields: req.body.fields as Record<string, unknown>, reason: str(req.body.reason), enteredInError: req.body.enteredInError === true }),
  );
  r.on('POST', '/api/work/commands', (req) => {
    const b = req.body;
    return commands.execute(store, work(req), {
      personId: str(b.personId),
      key: str(b.key) || undefined,
      fields: (b.fields && typeof b.fields === 'object' ? b.fields : undefined) as Record<string, unknown> | undefined,
      eventId: str(b.eventId) || undefined,
      destinations: Array.isArray(b.destinations) ? b.destinations.map(String) : [],
      handover: b.handover === true,
      urgent: b.urgent === true,
      from: str(b.from) || null,
      to: str(b.to) || null,
      downtime: b.downtime && typeof b.downtime === 'object' ? b.downtime as Record<string, unknown> : null,
      idempotencyKey: str(b.idempotencyKey),
    });
  });

  // Coordination -------------------------------------------------------------------------
  r.on('GET', '/api/work/received', (req) => coordination.received(store, work(req)));
  r.on('POST', '/api/work/routes/:id/:action', (req) => coordination.routeAction(store, work(req), req.params.id, req.params.action, str(req.body.note)));
  r.on('GET', '/api/work/tasks', (req) => coordination.taskList(store, work(req)));
  r.on('GET', '/api/work/queue', (req) => workqueue.queue(store, work(req)));
  r.on('GET', '/api/work/downtime', (req) => downtime.list(store, work(req)));
  r.on('GET', '/api/work/downtime/now', (req) => downtime.current(store, work(req)));
  r.on('POST', '/api/work/downtime', (req) => downtime.declare(store, work(req), { functions: req.body.functions, reason: str(req.body.reason), startedAgo: Number(req.body.startedAgo) }));
  r.on('POST', '/api/work/downtime/:id/:action', (req) => downtime.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), checkId: str(req.body.checkId), outcome: str(req.body.outcome) }));
  r.on('POST', '/api/work/queue/:id/:action', (req) => workqueue.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), minutes: Number(req.body.minutes) }));
  r.on('POST', '/api/work/tasks/:id/:action', (req) => coordination.taskAction(store, work(req), req.params.id, req.params.action, str(req.body.note)));
  r.on('GET', '/api/work/handover', (req) => coordination.handoverBoard(store, work(req)));
  r.on('POST', '/api/work/handover/:id/:action', (req) => {
    const a = req.params.action;
    if (a !== 'receive' && a !== 'review' && a !== 'clear') throw new HttpError(400, 'UNKNOWN_ACTION', 'Unknown action.');
    return coordination.handoverAction(store, work(req), req.params.id, a);
  });
  r.on('POST', '/api/work/results/:id/review', (req) => coordination.reviewResult(store, work(req), req.params.id));

  // Doctors' shared knowledge ------------------------------------------------------------
  r.on('GET', '/api/work/knowledge', (req) => knowledge.listQuestions(store, work(req)));
  r.on('POST', '/api/work/knowledge', (req) => knowledge.ask(store, work(req), str(req.body.topic), str(req.body.body)));
  r.on('GET', '/api/work/knowledge/:id', (req) => knowledge.question(store, work(req), req.params.id));
  r.on('POST', '/api/work/knowledge/:id/replies', (req) => knowledge.reply(store, work(req), req.params.id, str(req.body.body)));
  r.on('POST', '/api/work/knowledge/:id/close', (req) => knowledge.closeQuestion(store, work(req), req.params.id, req.body.withdraw === true));

  // Personal Notes -----------------------------------------------------------------------
  r.on('GET', '/api/notes', (req) => workspace.notes(store, session(req), req.query.get('dismissed') === '1'));
  r.on('POST', '/api/notes', (req) => workspace.saveNote(store, session(req), null, str(req.body.body)));
  r.on('PUT', '/api/notes/:id', (req) => workspace.saveNote(store, session(req), req.params.id, str(req.body.body)));
  r.on('POST', '/api/notes/:id/dismiss', (req) => workspace.dismissNote(store, session(req), req.params.id));
  r.on('POST', '/api/notes/:id/restore', (req) => workspace.dismissNote(store, session(req), req.params.id, true));

  // Rostering decisions (WORK) ----------------------------------------------------------
  r.on('GET', '/api/work/transfers', (req) => transfers.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/transfers', (req) => transfers.request(store, work(req), req.params.id, { toServiceId: str(req.body.toServiceId), reason: str(req.body.reason), priority: str(req.body.priority) }));
  r.on('GET', '/api/work/transfers/:id/beds', (req) => transfers.bedsFor(store, work(req), req.params.id));
  r.on('POST', '/api/work/transfers/:id/:action', (req) => transfers.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), bedId: str(req.body.bedId) }));
  r.on('GET', '/api/work/careplan-reviews', (req) => careplans.due(store, work(req)));
  r.on('POST', '/api/work/patients/:id/careplan', (req) => careplans.add(store, work(req), req.params.id, req.body as never));
  r.on('POST', '/api/work/careplan/:id/review', (req) => careplans.review(store, work(req), req.params.id, req.body as never));
  r.on('GET', '/api/work/wounds', (req) => wounds.reviews(store, work(req)));
  r.on('POST', '/api/work/patients/:id/wounds', (req) => wounds.identify(store, work(req), req.params.id, { site: str(req.body.site), kind: str(req.body.kind), description: str(req.body.description) }));
  r.on('POST', '/api/work/wounds/:id/assess', (req) => wounds.assess(store, work(req), req.params.id, req.body as Record<string, unknown>));
  r.on('POST', '/api/work/wounds/:id/:action', (req) => wounds.act(store, work(req), req.params.id, req.params.action, { plan: str(req.body.plan), reviewDays: req.body.reviewDays, note: str(req.body.note) }));
  r.on('GET', '/api/work/consultations', (req) => consultations.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/consultations', (req) => consultations.request(store, work(req), req.params.id, { target: str(req.body.target), question: str(req.body.question), urgency: str(req.body.urgency) }));
  r.on('GET', '/api/work/monitoring', (req) => monitoring.list(store, work(req)));
  const planFields = (b: Record<string, unknown>) => ({
    parameter: str(b.parameter), reason: str(b.reason), method: str(b.method), frequency: str(String(b.frequency ?? '')), limits: str(b.limits),
    target: str(b.target), responsible: str(b.responsible), reviewDate: str(b.reviewDate),
  });
  r.on('POST', '/api/work/patients/:id/monitoring', (req) => monitoring.start(store, work(req), req.params.id, planFields(req.body)));
  r.on('POST', '/api/work/monitoring/:id/review', (req) => monitoring.review(store, work(req), req.params.id, {
    ...planFields(req.body), outcome: str(req.body.outcome), finding: str(req.body.finding), action: str(req.body.action),
  }));
  const whanauFields = (b: Record<string, unknown>) => ({
    name: str(b.name), relationship: str(b.relationship), relationshipNote: str(b.relationshipNote), phone: str(b.phone),
    firstContact: b.firstContact === true || b.firstContact === 'true', wishes: str(b.wishes), share: str(b.share), involve: str(b.involve),
    limits: str(b.limits), authority: str(b.authority), authorityRef: str(b.authorityRef),
  });
  r.on('GET', '/api/work/whanau', (req) => whanau.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/whanau', (req) => whanau.add(store, work(req), req.params.id, whanauFields(req.body)));
  r.on('POST', '/api/work/whanau/:id/:action', (req) => whanau.act(store, work(req), req.params.id, req.params.action, {
    ...whanauFields(req.body), kind: str(req.body.kind), summary: str(req.body.summary), shared: str(req.body.shared), note: str(req.body.note),
  }));
  const needFields = (b: Record<string, unknown>) => ({
    kind: str(b.kind), language: str(b.language), detail: str(b.detail), whenNeeded: str(b.whenNeeded), reviewDate: str(b.reviewDate),
  });
  r.on('GET', '/api/work/interpreters', (req) => access.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/needs', (req) => access.addNeed(store, work(req), req.params.id, needFields(req.body)));
  r.on('POST', '/api/work/needs/:id/:action', (req) => access.actNeed(store, work(req), req.params.id, req.params.action, {
    ...needFields(req.body), note: str(req.body.note), purpose: str(req.body.purpose), mode: str(req.body.mode), neededAt: str(req.body.neededAt),
  }));
  r.on('POST', '/api/work/interpreters/:id/:action', (req) => access.actBooking(store, work(req), req.params.id, req.params.action, {
    provider: str(req.body.provider), reference: str(req.body.reference), interpreter: str(req.body.interpreter), outcome: str(req.body.outcome),
    familyInterpreted: req.body.familyInterpreted === true || req.body.familyInterpreted === 'true', note: str(req.body.note),
  }));
  const receivedFields = (b: Record<string, unknown>) => ({
    sourceOrg: str(b.sourceOrg), sourceAuthor: str(b.sourceAuthor), kind: str(b.kind), channel: str(b.channel), writtenAt: str(b.writtenAt),
    title: str(b.title), content: str(b.content), statedName: str(b.statedName), statedNhi: str(b.statedNhi), statedDob: str(b.statedDob),
  });
  r.on('GET', '/api/work/external', (req) => external.list(store, work(req)));
  r.on('POST', '/api/work/external', (req) => external.receive(store, work(req), receivedFields(req.body)));
  r.on('POST', '/api/work/patients/:id/external', (req) => external.receiveFor(store, work(req), req.params.id, receivedFields(req.body)));
  r.on('POST', '/api/work/external/:id/facts', (req) => (reconcile.addFact(store, work(req), req.params.id, {
    kind: str(req.body.kind), name: str(req.body.name), detail: str(req.body.detail), severity: str(req.body.severity),
  }), { ok: true }));
  r.on('POST', '/api/work/external/:id/facts/:fact/remove', (req) => (reconcile.removeFact(store, work(req), req.params.id, req.params.fact), { ok: true }));
  r.on('POST', '/api/work/external/:id/reconcile', (req) => (reconcile.decide(store, work(req), req.params.id, {
    key: str(req.body.key), decision: str(req.body.decision), note: str(req.body.note), certainty: str(req.body.certainty),
  }), { ok: true }));
  r.on('POST', '/api/work/external/:id/:action', (req) => external.act(store, work(req), req.params.id, req.params.action, {
    ...receivedFields(req.body), personId: str(req.body.personId), summary: str(req.body.summary), outcome: str(req.body.outcome),
    outcomeNote: str(req.body.outcomeNote), note: str(req.body.note),
  }));
  const reportFields = (b: Record<string, unknown>) => ({
    source: str(b.source), sourceName: str(b.sourceName), how: str(b.how), topic: str(b.topic), words: str(b.words),
    rating: typeof b.rating === 'number' ? b.rating : str(b.rating), aboutWhen: str(b.aboutWhen), reportedAt: str(b.reportedAt),
    needsReview: b.needsReview === true || b.needsReview === 'true',
  });
  r.on('GET', '/api/work/delegation', (req) => delegation.list(store, work(req)));
  r.on('GET', '/api/work/delegation/options', (req) => delegation.options(store, work(req), req.query.get('activity') ?? undefined));
  r.on('POST', '/api/work/delegation', (req) => delegation.give(store, work(req), {
    personId: str(req.body.personId), activity: str(req.body.activity), delegateId: str(req.body.delegateId), instructions: str(req.body.instructions),
    reportIf: str(req.body.reportIf), hours: Number(req.body.hours), competent: req.body.competent === true,
  }));
  r.on('POST', '/api/work/delegation/:id/:action', (req) => delegation.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), outcome: str(req.body.outcome) }));
  r.on('GET', '/api/work/breakglass', (req) => breakglass.list(store, work(req)));
  r.on('GET', '/api/work/breakglass/options', (req) => breakglass.options(store, work(req)));
  r.on('POST', '/api/work/breakglass/:id/:action', (req) => breakglass.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), outcome: str(req.body.outcome) }));
  r.on('GET', '/api/work/duplicates', (req) => duplicates.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/duplicates', (req) => duplicates.flag(store, work(req), req.params.id, { otherId: str(req.body.otherId), reason: str(req.body.reason) }));
  r.on('POST', '/api/work/duplicates/:id/:action', (req) => duplicates.act(store, work(req), req.params.id, req.params.action, {
    keep: str(req.body.keep), note: str(req.body.note), from: str(req.body.from),
  }));
  r.on('GET', '/api/work/arrivals', (req) => identitymatch.list(store, work(req)));
  r.on('POST', '/api/work/arrivals/find', (req) => identitymatch.find(store, work(req), req.body as Record<string, unknown>));
  r.on('POST', '/api/work/arrivals', (req) => identitymatch.register(store, work(req), req.body as Record<string, unknown>));
  r.on('POST', '/api/work/identity/:id/:action', (req) => identitymatch.act(store, work(req), req.params.id, req.params.action, req.body as Record<string, unknown>));
  r.on('GET', '/api/work/priorities', (req) => priorities.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/priorities', (req) => priorities.assign(store, work(req), req.params.id, {
    source: str(req.body.source), what: str(req.body.what), evidence: str(req.body.evidence), level: str(req.body.level),
  }));
  r.on('POST', '/api/work/priorities/:id/:action', (req) => priorities.act(store, work(req), req.params.id, req.params.action, {
    level: str(req.body.level), evidence: str(req.body.evidence), note: str(req.body.note),
  }));
  r.on('GET', '/api/work/declined', (req) => declined.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/declined', (req) => declined.record(store, work(req), req.params.id, {
    category: str(req.body.category), offered: str(req.body.offered), information: str(req.body.information), decidedBy: str(req.body.decidedBy),
    representative: str(req.body.representative), capacityConcern: str(req.body.capacityConcern), reason: str(req.body.reason),
    implications: str(req.body.implications), risk: str(req.body.risk), plan: str(req.body.plan), reofferBy: str(req.body.reofferBy), offeredAt: str(req.body.offeredAt),
  }));
  r.on('POST', '/api/work/declined/:id/:action', (req) => declined.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), to: str(req.body.to), outcome: str(req.body.outcome), plan: str(req.body.plan), reofferBy: str(req.body.reofferBy),
  }));
  r.on('GET', '/api/work/variances', (req) => variances.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/variances', (req) => variances.record(store, work(req), req.params.id, {
    category: str(req.body.category), expected: str(req.body.expected), whatHappened: str(req.body.whatHappened), reason: str(req.body.reason),
    context: str(req.body.context), occurredAt: str(req.body.occurredAt),
  }));
  r.on('POST', '/api/work/variances/:id/:action', (req) => variances.act(store, work(req), req.params.id, req.params.action, {
    decision: str(req.body.decision), action: str(req.body.action), note: str(req.body.note), followUp: str(req.body.followUp),
    followUpBy: str(req.body.followUpBy), watch: str(req.body.watch),
  }));
  r.on('GET', '/api/work/readiness', (req) => readiness.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/readiness', (req) => readiness.raise(store, work(req), req.params.id, {
    kind: str(req.body.kind), purpose: str(req.body.purpose), neededBy: str(req.body.neededBy), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/readiness/:id/:action', (req) => readiness.act(store, work(req), req.params.id, req.params.action, {
    itemId: str(req.body.itemId), status: str(req.body.status), label: str(req.body.label), essential: str(req.body.essential), decision: str(req.body.decision),
    note: str(req.body.note), conditions: str(req.body.conditions), reassessBy: str(req.body.reassessBy), reason: str(req.body.reason),
  }));
  r.on('GET', '/api/work/sitechecks', (req) => siteverify.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/sitechecks', (req) => siteverify.plan(store, work(req), req.params.id, {
    procedure: str(req.body.procedure), plannedFor: str(req.body.plannedFor), site: str(req.body.site), side: str(req.body.side), detail: str(req.body.detail),
  }));
  r.on('POST', '/api/work/sitechecks/:id/:action', (req) => siteverify.act(store, work(req), req.params.id, req.params.action, {
    kind: str(req.body.kind), source: str(req.body.source), outcome: str(req.body.outcome), stated: str(req.body.stated), note: str(req.body.note),
    keep: str(req.body.keep), site: str(req.body.site), side: str(req.body.side), detail: str(req.body.detail), when: str(req.body.when),
    ref: str(req.body.ref), matched: str(req.body.matched),
  }));
  r.on('GET', '/api/work/antimicrobials', (req) => antimicrobials.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/antimicrobials', (req) => antimicrobials.start(store, work(req), req.params.id, {
    infectionId: str(req.body.infectionId), indication: str(req.body.indication), agent: str(req.body.agent), route: str(req.body.route), dose: str(req.body.dose),
    orderRef: str(req.body.orderRef), days: str(req.body.days), reviewBy: str(req.body.reviewBy), intent: str(req.body.intent), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/antimicrobials/:id/:action', (req) => antimicrobials.act(store, work(req), req.params.id, req.params.action, {
    micro: str(req.body.micro), note: str(req.body.note), decision: str(req.body.decision), change: str(req.body.change), reason: str(req.body.reason),
    outcome: str(req.body.outcome), agent: str(req.body.agent), route: str(req.body.route), dose: str(req.body.dose), orderRef: str(req.body.orderRef),
    days: str(req.body.days), reviewBy: str(req.body.reviewBy), intent: str(req.body.intent),
  }));
  r.on('GET', '/api/work/infections', (req) => ({ ...infections.list(store, work(req)), isolation: isolation.forService(store, work(req)) }));
  r.on('POST', '/api/work/patients/:id/feeding', (req) => feeding.start(store, work(req), req.params.id, {
    deviceId: str(req.body.deviceId), feed: str(req.body.feed), method: str(req.body.method), regimen: str(req.body.regimen), flushes: str(req.body.flushes),
    targetMl: str(req.body.targetMl), oral: str(req.body.oral), prescribedBy: str(req.body.prescribedBy), reason: str(req.body.reason), reviewDate: str(req.body.reviewDate),
  }));
  r.on('POST', '/api/work/feeding/:id/:action', (req) => feeding.act(store, work(req), req.params.id, req.params.action, {
    kind: str(req.body.kind), ml: str(req.body.ml), tolerance: str(req.body.tolerance), note: str(req.body.note), outcome: str(req.body.outcome), finding: str(req.body.finding),
    deviceId: str(req.body.deviceId), feed: str(req.body.feed), method: str(req.body.method), regimen: str(req.body.regimen), flushes: str(req.body.flushes),
    targetMl: str(req.body.targetMl), oral: str(req.body.oral), prescribedBy: str(req.body.prescribedBy), reviewDate: str(req.body.reviewDate),
  }));
  r.on('POST', '/api/work/patients/:id/trauma', (req) => trauma.activate(store, work(req), req.params.id, {
    teamCall: str(req.body.teamCall), mechanism: str(req.body.mechanism), injuredAt: str(req.body.injuredAt), prehospital: str(req.body.prehospital),
  }));
  r.on('POST', '/api/work/trauma/:id/:action', (req) => trauma.act(store, work(req), req.params.id, req.params.action, {
    airway: str(req.body.airway), breathing: str(req.body.breathing), circulation: str(req.body.circulation), disability: str(req.body.disability), exposure: str(req.body.exposure),
    findings: str(req.body.findings), actions: str(req.body.actions), injury: str(req.body.injury), foundBy: str(req.body.foundBy), next: str(req.body.next), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/patients/:id/poisoning', (req) => poisoning.record(store, work(req), req.params.id, {
    substances: str(req.body.substances), amount: str(req.body.amount), route: str(req.body.route), takenAt: str(req.body.takenAt), timeKnown: str(req.body.timeKnown),
    intent: str(req.body.intent), source: str(req.body.source),
  }));
  r.on('POST', '/api/work/poisoning/:id/:action', (req) => poisoning.act(store, work(req), req.params.id, req.params.action, {
    from: str(req.body.from), who: str(req.body.who), advice: str(req.body.advice), plan: str(req.body.plan), watchUntil: str(req.body.watchUntil),
    checks: Array.isArray(req.body.checks) ? req.body.checks.slice(0, 6).map((c: any) => ({ what: str(c?.what), dueAt: str(c?.dueAt) })) : [],
    checkId: str(req.body.checkId), safety: str(req.body.safety), note: str(req.body.note), admittedTo: str(req.body.admittedTo),
  }));
  r.on('POST', '/api/work/patients/:id/decisions', (req) => decisions.raise(store, work(req), req.params.id, { question: str(req.body.question), background: str(req.body.background) }));
  r.on('POST', '/api/work/decisions/:id/:action', (req) => decisions.act(store, work(req), req.params.id, req.params.action, {
    option: str(req.body.option), benefits: str(req.body.benefits), risks: str(req.body.risks), theirView: str(req.body.theirView), tookPart: str(req.body.tookPart),
    tookPartNote: str(req.body.tookPartNote), others: str(req.body.others), chosen: str(req.body.chosen), reason: str(req.body.reason), agreed: str(req.body.agreed),
    reviewOn: str(req.body.reviewOn), still: str(req.body.still), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/patients/:id/procedures', (req) => procedures.propose(store, work(req), req.params.id, { what: str(req.body.what), why: str(req.body.why) }));
  r.on('POST', '/api/work/procedures/:id/:action', (req) => procedures.act(store, work(req), req.params.id, req.params.action, {
    when: str(req.body.when), place: str(req.body.place), operator: str(req.body.operator), consent: str(req.body.consent), noConsent: str(req.body.noConsent),
    noConsentNote: str(req.body.noConsentNote), site: str(req.body.site), how: str(req.body.how), findings: str(req.body.findings), complications: str(req.body.complications),
    recoveryPlan: str(req.body.recoveryPlan), outcome: str(req.body.outcome), followUpOn: str(req.body.followUpOn), followUpWhat: str(req.body.followUpWhat), note: str(req.body.note), siteMatched: str(req.body.siteMatched),
  }));
  r.on('POST', '/api/work/patients/:id/tests', (req) => diagnostics.order(store, work(req), req.params.id, { test: str(req.body.test), priority: str(req.body.priority), reason: str(req.body.reason) }));
  r.on('POST', '/api/work/tests/:id/:action', (req) => diagnostics.orderAct(store, work(req), req.params.id, req.params.action, { idChecked: str(req.body.idChecked), note: str(req.body.note) }));
  r.on('POST', '/api/work/patients/:id/results', (req) => diagnostics.receive(store, work(req), req.params.id, {
    orderId: str(req.body.orderId), test: str(req.body.test), value: str(req.body.value), units: str(req.body.units), range: str(req.body.range),
    critical: str(req.body.critical), readBack: str(req.body.readBack), from: str(req.body.from), toldDoctor: str(req.body.toldDoctor),
  }));
  r.on('POST', '/api/work/results/:id/acknowledge', (req) => diagnostics.resultAct(store, work(req), req.params.id, 'acknowledge', { plan: str(req.body.plan), doctor: str(req.body.doctor) }));
  r.on('POST', '/api/work/results/:id/correct', (req) => diagnostics.resultAct(store, work(req), req.params.id, 'correct', {
    value: str(req.body.value), reason: str(req.body.reason), from: str(req.body.from), critical: str(req.body.critical),
  }));
  r.on('POST', '/api/work/patients/:id/rehab', (req) => rehab.start(store, work(req), req.params.id));
  r.on('POST', '/api/work/rehab/:id/:action', (req) => rehab.act(store, work(req), req.params.id, req.params.action, {
    ready: str(req.body.ready), reason: str(req.body.reason), recheck: str(req.body.recheck), baseline: str(req.body.baseline), plan: str(req.body.plan),
    perWeek: Number(req.body.perWeek),
    goals: Array.isArray(req.body.goals) ? (req.body.goals as Record<string, unknown>[]).slice(0, 8).map((g) => ({ goal: str(g?.goal), carePlanItem: str(g?.carePlanItem) })) : [],
    delivered: str(req.body.delivered), done: str(req.body.done), response: str(req.body.response), note: str(req.body.note),
    goalStates: req.body.goalStates && typeof req.body.goalStates === 'object' ? Object.fromEntries(Object.entries(req.body.goalStates as Record<string, unknown>).map(([k, v]) => [k, str(v)])) : {},
    needs: str(req.body.needs), nextKind: str(req.body.nextKind), nextTo: str(req.body.nextTo), summary: str(req.body.summary), outcome: str(req.body.outcome),
  }));
  r.on('POST', '/api/work/patients/:id/conferences', (req) => conferences.plan(store, work(req), req.params.id, {
    kind: str(req.body.kind), reason: str(req.body.reason), when: str(req.body.when), invite: list(req.body.invite), others: str(req.body.others),
  }));
  r.on('POST', '/api/work/conference-actions/:id/done', (req) => conferences.actionDone(store, work(req), req.params.id, { note: str(req.body.note) }));
  r.on('POST', '/api/work/conferences/:id/:action', (req) => conferences.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), attended: list(req.body.attended), patientThere: str(req.body.patientThere), othersThere: str(req.body.othersThere),
    evidence: list(req.body.evidence), evidenceNote: str(req.body.evidenceNote), discussion: str(req.body.discussion), followUp: str(req.body.followUp),
    actions: Array.isArray(req.body.actions) ? (req.body.actions as Record<string, unknown>[]).slice(0, 20).map((x) => ({
      decision: str(x?.decision), action: str(x?.action), owner: str(x?.owner), ownerLabel: str(x?.ownerLabel), due: str(x?.due),
    })) : [],
  }));
  r.on('GET', '/api/work/handovers/mine', (req) => handovers.mine(store, work(req)));
  r.on('POST', '/api/work/patients/:id/handovers', (req) => handovers.give(store, work(req), req.params.id, {
    to: str(req.body.to), situation: str(req.body.situation), background: str(req.body.background), watch: str(req.body.watch), todo: str(req.body.todo),
  }));
  r.on('POST', '/api/work/handovers/:id/:action', (req) => handovers.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note) }));
  r.on('POST', '/api/work/patients/:id/devices', (req) => devices.insert(store, work(req), req.params.id, {
    kind: str(req.body.kind), site: str(req.body.site), size: str(req.body.size), reason: str(req.body.reason), hoursAgo: req.body.hoursAgo, where: str(req.body.where), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/devices/:id/:action', (req) => devices.act(store, work(req), req.params.id, req.params.action, {
    how: str(req.body.how), note: str(req.body.note), siteLook: str(req.body.siteLook), needed: str(req.body.needed), reasonRemoved: str(req.body.reasonRemoved), intact: str(req.body.intact),
  }));
  r.on('POST', '/api/work/patients/:id/complaints', (req) => complaints.receive(store, work(req), req.params.id, {
    fromKind: str(req.body.fromKind), fromName: str(req.body.fromName), contact: str(req.body.contact), how: str(req.body.how), about: str(req.body.about), words: str(req.body.words), wants: str(req.body.wants),
  }));
  r.on('POST', '/api/work/complaints/:id/:action', (req) => complaints.act(store, work(req), req.params.id, req.params.action, {
    ackHow: str(req.body.ackHow), advocacy: req.body.advocacy, replyDays: req.body.replyDays, note: str(req.body.note), response: str(req.body.response), change: str(req.body.change), outcome: str(req.body.outcome),
  }));
  r.on('POST', '/api/work/patients/:id/residency', (req) => residency.start(store, work(req), req.params.id, {
    kind: str(req.body.kind), here: req.body.here, room: str(req.body.room), level: str(req.body.level), source: str(req.body.source), levelOn: str(req.body.levelOn), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/residency/:id/:action', (req) => residency.act(store, work(req), req.params.id, req.params.action, {
    room: str(req.body.room), level: str(req.body.level), source: str(req.body.source), levelOn: str(req.body.levelOn), note: str(req.body.note), where: str(req.body.where), reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/patients/:id/safeguarding', (req) => safeguarding.raise(store, work(req), req.params.id, {
    kind: str(req.body.kind), how: str(req.body.how), concern: str(req.body.concern), involved: str(req.body.involved), share: str(req.body.share), wishes: str(req.body.wishes),
  }));
  r.on('POST', '/api/work/safeguarding/:id/:action', (req) => safeguarding.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), risk: str(req.body.risk), to: str(req.body.to), why: str(req.body.why), followDays: req.body.followDays, share: str(req.body.share), reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/patients/:id/end-of-life', (req) => endoflife.start(store, work(req), req.params.id, {
    basis: str(req.body.basis), agreedWith: str(req.body.agreedWith), discussed: str(req.body.discussed), placeCare: str(req.body.placeCare), placeDeath: str(req.body.placeDeath),
    wishes: str(req.body.wishes), call: str(req.body.call), anticipatory: str(req.body.anticipatory), reviewHours: req.body.reviewHours,
  }));
  r.on('POST', '/api/work/end-of-life/:id/:action', (req) => endoflife.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), placeCare: str(req.body.placeCare), placeDeath: str(req.body.placeDeath), wishes: str(req.body.wishes), call: str(req.body.call),
    reviewHours: req.body.reviewHours, whanauTold: str(req.body.whanauTold), reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/patients/:id/consents', (req) => consent.record(store, work(req), req.params.id, {
    what: str(req.body.what), kind: str(req.body.kind), decision: str(req.body.decision), information: str(req.body.information), understood: str(req.body.understood),
    support: str(req.body.support), form: str(req.body.form), formRef: str(req.body.formRef), theirWords: str(req.body.theirWords), capacityId: str(req.body.capacityId),
  }));
  r.on('POST', '/api/work/consents/:id/:action', (req) => consent.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note) }));
  r.on('POST', '/api/work/patients/:id/allergies', (req) => allergies.record(store, work(req), req.params.id, {
    kind: str(req.body.kind), category: str(req.body.category), substance: str(req.body.substance), reaction: str(req.body.reaction),
    severity: str(req.body.severity), certainty: str(req.body.certainty), source: str(req.body.source), onset: str(req.body.onset),
  }));
  r.on('POST', '/api/work/patients/:id/allergies/none-known', (req) => allergies.noKnown(store, work(req), req.params.id, { asked: str(req.body.asked), note: str(req.body.note) }));
  r.on('POST', '/api/work/allergies/:id/:action', (req) => allergies.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), kind: str(req.body.kind), severity: str(req.body.severity), reaction: str(req.body.reaction), category: str(req.body.category), reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/patients/:id/precautions', (req) => isolation.start(store, work(req), req.params.id, {
    concern: str(req.body.concern), types: req.body.types, room: str(req.body.room), reviewHours: req.body.reviewHours, infectionId: str(req.body.infectionId), outbreakId: str(req.body.outbreakId),
  }));
  r.on('POST', '/api/work/precautions/:id/:action', (req) => isolation.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), types: req.body.types, room: str(req.body.room), reviewHours: req.body.reviewHours, reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/outbreaks', (req) => isolation.declare(store, work(req), { what: str(req.body.what), note: str(req.body.note) }));
  r.on('POST', '/api/work/outbreaks/:id/:action', (req) => isolation.outbreakAct(store, work(req), req.params.id, req.params.action, {
    personId: str(req.body.personId), role: str(req.body.role), exposure: str(req.body.exposure), watchDays: req.body.watchDays,
    entryId: str(req.body.entryId), to: str(req.body.to), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/patients/:id/infections', (req) => infections.raise(store, work(req), req.params.id, {
    site: str(req.body.site), siteDetail: str(req.body.siteDetail), suspicion: str(req.body.suspicion),
  }));
  r.on('POST', '/api/work/infections/:id/:action', (req) => infections.act(store, work(req), req.params.id, req.params.action, {
    kind: str(req.body.kind), what: str(req.body.what), value: str(req.body.value), refId: str(req.body.refId), source: str(req.body.source), note: str(req.body.note),
  }));
  r.on('GET', '/api/work/screening', (req) => screening.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/screening', (req) => screening.start(store, work(req), req.params.id, {
    kind: str(req.body.kind), what: str(req.body.what), test: str(req.body.test), eligibility: str(req.body.eligibility), dueDate: str(req.body.dueDate),
  }));
  r.on('POST', '/api/work/screening/:id/:action', (req) => screening.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), channel: str(req.body.channel), decision: str(req.body.decision), when: str(req.body.when), result: str(req.body.result),
    finding: str(req.body.finding), outcome: str(req.body.outcome), nextDue: str(req.body.nextDue), reason: str(req.body.reason),
  }));
  r.on('GET', '/api/work/surveillance', (req) => surveillance.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/surveillance', (req) => surveillance.setUp(store, work(req), req.params.id, {
    kind: str(req.body.kind), need: str(req.body.need), investigation: str(req.body.investigation), every: str(req.body.every), trigger: str(req.body.trigger), firstDue: str(req.body.firstDue),
  }));
  r.on('POST', '/api/work/surveillance/:id/:action', (req) => surveillance.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), when: str(req.body.when), result: str(req.body.result), finding: str(req.body.finding), reason: str(req.body.reason),
    decision: str(req.body.decision), nextDue: str(req.body.nextDue), investigation: str(req.body.investigation), every: str(req.body.every), trigger: str(req.body.trigger),
  }));
  r.on('GET', '/api/work/followups', (req) => followups.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/followups', (req) => followups.make(store, work(req), req.params.id, {
    what: str(req.body.what), reason: str(req.body.reason), dueBy: str(req.body.dueBy), to: str(req.body.to), externalName: str(req.body.externalName),
  }));
  r.on('POST', '/api/work/followups/:id/:action', (req) => followups.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), told: str(req.body.told), link: str(req.body.link), ref: str(req.body.ref), when: str(req.body.when), where: str(req.body.where),
    outcome: str(req.body.outcome), furtherWhat: str(req.body.furtherWhat), furtherDue: str(req.body.furtherDue),
  }));
  r.on('GET', '/api/work/recalls', (req) => recalls.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/recalls', (req) => recalls.setUp(store, work(req), req.params.id, {
    kind: str(req.body.kind), what: str(req.body.what), detail: str(req.body.detail), every: str(req.body.every), dueDate: str(req.body.dueDate),
  }));
  r.on('POST', '/api/work/recalls/:id/:action', (req) => recalls.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), eligible: str(req.body.eligible), channel: str(req.body.channel), when: str(req.body.when), where: str(req.body.where),
    next: str(req.body.next), nextDue: str(req.body.nextDue), reason: str(req.body.reason),
  }));
  r.on('GET', '/api/work/care-due', (req) => careDue.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/care-due', (req) => careDue.setUp(store, work(req), req.params.id, {
    kind: str(req.body.kind), what: str(req.body.what), detail: str(req.body.detail), every: str(req.body.every), firstDue: str(req.body.firstDue),
  }));
  r.on('POST', '/api/work/care-due/:id/:action', (req) => careDue.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), to: str(req.body.to), reason: str(req.body.reason),
  }));
  r.on('GET', '/api/work/requirements', (req) => requirements.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/requirements', (req) => requirements.add(store, work(req), req.params.id, {
    what: str(req.body.what), detail: str(req.body.detail), priority: str(req.body.priority), dueBy: str(req.body.dueBy), from: str(req.body.from),
  }));
  r.on('POST', '/api/work/requirements/:id/:action', (req) => requirements.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), to: str(req.body.to), until: str(req.body.until), reason: str(req.body.reason), outcome: str(req.body.outcome),
  }));
  r.on('GET', '/api/work/recommendations', (req) => recommendations.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/recommendations', (req) => recommendations.make(store, work(req), req.params.id, {
    basis: str(req.body.basis), what: str(req.body.what), to: str(req.body.to), implementBy: str(req.body.implementBy), channel: str(req.body.channel), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/recommendations/:id/:action', (req) => recommendations.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), channel: str(req.body.channel), what: str(req.body.what), requirement: str(req.body.requirement),
    implementBy: str(req.body.implementBy), reason: str(req.body.reason),
  }));
  r.on('GET', '/api/work/checklists', (req) => checklists.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/checklists', (req) => checklists.requireChecklist(store, work(req), req.params.id, {
    templateId: str(req.body.templateId), reason: str(req.body.reason),
  }));
  r.on('POST', '/api/work/checklists/:id/:action', (req) => checklists.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), itemId: str(req.body.itemId), result: str(req.body.result), evidence: str(req.body.evidence),
    roleKey: str(req.body.roleKey), urgency: str(req.body.urgency),
  }));
  r.on('GET', '/api/work/pathways', (req) => pathways.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/pathways', (req) => pathways.start(store, work(req), req.params.id, {
    pathwayId: str(req.body.pathwayId), answers: req.body.answers, note: str(req.body.note),
  }));
  r.on('POST', '/api/work/pathways/:id/:action', (req) => pathways.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), answers: req.body.answers, stepId: str(req.body.stepId), to: str(req.body.to), deferMins: str(req.body.deferMins),
    reason: str(req.body.reason), roleKey: str(req.body.roleKey), urgency: str(req.body.urgency), deviationId: str(req.body.deviationId),
  }));
  r.on('GET', '/api/work/treatment-plans', (req) => treatmentplans.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/treatment-plans', (req) => treatmentplans.create(store, work(req), req.params.id, {
    need: str(req.body.need), problemId: str(req.body.problemId), goal: str(req.body.goal),
  }));
  r.on('POST', '/api/work/treatment-plans/:id/:action', (req) => treatmentplans.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), what: str(req.body.what), benefits: str(req.body.benefits), risks: str(req.body.risks), optionId: str(req.body.optionId),
    agreedWith: str(req.body.agreedWith), kind: str(req.body.kind), serviceId: str(req.body.serviceId), interventionId: str(req.body.interventionId),
    componentId: str(req.body.componentId), state: str(req.body.state), progress: str(req.body.progress), outcome: str(req.body.outcome),
    goal: str(req.body.goal), reviewDue: str(req.body.reviewDue),
  }));
  r.on('GET', '/api/work/interventions', (req) => interventions.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/interventions', (req) => interventions.plan(store, work(req), req.params.id, {
    category: str(req.body.category), what: str(req.body.what), purpose: str(req.body.purpose), forId: str(req.body.forId), frequency: str(req.body.frequency),
    everyHours: str(req.body.everyHours), startAt: str(req.body.startAt), reviewDue: str(req.body.reviewDue), considerOnly: req.body.considerOnly === true || req.body.considerOnly === 'true',
  }));
  r.on('POST', '/api/work/interventions/:id/:action', (req) => interventions.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), done: req.body.done === false || req.body.done === 'false' ? false : true, response: str(req.body.response), outcome: str(req.body.outcome),
    what: str(req.body.what), frequency: str(req.body.frequency), everyHours: str(req.body.everyHours), reviewDue: str(req.body.reviewDue),
  }));
  r.on('GET', '/api/work/symptoms', (req) => symptoms.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/symptoms', (req) => symptoms.record(store, work(req), req.params.id, {
    kind: str(req.body.kind), name: str(req.body.name), onset: str(req.body.onset), site: str(req.body.site), context: str(req.body.context),
    pattern: str(req.body.pattern), associated: str(req.body.associated), score: str(req.body.score), rated: str(req.body.rated), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/symptoms/:id/:action', (req) => symptoms.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), score: str(req.body.score), rated: str(req.body.rated), mins: str(req.body.mins), outcome: str(req.body.outcome),
  }));
  r.on('GET', '/api/work/problems', (req) => problems.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/problems', (req) => problems.raise(store, work(req), req.params.id, {
    title: str(req.body.title), evidence: str(req.body.evidence), onset: str(req.body.onset),
  }));
  r.on('POST', '/api/work/problems/:id/:action', (req) => problems.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), title: str(req.body.title), management: str(req.body.management), monitoring: str(req.body.monitoring),
    reviewDue: str(req.body.reviewDue), trend: str(req.body.trend),
  }));
  r.on('GET', '/api/work/deaths', (req) => deaths.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/death', (req) => deaths.identify(store, work(req), req.params.id, {
    diedAt: str(req.body.diedAt), expected: str(req.body.expected), place: str(req.body.place), circumstances: str(req.body.circumstances),
  }));
  r.on('POST', '/api/work/deaths/:id/:action', (req) => deaths.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), at: str(req.body.at), kind: str(req.body.kind), by: str(req.body.by), ref: str(req.body.ref),
    name: str(req.body.name), to: str(req.body.to), donation: str(req.body.donation),
  }));
  r.on('GET', '/api/work/incidents', (req) => incidents.list(store, work(req)));
  r.on('GET', '/api/work/incidents/:id', (req) => incidents.get(store, work(req), req.params.id));
  r.on('POST', '/api/work/patients/:id/incidents', (req) => incidents.report(store, work(req), req.params.id, {
    category: str(req.body.category), occurredAt: str(req.body.occurredAt), place: str(req.body.place), what: str(req.body.what), harm: str(req.body.harm), immediate: str(req.body.immediate),
  }));
  r.on('POST', '/api/work/incidents/:id/:action', (req) => incidents.act(store, work(req), req.params.id, req.params.action, {
    harm: str(req.body.harm), notify: str(req.body.notify), notifyNote: str(req.body.notifyNote), disclosure: str(req.body.disclosure), disclosureNote: str(req.body.disclosureNote),
    note: str(req.body.note), lead: str(req.body.lead), ref: str(req.body.ref), findings: str(req.body.findings), what: str(req.body.what), owner: str(req.body.owner),
    due: str(req.body.due), actionId: str(req.body.actionId),
  }));
  r.on('GET', '/api/work/deterioration', (req) => deterioration.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/deterioration', (req) => deterioration.open(store, work(req), req.params.id, { change: str(req.body.change) }));
  r.on('POST', '/api/work/deterioration/:id/:action', (req) => deterioration.act(store, work(req), req.params.id, req.params.action, {
    roleKey: str(req.body.roleKey), urgency: str(req.body.urgency), trigger: str(req.body.trigger), note: str(req.body.note),
    level: str(req.body.level), basis: str(req.body.basis), outcome: str(req.body.outcome),
  }));
  r.on('GET', '/api/work/acuity', (req) => acuity.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/acuity', (req) => acuity.assess(store, work(req), req.params.id, { level: str(req.body.level), basis: str(req.body.basis) }));
  r.on('POST', '/api/work/acuity/:id/error', (req) => acuity.markError(store, work(req), req.params.id, { reason: str(req.body.reason) }));
  r.on('GET', '/api/work/allocation', (req) => allocations.overview(store, work(req)));
  r.on('POST', '/api/work/allocation', (req) => allocations.create(store, work(req), { date: str(req.body.date), period: str(req.body.period) }));
  r.on('GET', '/api/work/allocation/:id', (req) => allocations.get(store, work(req), req.params.id));
  r.on('POST', '/api/work/allocation/:id/:action', (req) => allocations.act(store, work(req), req.params.id, req.params.action, {
    workerId: str(req.body.workerId), personId: str(req.body.personId), toId: str(req.body.toId), reason: str(req.body.reason), note: str(req.body.note),
  }));
  r.on('GET', '/api/work/team', (req) => assignments.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/team', (req) => assignments.propose(store, work(req), req.params.id, {
    kind: str(req.body.kind), assigneeId: str(req.body.assigneeId), externalName: str(req.body.externalName), externalOrg: str(req.body.externalOrg),
    teamName: str(req.body.teamName), reason: str(req.body.reason), startsAt: str(req.body.startsAt), replaces: str(req.body.replaces),
  }));
  r.on('POST', '/api/work/team/:id/:action', (req) => assignments.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), coverId: str(req.body.coverId), coverName: str(req.body.coverName), until: str(req.body.until),
  }));
  r.on('GET', '/api/work/usual', (req) => usual.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/usual', (req) => usual.recordUsual(store, work(req), req.params.id, {
    domain: str(req.body.domain), statement: str(req.body.statement), low: str(req.body.low), high: str(req.body.high), source: str(req.body.source), sourceName: str(req.body.sourceName),
  }));
  r.on('POST', '/api/work/usual/:id/error', (req) => usual.markError(store, work(req), req.params.id, { reason: str(req.body.reason) }));
  r.on('POST', '/api/work/patients/:id/differences', (req) => usual.notice(store, work(req), req.params.id, { domain: str(req.body.domain), nowText: str(req.body.nowText) }));
  r.on('POST', '/api/work/differences/:id/:action', (req) => usual.act(store, work(req), req.params.id, req.params.action, {
    action: str(req.body.action), outcome: str(req.body.outcome), note: str(req.body.note), statement: str(req.body.statement), low: str(req.body.low), high: str(req.body.high),
  }));
  r.on('GET', '/api/work/function', (req) => functional.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/function', (req) => functional.assess(store, work(req), req.params.id, {
    kind: str(req.body.kind), source: str(req.body.source), sourceName: str(req.body.sourceName), summary: str(req.body.summary),
    entries: typeof req.body.entries === 'object' && req.body.entries ? req.body.entries as Record<string, unknown> : {},
    reviewDays: typeof req.body.reviewDays === 'number' ? req.body.reviewDays : str(req.body.reviewDays),
  }));
  r.on('POST', '/api/work/function/:id/error', (req) => functional.markError(store, work(req), req.params.id, { reason: str(req.body.reason) }));
  r.on('POST', '/api/work/patients/:id/function-plans', (req) => functional.plan(store, work(req), req.params.id, { activity: str(req.body.activity), what: str(req.body.what) }));
  r.on('POST', '/api/work/function-plans/:id/:action', (req) => functional.actPlan(store, work(req), req.params.id, req.params.action, { outcome: str(req.body.outcome) }));
  r.on('GET', '/api/work/questionnaires', (req) => questionnaires.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/questionnaires', (req) => questionnaires.request(store, work(req), req.params.id, {
    code: str(req.body.code), reason: str(req.body.reason), dueAt: str(req.body.dueAt),
  }));
  r.on('POST', '/api/work/questionnaires/:id/:action', (req) => questionnaires.act(store, work(req), req.params.id, req.params.action, {
    mode: str(req.body.mode), responses: typeof req.body.responses === 'object' && req.body.responses ? req.body.responses as Record<string, unknown> : {},
    note: str(req.body.note), interpretation: str(req.body.interpretation), action: str(req.body.action),
    repeatDays: typeof req.body.repeatDays === 'number' ? req.body.repeatDays : str(req.body.repeatDays),
  }));
  r.on('GET', '/api/work/reports', (req) => reports.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/reports', (req) => reports.record(store, work(req), req.params.id, reportFields(req.body)));
  r.on('POST', '/api/work/reports/:id/:action', (req) => reports.act(store, work(req), req.params.id, req.params.action, {
    ...reportFields(req.body), outcome: str(req.body.outcome), note: str(req.body.note),
  }));
  r.on('GET', '/api/work/coding', (req) => coding.list(store, work(req)));
  r.on('GET', '/api/work/coding/queries', (req) => coding.queries(store, work(req)));
  r.on('POST', '/api/work/coding/queries/:id/answer', (req) => coding.answer(store, work(req), req.params.id, { answer: str(req.body.answer) }));
  r.on('GET', '/api/work/coding/:id', (req) => coding.getCase(store, work(req), req.params.id));
  r.on('POST', '/api/work/coding/:id/:action', (req) => coding.act(store, work(req), req.params.id, req.params.action, {
    system: str(req.body.system), code: str(req.body.code), term: str(req.body.term), role: str(req.body.role), sourceEventId: str(req.body.sourceEventId),
    sourceNote: str(req.body.sourceNote), entryId: str(req.body.entryId), queryId: str(req.body.queryId), question: str(req.body.question), note: str(req.body.note),
  }));
  r.on('GET', '/api/work/capacity', (req) => capacity.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/capacity', (req) => capacity.raise(store, work(req), req.params.id, { decision: str(req.body.decision), kind: str(req.body.kind), concern: str(req.body.concern) }));
  r.on('POST', '/api/work/capacity/:id/:action', (req) => capacity.act(store, work(req), req.params.id, req.params.action, {
    understand: str(req.body.understand), retain: str(req.body.retain), weigh: str(req.body.weigh), communicate: str(req.body.communicate),
    findings: str(req.body.findings), supports: str(req.body.supports), present: str(req.body.present), determination: str(req.body.determination),
    note: str(req.body.note), reassessBy: str(req.body.reassessBy),
  }));
  const preferenceFields = (b: Record<string, unknown>) => ({
    category: str(b.category), statement: str(b.statement), source: str(b.source), sourceName: str(b.sourceName),
    context: str(b.context), relevance: str(b.relevance), reviewDate: str(b.reviewDate),
  });
  r.on('GET', '/api/work/preferences', (req) => preferences.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/preferences', (req) => preferences.record(store, work(req), req.params.id, preferenceFields(req.body)));
  r.on('POST', '/api/work/preferences/:id/:action', (req) => preferences.act(store, work(req), req.params.id, req.params.action, {
    ...preferenceFields(req.body), note: str(req.body.note), outcome: str(req.body.outcome),
  }));
  r.on('GET', '/api/work/leave', (req) => leave.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/leave', (req) => leave.request(store, work(req), req.params.id, {
    kind: str(req.body.kind), purpose: str(req.body.purpose), destination: str(req.body.destination), companion: str(req.body.companion),
    contact: str(req.body.contact), conditions: str(req.body.conditions), legal: str(req.body.legal), leaveAt: str(req.body.leaveAt), returnBy: str(req.body.returnBy),
  }));
  r.on('POST', '/api/work/leave/:id/:action', (req) => leave.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), returnBy: str(req.body.returnBy), legal: str(req.body.legal) }));
  r.on('GET', '/api/work/moves', (req) => locations.board(store, work(req)));
  r.on('GET', '/api/work/beds/:id/history', (req) => locations.bedHistory(store, work(req), req.params.id));
  r.on('POST', '/api/work/patients/:id/moves', (req) => locations.request(store, work(req), req.params.id, { needs: str(req.body.needs), reason: str(req.body.reason), urgency: str(req.body.urgency) }));
  r.on('POST', '/api/work/moves/:id/:action', (req) => locations.act(store, work(req), req.params.id, req.params.action, { bedId: str(req.body.bedId), note: str(req.body.note) }));
  r.on('GET', '/api/work/equipment', (req) => equipment.list(store, work(req)));
  r.on('POST', '/api/work/equipment', (req) => equipment.add(store, work(req), {
    assetTag: str(req.body.assetTag), kind: str(req.body.kind), description: str(req.body.description), serviceDue: str(req.body.serviceDue),
  }));
  r.on('POST', '/api/work/equipment-notices', (req) => equipment.notice(store, work(req), {
    kind: str(req.body.kind), title: str(req.body.title), source: str(req.body.source), action: str(req.body.action), dueDate: str(req.body.dueDate), equipmentIds: str(req.body.equipmentIds),
  }));
  r.on('POST', '/api/work/equipment-notices/:id/done', (req) => equipment.noticeDone(store, work(req), req.params.id, { equipmentId: str(req.body.equipmentId), note: str(req.body.note) }));
  r.on('POST', '/api/work/patients/:id/loans', (req) => equipment.lend(store, work(req), req.params.id, {
    equipmentId: str(req.body.equipmentId), purpose: str(req.body.purpose), fitted: str(req.body.fitted), returnBy: str(req.body.returnBy),
  }));
  r.on('POST', '/api/work/patients/:id/equipment', (req) => equipment.start(store, work(req), req.params.id, {
    equipmentId: str(req.body.equipmentId), purpose: str(req.body.purpose), settings: str(req.body.settings), checked: str(req.body.checked),
  }));
  r.on('POST', '/api/work/equipment/:id/:action', (req) => equipment.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), patientAffected: req.body.patientAffected === true || req.body.patientAffected === 'true', serviceDue: str(req.body.serviceDue), condition: str(req.body.condition),
  }));
  r.on('GET', '/api/work/meals', (req) => diets.list(store, work(req)));
  const dietFields = (b: Record<string, unknown>) => ({
    diets: str(b.diets), texture: str(b.texture), drinks: str(b.drinks), assistance: str(b.assistance), supplements: str(b.supplements),
    preferences: str(b.preferences), assessment: str(b.assessment), reason: str(b.reason), reviewDate: str(b.reviewDate),
  });
  r.on('POST', '/api/work/patients/:id/diet', (req) => diets.order(store, work(req), req.params.id, dietFields(req.body)));
  r.on('POST', '/api/work/diets/:id/meal', (req) => diets.meal(store, work(req), req.params.id, {
    meal: str(req.body.meal), outcome: str(req.body.outcome), intake: str(req.body.intake), tolerance: str(req.body.tolerance), note: str(req.body.note),
  }));
  r.on('POST', '/api/work/diets/:id/review', (req) => diets.review(store, work(req), req.params.id, { ...dietFields(req.body), outcome: str(req.body.outcome), finding: str(req.body.finding) }));
  r.on('GET', '/api/work/restrictions', (req) => restrictions.list(store, work(req)));
  const restrictionFields = (b: Record<string, unknown>) => ({
    kind: str(b.kind), side: str(b.side), detail: str(b.detail), instructions: str(b.instructions), reason: str(b.reason), patientView: str(b.patientView),
    effectiveFrom: str(b.effectiveFrom), effectiveUntil: str(b.effectiveUntil), reviewDate: str(b.reviewDate),
  });
  r.on('POST', '/api/work/patients/:id/restrictions', (req) => restrictions.propose(store, work(req), req.params.id, restrictionFields(req.body)));
  r.on('POST', '/api/work/restrictions/:id/:action', (req) => restrictions.act(store, work(req), req.params.id, req.params.action, {
    ...restrictionFields(req.body), note: str(req.body.note), outcome: str(req.body.outcome), followed: req.body.followed === true || req.body.followed === 'true',
  }));
  r.on('GET', '/api/work/communications', (req) => communications.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/communications', (req) => communications.create(store, work(req), req.params.id, {
    purpose: str(req.body.purpose), kind: str(req.body.kind), recipient: str(req.body.recipient), contact: str(req.body.contact),
    method: str(req.body.method), language: str(req.body.language), sharing: str(req.body.sharing), due: str(req.body.due),
  }));
  r.on('POST', '/api/work/communications/:id/:action', (req) => communications.act(store, work(req), req.params.id, req.params.action, {
    outcome: str(req.body.outcome), method: str(req.body.method), note: str(req.body.note), conveyed: str(req.body.conveyed), response: str(req.body.response), followUp: str(req.body.followUp),
  }));
  r.on('GET', '/api/work/alerts', (req) => alerts.list(store, work(req)));
  r.on('GET', '/api/work/alerts/count', (req) => alerts.count(store, work(req)));
  r.on('POST', '/api/work/patients/:id/alerts', (req) => alerts.raise(store, work(req), req.params.id, { category: str(req.body.category), title: str(req.body.title), detail: str(req.body.detail), expiresOn: str(req.body.expiresOn) }));
  r.on('GET', '/api/work/alerts/rules', (req) => alerts.rules(work(req)));
  r.on('POST', '/api/work/alerts/:id/:action', (req) => alerts.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), outcome: str(req.body.outcome) }));
  r.on('GET', '/api/work/appointments', (req) => appointments.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/appointments', (req) => appointments.request(store, work(req), req.params.id, { reason: str(req.body.reason), priority: str(req.body.priority), mode: str(req.body.mode) }));
  r.on('POST', '/api/work/appointments/:id/:action', (req) => appointments.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), when: str(req.body.when), duration: str(String(req.body.duration ?? '')), place: str(req.body.place), mode: str(req.body.mode), another: req.body.another === true,
  }));
  r.on('GET', '/api/work/referrals', (req) => referrals.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/referrals', (req) => referrals.create(store, work(req), req.params.id, {
    to: str(req.body.to), reason: str(req.body.reason), request: str(req.body.request), priority: str(req.body.priority),
    patientAware: req.body.patientAware === true, send: req.body.send === true,
    evidence: Array.isArray(req.body.evidence) ? req.body.evidence.map(String) : [],
  }));
  r.on('POST', '/api/work/referrals/:id/:action', (req) => referrals.act(store, work(req), req.params.id, req.params.action, {
    note: str(req.body.note), priority: str(req.body.priority), when: str(req.body.when), to: str(req.body.to),
  }));
  r.on('POST', '/api/work/consultations/:id/:action', (req) => consultations.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note) }));
  r.on('GET', '/api/work/escalations', (req) => escalations.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/escalations', (req) => escalations.raise(store, work(req), req.params.id, { roleKey: str(req.body.roleKey), urgency: str(req.body.urgency), concern: str(req.body.concern), trigger: str(req.body.trigger) }));
  r.on('POST', '/api/work/escalations/:id/:action', (req) => escalations.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note), roleKey: str(req.body.roleKey), urgency: str(req.body.urgency), trigger: str(req.body.trigger) }));
  r.on('GET', '/api/work/discharges', (req) => discharges.list(store, work(req)));
  r.on('POST', '/api/work/patients/:id/discharge', (req) => discharges.start(store, work(req), req.params.id, { destination: str(req.body.destination), expectedDate: str(req.body.expectedDate), note: str(req.body.note) }));
  r.on('POST', '/api/work/discharges/:id/requirements/:code', (req) => discharges.record(store, work(req), req.params.id, req.params.code, { status: str(req.body.status), note: str(req.body.note) }));
  r.on('POST', '/api/work/discharges/:id/:action', (req) => discharges.act(store, work(req), req.params.id, req.params.action, { note: str(req.body.note) }));
  r.on('GET', '/api/work/beds', (req) => transfers.beds(store, work(req)));
  r.on('POST', '/api/work/beds/:id/state', (req) => transfers.setBed(store, work(req), req.params.id, str(req.body.state)));

  r.on('GET', '/api/work/rostering/staffing', (req) => rostering.staffing(store, work(req)));
  r.on('POST', '/api/work/rostering/staffing/call-in', (req) => rostering.callIn(store, work(req), { date: str(req.body.date), period: str(req.body.period), roleKey: str(req.body.roleKey), workerId: str(req.body.workerId), note: str(req.body.note) }));
  r.on('POST', '/api/work/rostering/staffing/advertise', (req) => rostering.advertise(store, work(req), { date: str(req.body.date), period: str(req.body.period), roleKey: str(req.body.roleKey) }));
  r.on('POST', '/api/work/rostering/staffing/short', (req) => rostering.runShort(store, work(req), { date: str(req.body.date), period: str(req.body.period), roleKey: str(req.body.roleKey), plan: str(req.body.plan), told: str(req.body.told) }));
  r.on('POST', '/api/work/roster-shifts/:id/absent', (req) => rostering.reportAbsent(store, work(req), req.params.id, { kind: str(req.body.kind), note: str(req.body.note) }));
  r.on('GET', '/api/work/rostering/vacancies', (req) => rostering.vacancies(store, work(req)));
  r.on('POST', '/api/work/rostering/vacancies/:id/decide', (req) => rostering.decideVacancy(store, work(req), req.params.id, { workerId: str(req.body.workerId), note: str(req.body.note) }));
  r.on('GET', '/api/work/rostering/swaps', (req) => rostering.swaps(store, work(req)));
  r.on('POST', '/api/work/rostering/swaps/:id/decide', (req) => rostering.decideSwap(store, work(req), req.params.id, { workerId: str(req.body.workerId) || null, decline: req.body.decline === true, note: str(req.body.note) }));
  r.on('GET', '/api/work/rostering/leave', (req) => rostering.leaveRequests(store, work(req)));
  r.on('POST', '/api/work/rostering/leave/:id/decide', (req) => rostering.decideLeave(store, work(req), req.params.id, req.body.approve === true, str(req.body.note)));

  // PERSONAL -----------------------------------------------------------------------------
  r.on('GET', '/api/personal/roster', (req) => personal.roster(store, session(req), req.query.get('from') ?? undefined));
  r.on('GET', '/api/personal/availability', (req) => personal.availability(store, session(req)));
  r.on('POST', '/api/personal/availability', (req) => personal.addAvailability(store, session(req), req.body as never));
  r.on('DELETE', '/api/personal/availability/:id', (req) => personal.withdrawAvailability(store, session(req), req.params.id));
  r.on('GET', '/api/personal/open-shifts', (req) => personal.openShifts(store, session(req)));
  r.on('POST', '/api/personal/open-shifts/:id/interest', (req) => personal.shiftInterest(store, session(req), req.params.id, req.body.interested === true));
  r.on('GET', '/api/personal/exchange', (req) => personal.exchange(store, session(req)));
  r.on('POST', '/api/personal/roster/:id/offer', (req) => personal.offerShift(store, session(req), req.params.id));
  r.on('POST', '/api/personal/offers/:id/withdraw', (req) => personal.withdrawOffer(store, session(req), req.params.id));
  r.on('POST', '/api/personal/offers/:id/take', (req) => personal.takeOffer(store, session(req), req.params.id, req.body.take === true));
  r.on('GET', '/api/personal/payslips', (req) => personal.payslips(store, session(req)));
  r.on('GET', '/api/personal/payslips/:id', (req) => personal.payslip(store, session(req), req.params.id));
  r.on('GET', '/api/personal/leave', (req) => personal.leave(store, session(req)));
  r.on('POST', '/api/personal/leave', (req) => personal.requestLeave(store, session(req), req.body as never));
  r.on('POST', '/api/personal/leave/:id/cancel', (req) => personal.cancelLeave(store, session(req), req.params.id));
  r.on('GET', '/api/personal/credentials', (req) => personal.credentials(store, session(req)));
  r.on('GET', '/api/personal/training', (req) => personal.training(store, session(req)));

  // Governance reference (read-only) -------------------------------------------------------
  r.on('GET', '/api/governance', (req) => {
    session(req);
    return { legal: LEGAL_REGISTER, research: RESEARCH_REQUIREMENTS, orgRulePack: ORG_RULE_PACK };
  });

  return r;
}

function contextView(ctx: identity.WorkContext) {
  return {
    positionId: ctx.positionId,
    positionTitle: ctx.positionTitle,
    roleLabel: ctx.role.label,
    roleKey: ctx.role.roleKey,
    service: ctx.serviceName,
    organisation: ctx.organisationName,
    subjectLabel: ctx.subjectLabel,
    matrixRow: ctx.role.matrixRow,
    evidenceStatus: ctx.role.evidenceStatus,
    board: Boolean(ctx.role.board),
    authority: ctx.authority,
  };
}
