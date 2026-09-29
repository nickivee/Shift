import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Antimicrobials: indication → decision → agent and order → how long → lab results → review →
// continue, change or stop → completed → outcome.
const TONE = { ACTIVE: 'ok', CHANGED: 'muted', COMPLETED: 'muted', STOPPED: 'muted', ENTERED_IN_ERROR: 'muted' };

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const send = (x, action, body) => post(`/api/work/antimicrobials/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

// The drug part of starting or changing a course.
function drugFields(o, x = null) {
  const agent = h('input', { type: 'text', 'aria-label': 'Antimicrobial', placeholder: 'e.g. Amoxicillin and clavulanic acid' });
  const route = select(Object.entries(o.routes), 'Route');
  const dose = h('input', { type: 'text', 'aria-label': 'Dose and how often', placeholder: 'As on the chart, e.g. 1.2 g every 8 hours' });
  const orderRef = h('input', { type: 'text', 'aria-label': 'Where it is ordered', value: 'Medication chart' });
  const days = h('input', { type: 'number', 'aria-label': 'Days', min: 1, max: 90, value: x ? Math.max(1, x.plannedDays - x.day + 1) : 5 });
  const reviewBy = h('input', { type: 'date', 'aria-label': 'Review by', min: addDays(0), value: addDays(o.reviewDays) });
  const intent = select(Object.entries(o.intents), 'Why');
  if (x) intent.value = x.intent;
  return {
    body: () => ({ agent: agent.value, route: route.value, dose: dose.value, orderRef: orderRef.value, days: days.value, reviewBy: reviewBy.value, intent: intent.value }),
    fields: [field('Antimicrobial', agent), field('Route', route), field('Dose and how often', dose), field('Where it is ordered', orderRef),
      field('Days', days), field('Review by', reviewBy), field('Why', intent)],
  };
}

function startDialog(personId, d, reload) {
  const o = d.options;
  const infection = select(o.infections.map((i) => [i.id, i.label]), 'For', 'Not for a recorded infection');
  const indication = h('input', { type: 'text', 'aria-label': 'What it is for', placeholder: 'Needed if not for a recorded infection, e.g. Before hip surgery' });
  const drug = drugFields(o);
  const note = h('input', { type: 'text', 'aria-label': 'Who decided', placeholder: d.medical ? 'Optional' : 'e.g. Dr Nair (GP) by phone' });
  if (o.infections.length) infection.value = o.infections[0].id;
  dialog('Start antimicrobial', h('div', { class: 'stack' }, field('For', infection), field('What it is for', indication), ...drug.fields, field('Who decided', note)),
    'Start', async () => {
      await post(`/api/work/patients/${personId}/antimicrobials`, { infectionId: infection.value, indication: indication.value, note: note.value, ...drug.body() });
      toast('Antimicrobial course started.');
      reload();
    });
}

function microDialog(x, o, reload) {
  const micro = select(Object.entries(o.micro), 'For this antimicrobial');
  const note = h('textarea', { 'aria-label': 'Result', placeholder: 'e.g. Sputum: Streptococcus pneumoniae, sensitive to amoxicillin' });
  dialog(`Lab result: ${x.agent}`, h('div', { class: 'stack' }, field('Result', note), field('For this antimicrobial', micro)), 'Save', async () => {
    await send(x, 'micro', { micro: micro.value, note: note.value });
    reload();
  });
}

function reviewDialog(x, o, reload) {
  let decision = '';
  const note = h('textarea', { 'aria-label': 'Your review', placeholder: 'e.g. Afebrile, eating; sensitive to amoxicillin, switch to oral' });
  const next = h('input', { type: 'date', 'aria-label': 'Next review', min: addDays(1), max: x.endDate, value: [addDays(2), x.endDate].sort()[0] });
  const nextField = field('Next review', next);
  const change = select(Object.entries(o.changes), 'Kind of change');
  const drug = drugFields(o, x);
  const changeBlock = h('div', { class: 'stack' }, field('Kind of change', change), h('div', { class: 'small muted' }, 'The new course:'), ...drug.fields);
  const reason = select(Object.entries(o.stopReasons), 'Why stop');
  const stopField = field('Why stop', reason);
  const sync = () => { nextField.hidden = decision !== 'CONTINUE'; changeBlock.hidden = decision !== 'CHANGE'; stopField.hidden = decision !== 'STOP'; };
  sync();
  dialog(`Review: ${x.agent}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, `Day ${x.day} of ${x.plannedDays}${x.microNote ? ` · Lab: ${x.microNote}` : ''}`),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Decision'), Object.entries(o.decisions).map(([k, v]) => choice('decision', k, v, () => { decision = k; sync(); }))),
    field('Your review', note), nextField, changeBlock, stopField), 'Save review', async () => {
    const body = { decision, note: note.value };
    if (decision === 'CONTINUE') body.reviewBy = next.value;
    if (decision === 'CHANGE') Object.assign(body, { change: change.value }, drug.body());
    if (decision === 'STOP') body.reason = reason.value;
    await send(x, 'review', body);
    reload();
  });
}

function completeDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Last dose given 0800' });
  dialog(`Completed: ${x.agent}`, field('Note', note), 'Completed', async () => {
    await send(x, 'complete', { note: note.value });
    reload();
  });
}

function outcomeDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcomes), 'Outcome');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed if it did not work or caused a problem' });
  dialog(`Outcome: ${x.agent}`, h('div', { class: 'stack' }, field('Outcome', outcome), field('Note', note)), 'Save', async () => {
    await send(x, 'outcome', { outcome: outcome.value, note: note.value });
    reload();
  });
}

function errorDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Started for the wrong person' });
  dialog(`Entered in error: ${x.agent}`, field('Why', note), 'Mark as error', async () => {
    await send(x, 'error', { note: note.value });
    reload();
  });
}

const LABELS = { micro: 'Lab result', review: 'Review', complete: 'Completed', outcome: 'Outcome', error: 'Entered in error' };
const PRIMARY = ['review', 'complete', 'outcome'];

function courseCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'micro' ? microDialog(x, o, reload) : a === 'review' ? reviewDialog(x, o, reload) : a === 'complete' ? completeDialog(x, reload)
    : a === 'outcome' ? outcomeDialog(x, o, reload) : errorDialog(x, reload));
  const flag = x.notCovered ? ['Not covered by the lab result', 'danger'] : x.reviewOverdue ? ['Review overdue', 'danger'] : x.reviewToday ? ['Review today', 'warn']
    : x.finishing ? ['Due to finish', 'warn'] : x.needsOutcome ? ['Outcome needed', 'warn'] : [x.stateLabel, TONE[x.state]];
  const tone = x.state !== 'ACTIVE' ? (x.needsOutcome ? 'waiting' : 'ended') : x.notCovered || x.reviewOverdue ? 'alert' : x.reviewToday || x.finishing ? 'waiting' : 'active';
  return h('div', { class: `tile stack amc amc-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/antimicrobials`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, `${x.agent} ${x.routeLabel}`), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'small' }, `${x.dose} · ${x.orderRef}`),
    h('div', { class: 'small' }, h('b', {}, 'For: '), `${x.infectionLabel ?? x.indication} · ${x.intentLabel.toLowerCase()}`),
    h('div', { class: 'small' }, x.state === 'ACTIVE' ? `Day ${x.day} of ${x.plannedDays} · ends ${x.endDate} · review by ${x.reviewBy}` : `${x.startDate} to ${x.endedAt ? x.endedAt.slice(0, 10) : x.endDate}`),
    x.changeLabel && x.previousId ? h('div', { class: 'small muted' }, `${x.changeLabel} from the earlier course`) : null,
    x.microNote ? h('div', { class: 'small' }, h('b', {}, `Lab${x.microLabel ? ` (${x.microLabel.toLowerCase()})` : ''}: `), x.microNote) : null,
    h('div', { class: 'small muted' }, `Started by ${x.decidedBy}${x.decisionNote ? ` · ${x.decisionNote}` : ''}`),
    x.state === 'STOPPED' || x.state === 'CHANGED' ? h('div', { class: 'small' }, h('b', {}, `${x.stopLabel ?? x.changeLabel ?? x.stateLabel} (${x.endedBy}): `), x.endedNote ?? '') : null,
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `Outcome (${x.outcomeBy}): `), `${x.outcomeLabel}${x.outcomeNote ? `. ${x.outcomeNote}` : ''}`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Antimicrobials view in the Live Workstation.
export function antimicrobialsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canStart ? h('div', {}, h('button', { class: 'btn primary', onclick: () => startDialog(personId, d, reload) }, 'Start antimicrobial')) : null,
    d.active.length ? d.active.map((x) => courseCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No antimicrobials now.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier courses (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => courseCard(x, d, reload)))) : null,
  );
}

// Home → Antimicrobials.
export async function antimicrobialsView() {
  const d = await get('/api/work/antimicrobials');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => courseCard({ ...x, actions: [] }, view, () => go('/work/antimicrobials'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Antimicrobials', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Antimicrobial courses in your service: reviews due or overdue, courses due to finish, outcomes to record, and the rest. Open the person to act.'),
    section('To review', d.toReview, 'No reviews due.'),
    section('Due to finish', d.finishing, 'Nothing due to finish.'),
    section('Outcome to record', d.outcome, 'No outcomes waiting.'),
    section('Other courses', d.others, 'No other courses.'),
  );
}
