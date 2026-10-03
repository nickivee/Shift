import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field } from '../lib/forms.js';

// Chronic care: a long-term condition plan, its goals, the next review the clinician chooses, and each review.
const send = (x, action, body) => post(`/api/work/chronic/${x.id}/${action}`, body);

function startDialog(personId, reload) {
  const condition = h('input', { type: 'text', 'aria-label': 'Condition', placeholder: 'e.g. Type 2 diabetes' });
  const goals = h('textarea', { 'aria-label': 'Goals', placeholder: 'e.g. Keep blood sugar steady; check feet daily' });
  const due = h('input', { type: 'date', 'aria-label': 'Next review' });
  dialog('Start a care plan', h('div', { class: 'stack' }, field('Condition', condition), field('Goals', goals), field('Next review', due)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/chronic`, { condition: condition.value, goals: goals.value, reviewDue: due.value });
    toast('Care plan started.');
    reload();
  });
}

function reviewDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'How the review went', placeholder: 'e.g. Blood sugar steady; no change to medicines' });
  const due = h('input', { type: 'date', 'aria-label': 'Next review' });
  dialog(`Review: ${x.condition}`, h('div', { class: 'stack' }, field('How the review went', note), field('Next review', due)), 'Save review', async () => { await send(x, 'review', { note: note.value, reviewDue: due.value }); reload(); });
}

const NOTE = {
  end: ['End the plan', 'Why the plan ends', 'e.g. Condition resolved', 'End plan'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => { await send(x, action, { note: note.value }); reload(); });
}

const LABELS = { review: 'Record a review', end: 'End plan', error: 'Entered in error' };

function planCard(x, reload, showPatient = false) {
  const tone = x.overdue ? 'danger' : x.dueSoon ? 'warn' : x.state === 'ACTIVE' ? 'ok' : 'muted';
  return h('div', { class: `tile stack chronic chronic-${x.state.toLowerCase()}${x.overdue ? ' chronic-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/chronic`) }, h('b', {}, x.patient))) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.condition), h('span', { class: `tag ${tone}` }, x.overdue ? 'Review overdue' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Goals: '), x.goals),
    x.state === 'ACTIVE' ? h('div', { class: 'small' }, h('b', {}, `Next review ${x.reviewDue}`), x.lastReviewedAt ? ` · last reviewed ${fmtDateTime(x.lastReviewedAt)}` : ' · not yet reviewed') : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy}): `), x.endedNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'review' ? ' primary' : ''}`, onclick: () => (a === 'review' ? reviewDialog(x, reload) : noteDialog(x, a, reload)) }, LABELS[a]))) : null,
    x.log ? h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))) : null,
  );
}

// The person's Chronic Care view in the Live Workstation.
export function chronicPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => startDialog(personId, reload) }, 'Start a care plan')) : null,
    d.active.length ? d.active.map((x) => planCard(x, reload)) : h('div', { class: 'card empty' }, 'No active care plans.'),
    d.past.length ? h('details', {}, h('summary', {}, `Past plans (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((x) => planCard(x, reload)))) : null,
  );
}

// Home → Chronic care.
export async function chronicView() {
  const d = await get('/api/work/chronic');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => planCard({ ...x, actions: [], log: null }, () => go('/work/chronic'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Chronic care', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Long-term condition plans and their next review. Open the person to record a review.'),
    section('Review overdue', d.overdue, 'No reviews overdue.'),
    section('Due in the next 30 days', d.soon, 'Nothing due in the next 30 days.'),
    d.later.length ? section('Later', d.later, '') : null,
  );
}
