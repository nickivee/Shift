import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field } from '../lib/forms.js';

// Problems: concern → evidence → working problem → confirmed → managed and watched → improving, stable or worse → resolved or inactive → back again.
const TONE = { CONCERN: 'warn', PROVISIONAL: 'warn', ACTIVE: 'danger', RESOLVED: 'muted', INACTIVE: 'muted', RULED_OUT: 'muted', ENTERED_IN_ERROR: 'muted' };
const TREND_TONE = { IMPROVING: 'ok', STABLE: 'muted', WORSENING: 'danger' };

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function raiseDialog(personId, reload) {
  const title = h('input', { type: 'text', 'aria-label': 'Concern', placeholder: 'e.g. New confusion' });
  const evidence = h('textarea', { 'aria-label': 'Evidence', placeholder: 'What you have seen, heard or measured, e.g. "Not recognising her daughter since this morning; pulling at her drip"' });
  const onset = h('input', { type: 'date', 'aria-label': 'Started', max: today() });
  dialog('Raise a concern', h('div', { class: 'stack' },
    field('What the concern is', title), field('What you have seen or been told', evidence), field('When it started (if known)', onset),
    h('p', { class: 'small muted' }, 'A nurse, doctor or therapist will assess it.'),
  ), 'Raise', async () => {
    await post(`/api/work/patients/${personId}/problems`, { title: title.value, evidence: evidence.value, onset: onset.value });
    toast('Raised.');
    reload();
  });
}

function assessDialog(p, action, reload) {
  const title = h('input', { type: 'text', 'aria-label': 'Problem', value: p.title });
  const note = h('textarea', { 'aria-label': 'Assessment', placeholder: action === 'confirm'
    ? 'e.g. Delirium from a urinary infection: 4AT 6, urine culture grew E. coli'
    : 'e.g. Likely delirium; checking for infection, constipation and medicines' });
  dialog(action === 'confirm' ? 'Confirm the problem' : 'Working problem', h('div', { class: 'stack' },
    field('Name it', title), field(action === 'confirm' ? 'The assessment that confirms it' : 'Your assessment so far', note),
  ), action === 'confirm' ? 'Confirm' : 'Save', async () => {
    await post(`/api/work/problems/${p.id}/${action}`, { title: title.value, note: note.value });
    reload();
  });
}

function planDialog(p, reload) {
  const management = h('textarea', { 'aria-label': 'Management', placeholder: 'e.g. Oral antibiotics 5 days; fluids encouraged; family to bring in her glasses' });
  const monitoring = h('textarea', { 'aria-label': 'Monitoring', placeholder: 'e.g. 4AT every morning; fluid balance' });
  const due = h('input', { type: 'date', 'aria-label': 'Look again by', min: today() });
  if (p.management) management.value = p.management;
  if (p.monitoring) monitoring.value = p.monitoring;
  if (p.reviewDue) due.value = p.reviewDue;
  dialog('How it is managed and watched', h('div', { class: 'stack' },
    field('How it is being managed', management), field('What to watch', monitoring), field('Look again by', due),
  ), 'Save', async () => {
    await post(`/api/work/problems/${p.id}/plan`, { management: management.value, monitoring: monitoring.value, reviewDue: due.value });
    reload();
  });
}

function reviewDialog(p, trends, reload) {
  let trend = '';
  const note = h('textarea', { 'aria-label': 'Based on', placeholder: 'e.g. 4AT 2 today, eating half her meals' });
  const due = h('input', { type: 'date', 'aria-label': 'Next look', min: today() });
  dialog('Review', h('div', { class: 'stack' },
    h('fieldset', { class: 'row' }, h('legend', {}, 'How is it?'), Object.entries(trends).map(([k, v]) => h('label', { class: `trend-choice trend-${k.toLowerCase()}` },
      h('input', { type: 'radio', name: 'trend', value: k, onchange: () => { trend = k; } }), v))),
    field('What you are basing this on', note), field('Next look (optional)', due),
  ), 'Save', async () => {
    await post(`/api/work/problems/${p.id}/review`, { trend, note: note.value, reviewDue: due.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  evidence: ['Add evidence', 'What you have seen, heard or measured', 'e.g. Temp 38.2, urine cloudy and smelly'],
  resolve: ['Resolved', 'How it resolved', 'e.g. 4AT 0 for two days; back to her usual self'],
  inactive: ['Inactive', 'Why it is inactive', 'e.g. Controlled on current medicines; no active management'],
  'rule-out': ['Ruled out', 'Why it was ruled out', 'e.g. Bloods and urine normal; confusion was from poor sleep and has settled'],
  recur: ['Back again', 'What shows it is back', 'e.g. Confused again overnight; 4AT 5'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person'],
};
function noteDialog(p, action, reload) {
  const [title, label, placeholder] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), 'Save', async () => {
    await post(`/api/work/problems/${p.id}/${action}`, { note: note.value });
    reload();
  });
}

const LABELS = { evidence: 'Add evidence', provisional: 'Working problem', confirm: 'Confirm', 'rule-out': 'Rule out', plan: 'Management', review: 'Review', resolve: 'Resolved', inactive: 'Inactive', recur: 'Back again', error: 'Entered in error' };

function problemCard(p, d, reload) {
  const handler = (a) => () => (a === 'provisional' || a === 'confirm' ? assessDialog(p, a, reload)
    : a === 'plan' ? planDialog(p, reload) : a === 'review' ? reviewDialog(p, d.trends, reload) : noteDialog(p, a, reload));
  const primary = p.state === 'ACTIVE' ? (p.management ? 'review' : 'plan') : p.state === 'RESOLVED' || p.state === 'INACTIVE' ? null : 'confirm';
  return h('div', { class: `tile stack problem problem-${p.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('h3', {}, p.title, p.recurrences ? h('span', { class: 'small muted' }, ` · back ${p.recurrences === 1 ? 'once' : `${p.recurrences} times`}`) : null),
      h('div', { class: 'row' },
        p.trendLabel ? h('span', { class: `tag ${TREND_TONE[p.trend]}` }, p.trendLabel) : null,
        h('span', { class: `tag ${TONE[p.state]}` }, p.stateLabel))),
    h('div', { class: 'small muted' }, `Raised by ${p.raisedBy} ${fmtDateTime(p.raisedAt)}${p.onset ? ` · started ${p.onset}` : ''}${p.assessedBy ? ` · assessed by ${p.assessedBy}` : ''}`),
    p.assessment ? h('div', {}, p.assessment) : null,
    p.management || p.monitoring ? h('dl', { class: 'death-facts' },
      p.management ? [h('dt', {}, 'Managing'), h('dd', {}, p.management)] : null,
      p.monitoring ? [h('dt', {}, 'Watching'), h('dd', {}, p.monitoring)] : null,
      p.reviewDue ? [h('dt', {}, 'Look again'), h('dd', { class: p.reviewOverdue ? 'overdue' : '' }, p.reviewOverdue ? `${p.reviewDue} (overdue)` : p.reviewDue)] : null) : null,
    p.state === 'ACTIVE' && !p.management ? h('div', { class: 'notice small' }, 'No management or monitoring recorded yet.') : null,
    p.closeNote ? h('div', { class: 'small muted' }, `${p.stateLabel} ${fmtDateTime(p.closedAt)} by ${p.closedBy}: ${p.closeNote}`) : null,
    p.can.length ? h('div', { class: 'row' }, p.can.map((a) => h('button', { class: `btn small${a === primary ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${p.steps.length})`),
      h('ol', { class: 'det-steps' }, p.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Problems view in the Live Workstation.
export function problemsPanel(personId, d, reload, addButton) {
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      d.canRecord ? h('button', { class: 'btn primary', onclick: () => raiseDialog(personId, reload) }, 'Raise a concern') : null,
      addButton),
    d.open.length ? d.open.map((p) => problemCard(p, d, reload)) : h('div', { class: 'card empty' }, 'No open problems or concerns.'),
    d.past.length ? h('details', {}, h('summary', {}, `Resolved and inactive (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((p) => problemCard(p, d, reload)))) : null,
    d.other.length ? h('details', {}, h('summary', {}, `Ruled out or in error (${d.other.length})`), h('div', { class: 'stack' }, d.other.map((p) => problemCard(p, d, reload)))) : null,
  );
}

function row(p) {
  return h('div', { class: `tile stack problem-${p.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${p.personId}/problems`) }, h('b', {}, p.patient)),
        p.location ? h('span', { class: 'small muted' }, ` · ${p.location}`) : null),
      h('div', { class: 'row' }, p.trendLabel ? h('span', { class: `tag ${TREND_TONE[p.trend]}` }, p.trendLabel) : null, h('span', { class: `tag ${TONE[p.state]}` }, p.stateLabel))),
    h('div', {}, h('b', {}, p.title)),
    h('div', { class: 'small muted' }, p.state === 'ACTIVE'
      ? (p.reviewDue ? `Look again by ${p.reviewDue}${p.reviewOverdue ? ' (overdue)' : ''}` : 'No review date')
      : `Raised by ${p.raisedBy} ${fmtDateTime(p.raisedAt)}`),
  );
}

// Home → Problem list.
export async function problemsView() {
  const d = await get('/api/work/problems');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Problem list', () => go('/work/home')),
    h('div', { class: 'banner' }, `Concerns waiting to be assessed and problems due another look, for people in your service. ${d.active} active problem${d.active === 1 ? '' : 's'} in all.`),
    section('Concerns to assess', d.toAssess, 'None.'),
    section('Getting worse', d.worse, 'None.'),
    section('Due for review', d.dueReview, 'None due.'),
  );
}
