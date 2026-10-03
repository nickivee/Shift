import { h, icon, mount } from '../lib/dom.js';
import { get, put, del } from '../lib/api.js';
import { showError, toast } from '../lib/ui.js';
import { state, go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog, dialog, field, select } from '../lib/forms.js';
import { groupCards } from '../lib/groups.js';

const DESCRIPTIONS = {
  workstation: (s) => `Select a ${s} and open the active documentation workspace.`,
  tasks: () => 'Outstanding work remains visible until resolved.',
  search: (s) => `Find a ${s}.`,
  handover: () => 'Review items explicitly marked for handover.',
  received: () => 'Information routed to you. Nothing is received until you open it.',
  knowledge: () => 'Ask colleagues anonymously. SHIFT gives no answers of its own.',
  vacancies: () => 'Shifts short of staff, and open shifts with who has asked for them. Only your decision changes the roster.',
  swaps: () => 'Shifts staff have offered to colleagues, waiting on a rostering decision.',
  leave: () => 'Leave requests waiting for a decision.',
  transfers: () => 'Admissions and transfers coming in and going out, one step at a time.',
  flow: () => 'Beds across the hospital and who is waiting for one.',
  discharges: () => 'Discharges being planned and what is still outstanding.',
  careplans: () => 'Care plan items due or overdue for review.',
  wounds: () => 'Wounds reported but not yet assessed, and reviews due today.',
  consults: () => 'Advice asked of your team, and advice your team has asked for.',
  referrals: () => 'Referrals sent to your service, and the ones your service has made.',
  appointments: () => 'Today\'s appointments and the waitlist.',
  alerts: () => 'Alerts from the record for your role, and alerts staff have raised.',
  communications: () => 'People your service needs to contact, every attempt, and follow-ups.',
  monitoring: () => 'Monitoring that is overdue or due soon for your patients.',
  whanau: () => 'Who each person wants involved, what may be shared, and people still to ask.',
  interpreters: () => 'Interpreters to book and coming up, and communication needs.',
  external: () => 'Letters, summaries and results from other providers to match and review.',
  coding: () => 'Hospital episodes to code, being coded, and finalised.',
  privacy: () => 'Requests to see, correct or know about someone\'s health information.',
  cdbook: () => 'Your ward\'s controlled drug book: joint checks and stocktakes due.',
  rules: () => 'The rules and settings SHIFT applies, with their sources and start dates, and changes waiting for approval.',
  reports: () => 'What people have told staff that a clinician should read.',
  instruments: () => 'Questionnaires due and results to interpret.',
  incidents: () => 'Incidents waiting for review, overdue actions, and complaints to acknowledge or reply to.',
  deaths: () => 'People who have died: what is still to do before their stay ends.',
  problems: () => 'Concerns waiting to be assessed, problems getting worse and reviews due.',
  symptoms: () => 'Symptoms to look at again, anyone rating 7 or more, and ones not yet assessed.',
  interventions: () => 'What is due now, what is waiting for a doctor to authorise, and reviews due.',
  treatmentplans: () => 'Plans waiting to be agreed, plans not going to plan, and reviews due.',
  pathways: () => 'Pathway steps overdue, pathways suggested by an entry, and pathways ready to complete.',
  checklists: () => 'Checks not met and not yet fixed, checklists overdue, and ones not started.',
  recommendations: () => 'Recommendations to respond to, to put in place, and your own to review.',
  requirements: () => 'What your service has to do: yours, waiting to be assigned, deferred, and waiting for an outcome.',
  caredue: () => 'Care falling due in your service: overdue, due now and coming up.',
  recalls: () => 'Recalls overdue, due in the next 30 days, booked, and missed.',
  followups: () => 'Follow-ups to take on, arrange, and record the outcome of.',
  chronic: () => 'Long-term condition plans: reviews overdue and due in the next 30 days.',
  education: () => 'People who need more teaching, and education given in the last week.',
  afterhours: () => 'Contacts made outside usual hours that are waiting for the day team to review.',
  visits: () => 'Visits planned for people where they are: due now, today and coming up.',
  surveillance: () => 'Surveillance results to review, and checks overdue or due this week.',
  screening: () => 'Screening results to review, people to tell, and screens to offer.',
  infections: () => 'Suspected infections, isolation precautions, outbreaks, and infections being treated.',
  antimicrobials: () => 'Antimicrobial reviews due, courses due to finish, and outcomes to record.',
  sitechecks: () => 'Procedure sites and sides that do not match, checks still to do, and sites verified.',
  readiness: () => 'Who is ready for a procedure, going home, a move or therapy, what is still to do, and reassessments due.',
  variances: () => 'Care that did not happen as expected: decisions needed, follow-ups due, and what is being watched.',
  declined: () => 'Care people have declined: high-risk refusals to escalate, senior responses, and care to offer again.',
  priorities: () => 'Who is waiting to be seen or acted on, most urgent first, and who is past their timeframe.',
  arrivals: () => 'Register an arrival, match them to their record, and identify people with a temporary identity.',
  duplicates: () => 'Two records that may be the same person: compare them, merge them into one, or confirm they are different people.',
  downtime: () => 'When SHIFT or part of it is down: the paper process to use, then entering paper records once it is back.',
  delegation: () => 'Care handed to a colleague for a set time: accept it, do it and report back, or check what was done.',
  breakglass: () => 'Access to records outside your care: approve requests, and review every use in your service.',
  deterioration: () => 'People getting worse: not yet escalated first, then those being responded to.',
  acuity: () => 'People recorded as unwell, statuses overdue for another look, and people with none.',
  allocation: () => 'Which patients each person has this shift, and allocations waiting for your review.',
  team: () => 'Named clinicians waiting for you or to confirm, and people missing a required name.',
  usual: () => 'Changes from someone\'s usual that need action, and readings outside their usual range.',
  function: () => 'People worse than usual with nothing planned, and reassessments due.',
  codingqueries: () => 'Questions from clinical coders about your service\'s episodes.',
  capacity: () => 'Capacity concerns waiting for you to assess, and reassessments due.',
  preferences: () => 'What matters to the people you are caring for, in their words, and any new to you.',
  absences: () => `Who is away on leave and when they are due back, and leave waiting to be approved.`,
  moves: () => 'Patients who need to move bed, beds held for them, and each bed\'s history.',
  equipment: () => 'Pumps, mattresses, hoists and monitors: what is in use, out of use or due for service.',
  meals: () => 'Diets, texture and drink levels, meals given and eaten, and swallowing concerns.',
  restrictions: () => 'Nil by mouth, fluid limits, weight-bearing and other precautions, and any waiting for authorisation.',
  escalations: () => 'Concerns raised to you, and the ones you raised, until reassessed.',
};
const TARGET = {
  workstation: '/work/records', tasks: '/work/tasks', search: '/work/search', handover: '/work/handover', received: '/work/received', knowledge: '/work/knowledge',
  vacancies: '/work/rostering/vacancies', swaps: '/work/rostering/swaps', leave: '/work/rostering/leave',
  transfers: '/work/transfers', flow: '/work/flow', discharges: '/work/discharges', escalations: '/work/escalations', consults: '/work/consultations', wounds: '/work/wounds', careplans: '/work/careplans', referrals: '/work/referrals', appointments: '/work/appointments', alerts: '/work/alerts', communications: '/work/communications', monitoring: '/work/monitoring', restrictions: '/work/restrictions', meals: '/work/meals', equipment: '/work/equipment', moves: '/work/moves', absences: '/work/leave', preferences: '/work/preferences', capacity: '/work/capacity', whanau: '/work/whanau', interpreters: '/work/interpreters', external: '/work/external', coding: '/work/coding', privacy: '/work/privacy', cdbook: '/work/controlled-drugs', rules: '/work/rules', reports: '/work/reports', instruments: '/work/questionnaires', function: '/work/function', usual: '/work/usual', team: '/work/team', allocation: '/work/allocation', acuity: '/work/acuity', deterioration: '/work/deterioration', incidents: '/work/incidents', deaths: '/work/deaths', problems: '/work/problems', symptoms: '/work/symptoms', interventions: '/work/interventions', treatmentplans: '/work/treatment-plans', pathways: '/work/pathways', checklists: '/work/checklists', recommendations: '/work/recommendations', requirements: '/work/requirements', caredue: '/work/care-due', recalls: '/work/recalls', followups: '/work/followups', visits: '/work/visits', afterhours: '/work/afterhours', education: '/work/education', chronic: '/work/chronic', surveillance: '/work/surveillance', screening: '/work/screening', infections: '/work/infections', antimicrobials: '/work/antimicrobials', sitechecks: '/work/sitechecks', readiness: '/work/readiness', variances: '/work/variances', declined: '/work/declined', priorities: '/work/priorities', arrivals: '/work/arrivals', duplicates: '/work/duplicates', breakglass: '/work/breakglass', delegation: '/work/delegation', downtime: '/work/downtime', codingqueries: '/work/coding-questions',
};

export function openTab(tabId) {
  go(tabId === 'list' ? '/work/records' : `/work/records?open=${tabId}`);
}

export async function homeView() {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const home = await get('/api/work/home');
  const root = h('div');

  const counts = {};
  const loadCounts = async () => {
    const want = home.cards.filter((c) => !c.hidden).map((c) => c.id);
    const jobs = [];
    if (want.includes('tasks')) jobs.push(get('/api/work/tasks').then((t) => (counts.tasks = t.filter((x) => !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(x.state)).length)));
    if (want.includes('received')) jobs.push(get('/api/work/received').then((r) => (counts.received = r.filter((x) => x.state === 'DELIVERED').length)));
    if (want.includes('vacancies')) jobs.push(Promise.all([get('/api/work/rostering/vacancies'), get('/api/work/rostering/staffing')]).then(([v, s]) => (counts.vacancies = v.length + s.gaps)));
    for (const id of ['swaps', 'leave']) {
      if (want.includes(id)) jobs.push(get(`/api/work/rostering/${id}`).then((rows) => (counts[id] = rows.length)));
    }
    if (want.includes('transfers')) jobs.push(get('/api/work/transfers').then((rows) => (counts.transfers = rows.filter((t) => t.actions.length).length)));
    if (want.includes('discharges')) jobs.push(get('/api/work/discharges').then((rows) => (counts.discharges = rows.filter((d) => d.actions.length || d.requirements.some((r) => r.canRecord)).length)));
    if (want.includes('escalations')) jobs.push(get('/api/work/escalations').then((rows) => (counts.escalations = rows.filter((x) => x.actions.some((a) => ['receive', 'acknowledge', 'respond'].includes(a))).length)));
    if (want.includes('consults')) jobs.push(get('/api/work/consultations').then((rows) => (counts.consults = rows.filter((c) => c.actions.some((a) => a !== 'withdraw')).length)));
    if (want.includes('referrals')) jobs.push(get('/api/work/referrals').then((rows) => (counts.referrals = rows.filter((r) => r.actions.some((a) => a !== 'cancel')).length)));
    if (want.includes('appointments')) jobs.push(get('/api/work/appointments').then((d) => (counts.appointments = d.appointments.filter((a) => (a.startAt ?? '').startsWith(d.today) && !d.ended.includes(a.state)).length)));
    if (want.includes('alerts')) jobs.push(get('/api/work/alerts/count').then((d) => (counts.alerts = d.open)));
    if (want.includes('communications')) jobs.push(get('/api/work/communications').then((d) => (counts.communications = d.communications.filter((c) => c.actions.some((a) => a !== 'cancel')).length)));
    if (want.includes('monitoring')) jobs.push(get('/api/work/monitoring').then((d) => (counts.monitoring = d.plans.filter((m) => m.status === 'OVERDUE' || m.status === 'DUE_SOON').length)));
    if (want.includes('reports')) jobs.push(get('/api/work/reports').then((d) => (counts.reports = d.toReview.length)));
    if (want.includes('downtime')) jobs.push(get('/api/work/downtime').then((d) => (counts.downtime = d.current.length + d.reconciling.reduce((a, x) => a + x.open, 0))));
    if (want.includes('delegation')) jobs.push(get('/api/work/delegation').then((d) => (counts.delegation = d.toAccept.length + d.toCheck.length)));
    if (want.includes('breakglass')) jobs.push(get('/api/work/breakglass').then((d) => (counts.breakglass = d.toApprove.length + d.toReview.length)));
    if (want.includes('duplicates')) jobs.push(get('/api/work/duplicates').then((d) => (counts.duplicates = d.possible.length)));
    if (want.includes('arrivals')) jobs.push(get('/api/work/arrivals').then((d) => (counts.arrivals = d.unresolved.length)));
    if (want.includes('priorities')) jobs.push(get('/api/work/priorities').then((d) => (counts.priorities = d.overdue.length + d.waiting.length)));
    if (want.includes('declined')) jobs.push(get('/api/work/declined').then((d) => (counts.declined = d.attention.length + d.reoffer.length)));
    if (want.includes('variances')) jobs.push(get('/api/work/variances').then((d) => (counts.variances = d.followUpDue.length + (d.canDecide ? d.toDecide.length : 0))));
    if (want.includes('readiness')) jobs.push(get('/api/work/readiness').then((d) => (counts.readiness = d.reassess.length + (d.decides.length ? d.toDecide.length : 0))));
    if (want.includes('sitechecks')) jobs.push(get('/api/work/sitechecks').then((d) => (counts.sitechecks = d.discrepancies.length + d.checking.length)));
    if (want.includes('antimicrobials')) jobs.push(get('/api/work/antimicrobials').then((d) => (counts.antimicrobials = d.toReview.length + d.finishing.length + (d.canDecide ? d.outcome.length : 0))));
    if (want.includes('infections')) jobs.push(get('/api/work/infections').then((d) => (counts.infections = d.suspected.length + d.attention.length + d.isolation.notInPlace + d.isolation.reviewDue)));
    if (want.includes('screening')) jobs.push(get('/api/work/screening').then((d) => (counts.screening = (d.canReview ? d.toReview.length : 0) + d.toTell.length + d.toOffer.filter((x) => x.overdue).length)));
    if (want.includes('surveillance')) jobs.push(get('/api/work/surveillance').then((d) => (counts.surveillance = (d.canReview ? d.toReview.length : 0) + d.overdue.length)));
    if (want.includes('chronic')) jobs.push(get('/api/work/chronic').then((d) => (counts.chronic = d.overdue.length + d.soon.length)));
    if (want.includes('education')) jobs.push(get('/api/work/education').then((d) => (counts.education = d.moreNeeded.length)));
    if (want.includes('afterhours')) jobs.push(get('/api/work/afterhours').then((d) => (counts.afterhours = d.toReview.length)));
    if (want.includes('visits')) jobs.push(get('/api/work/visits').then((d) => (counts.visits = d.overdue.length + d.today.length)));
    if (want.includes('followups')) jobs.push(get('/api/work/followups').then((d) => (counts.followups = d.toTake.length + d.toArrange.length + d.outcome.length)));
    if (want.includes('recalls')) jobs.push(get('/api/work/recalls').then((d) => (counts.recalls = d.overdue.length + d.dna.length)));
    if (want.includes('caredue')) jobs.push(get('/api/work/care-due').then((d) => (counts.caredue = d.overdue.length + d.due.length)));
    if (want.includes('requirements')) jobs.push(get('/api/work/requirements').then((d) => (counts.requirements = d.mine.length + d.toAssign.length + d.toClose.length)));
    if (want.includes('recommendations')) jobs.push(get('/api/work/recommendations').then((d) => (counts.recommendations = d.toRespond.length + d.toImplement.length + d.toReview.length)));
    if (want.includes('checklists')) jobs.push(get('/api/work/checklists').then((d) => (counts.checklists = new Set([...d.exceptions, ...d.overdue].map((x) => x.id)).size)));
    if (want.includes('pathways')) jobs.push(get('/api/work/pathways').then((d) => (counts.pathways = d.overdue.length + d.suggested.length)));
    if (want.includes('treatmentplans')) jobs.push(get('/api/work/treatment-plans').then((d) => (counts.treatmentplans = (d.canAuthorise ? d.toAgree.length : 0) + d.offTrack.length + d.reviews.length)));
    if (want.includes('interventions')) jobs.push(get('/api/work/interventions').then((d) => (counts.interventions = d.due.length + (d.canAuthorise ? d.toAuthorise.length : 0) + d.reviews.length)));
    if (want.includes('symptoms')) jobs.push(get('/api/work/symptoms').then((d) => (counts.symptoms = d.reassess.filter((x) => x.reassessOverdue).length + d.severe.length + d.notAssessed.length)));
    if (want.includes('problems')) jobs.push(get('/api/work/problems').then((d) => (counts.problems = d.toAssess.length + d.dueReview.length + d.worse.length)));
    if (want.includes('deaths')) jobs.push(get('/api/work/deaths').then((d) => (counts.deaths = d.open.length)));
    if (want.includes('incidents')) jobs.push(get('/api/work/incidents').then((d) => (counts.incidents = d.toReview.length + d.overdueActions + (d.complaints ? d.complaints.toAcknowledge.length + d.complaints.overdue : 0))));
    if (want.includes('deterioration')) jobs.push(get('/api/work/deterioration').then((d) => (counts.deterioration = d.notEscalated.length + d.open.length)));
    if (want.includes('acuity')) jobs.push(get('/api/work/acuity').then((d) => (counts.acuity = d.unwell.length + d.overdue.length + d.none.length)));
    if (want.includes('allocation')) jobs.push(get('/api/work/allocation').then((d) => (counts.allocation = d.toReview.length + (d.active ? 0 : 1))));
    if (want.includes('team')) jobs.push(get('/api/work/team').then((d) => (counts.team = d.forMe.length + d.toConfirm.length + d.missing.length)));
    if (want.includes('usual')) jobs.push(get('/api/work/usual').then((d) => (counts.usual = d.noticed.length + d.readings.length)));
    if (want.includes('function')) jobs.push(get('/api/work/function').then((d) => (counts.function = d.worse.length + d.due.length)));
    if (want.includes('instruments')) jobs.push(get('/api/work/questionnaires').then((d) => (counts.instruments = d.toInterpret.length + d.due.length)));
    if (want.includes('rules')) jobs.push(get('/api/work/rules').then((d) => (counts.rules = d.toDo)));
    if (want.includes('cdbook')) jobs.push(get('/api/work/controlled-drugs').then((d) => (counts.cdbook = d.toDo)));
    if (want.includes('privacy')) jobs.push(get('/api/work/privacy').then((d) => (counts.privacy = d.toCheck.length + d.toDecide.length + d.toSend.length)));
    if (want.includes('coding')) jobs.push(get('/api/work/coding').then((d) => (counts.coding = d.toCode.length + d.inProgress.length)));
    if (want.includes('codingqueries')) jobs.push(get('/api/work/coding/queries').then((d) => (counts.codingqueries = d.open.length)));
    if (want.includes('external')) jobs.push(get('/api/work/external').then((d) => (counts.external = d.inbox.length + d.toReview.length)));
    if (want.includes('interpreters')) jobs.push(get('/api/work/interpreters').then((d) => (counts.interpreters = d.bookings.filter((b) => b.state === 'REQUESTED').length)));
    if (want.includes('whanau')) jobs.push(get('/api/work/whanau').then((d) => (counts.whanau = d.patients.filter((p) => p.toAsk).length)));
    if (want.includes('capacity')) jobs.push(get('/api/work/capacity').then((d) => (counts.capacity = d.assessments.filter((c) => c.state === 'RAISED' || c.reassessDue).length)));
    if (want.includes('preferences')) jobs.push(get('/api/work/preferences').then((d) => (counts.preferences = d.preferences.filter((p) => !p.read || p.reviewDue).length)));
    if (want.includes('absences')) jobs.push(get('/api/work/leave').then((d) => (counts.absences = d.leave.filter((l) => l.state === 'NOT_RETURNED' || l.overdue || l.actions.includes('approve') || l.actions.includes('depart')).length)));
    if (want.includes('moves')) jobs.push(get('/api/work/moves').then((d) => (counts.moves = d.moves.length)));
    if (want.includes('equipment')) jobs.push(get('/api/work/equipment').then((d) => (counts.equipment = d.equipment.filter((q) => q.state === 'QUARANTINED' || (q.state === 'IN_USE' && q.serviceOverdue)).length)));
    if (want.includes('meals')) jobs.push(get('/api/work/meals').then((d) => (counts.meals = d.orders.filter((o) => o.concern || o.today.some((m) => m.due && !m.record)).length)));
    if (want.includes('restrictions')) jobs.push(get('/api/work/restrictions').then((d) => (counts.restrictions = d.restrictions.filter((r) => r.actions.includes('authorise') || r.actions.includes('read')).length)));
    if (want.includes('wounds')) jobs.push(get('/api/work/wounds').then((rows) => (counts.wounds = rows.filter((w) => w.state === 'IDENTIFIED' || w.due).length)));
    if (want.includes('careplans')) jobs.push(get('/api/work/careplan-reviews').then((rows) => (counts.careplans = rows.length)));
    if (want.includes('flow')) jobs.push(get('/api/work/beds').then((rows) => (counts.flow = rows.filter((b) => b.state === 'AVAILABLE').length)));
    if (want.includes('handover')) jobs.push(Promise.all([get('/api/work/handover'), get('/api/work/handovers/mine')]).then(([g, m]) => (counts.handover = g.reduce((a, p) => a + p.items.filter((i) => !i.myReceipt).length, 0) + m.toAccept.length)));
    await Promise.allSettled(jobs);
  };

  const card = (c) =>
    h('button', { class: 'card home-card', onclick: () => go(TARGET[c.id]) },
      counts[c.id] ? h('span', { class: 'count paua' }, String(counts[c.id])) : null,
      h('div', { class: 'icon-tile' }, icon(c.id)),
      h('h2', {}, c.label),
      h('p', {}, DESCRIPTIONS[c.id]?.(subject) ?? ''),
    );

  const save = async (ids) => {
    Object.assign(home, await put('/api/work/home', { cards: ids.map((id) => ({ id })) }));
    await loadCounts();
    draw();
  };

  // Home is four squares. Any other function you are authorised for opens from More functions, or goes
  // on Home in place of one of the four. Nothing here changes what you are authorised to do.
  const pinDialog = (c) => {
    const replace = select(home.cards.map((x) => [x.id, x.label]), 'Replace which square', null);
    replace.value = home.cards[home.cards.length - 1].id;
    const full = home.cards.length >= 4;
    formDialog(`Put ${c.label} on Home`, h('div', { class: 'stack' },
      full ? field('Take this one off Home', replace) : h('p', { class: 'small' }, 'There is room for it on your Home.')), 'Save', async () => {
      await save(full ? home.cards.map((x) => (x.id === replace.value ? c.id : x.id)) : [...home.cards.map((x) => x.id), c.id]);
      toast('Home saved.');
    });
  };

  const fourDialog = () => {
    const all = [...home.cards, ...home.more, ...home.add];
    const slots = [0, 1, 2, 3].map((i) => {
      const sel = select(all.map((x) => [x.id, x.label]), `Square ${i + 1}`, i === 0 ? null : 'Nothing');
      sel.value = home.cards[i]?.id ?? '';
      return sel;
    });
    dialog('Choose my four', (run, close) => h('div', { class: 'stack' },
      h('p', { class: 'small' }, 'Pick the four functions you use most. The rest stay in the sliders at the top of Home.'),
      slots.map((sel, i) => field(`Square ${i + 1}`, sel)),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: run(async () => {
          await save(slots.map((x) => x.value).filter(Boolean));
          close();
          toast('Home saved.');
        }) }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: run(async () => {
          Object.assign(home, await del('/api/work/home'));
          await loadCounts();
          close();
          draw();
          toast('Home reset to your department default.');
        }) }, 'Reset to default'))));
  };

  const draw = () => {
    // A slider is a strip of functions at the top of Home. It is dragged sideways with the mouse, or swiped on a phone.
    const slider = (title, items, cls, onPick, hint) => {
      if (!items.length) return null;
      items = groupCards(items, (c) => c.id).flatMap((g) => g.items);
      const strip = h('div', { class: 'slider-strip', tabindex: '0', role: 'list', 'aria-label': title },
        items.map((c) => h('button', { class: 'slider-chip', role: 'listitem', title: DESCRIPTIONS[c.id]?.(subject) ?? '', onclick: () => { if (!strip.dataset.dragged) onPick(c); } },
          h('span', { class: 'slider-icon' }, icon(c.id)),
          h('span', { class: 'slider-label' }, c.label),
          counts[c.id] ? h('span', { class: 'slider-count' }, String(counts[c.id])) : null)));
      let startX = 0; let startLeft = 0; let down = false;
      strip.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse') return;
        down = true; startX = e.clientX; startLeft = strip.scrollLeft; delete strip.dataset.dragged;
      });
      strip.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 5) { strip.dataset.dragged = '1'; strip.classList.add('dragging'); }
        strip.scrollLeft = startLeft - dx;
      });
      const end = () => { down = false; strip.classList.remove('dragging'); setTimeout(() => delete strip.dataset.dragged, 0); };
      strip.addEventListener('pointerup', end);
      strip.addEventListener('pointerleave', end);
      return h('section', { class: `slider ${cls}` }, h('div', { class: 'slider-head' }, h('h2', {}, title), h('span', { class: 'small muted' }, hint)), strip);
    };
    mount(root,
      workHeader(),
      slider('More functions', home.more, 'more-functions', (c) => go(TARGET[c.id]), 'Slide to see more. Tap one to open it.'),
      slider('Add a function', home.add, 'add-functions', (c) => pinDialog(c), 'Slide to see more. Tap one to put it on Home.'),
      h('div', { class: 'grid-cards four' }, home.cards.map(card)),
      h('div', { class: 'customise-bar' },
        h('button', { class: 'link-btn', onclick: fourDialog }, 'Choose my four'),
        h('span', { class: 'small muted' }, `${state.me.context.roleLabel} · ${state.me.context.matrixRow}`),
      ),
    );
  };

  draw();
  loadCounts().then(draw);
  return root;
}
