import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Education: what was explained, to whom, how well it was understood, and whether more teaching is needed.
const TONE = { DONE: 'ok', FOLLOW_UP: 'warn', ENTERED_IN_ERROR: 'muted' };
const send = (x, action, body) => post(`/api/work/education/${x.id}/${action}`, body);

function recordDialog(personId, o, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When it was' });
  const topic = h('input', { type: 'text', 'aria-label': 'What was explained', placeholder: 'e.g. Using the inhaler and spacer' });
  const to = select(o.givenTo.map((c) => [c.code, c.label]), 'Who it was given to');
  const understanding = select(o.understanding.map((c) => [c.code, c.label]), 'How well it was understood');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed unless it was understood, e.g. Could not show the spacer step; will practise again' });
  dialog('Record education', h('div', { class: 'stack' }, field('When it was', when), field('What was explained', topic), field('Who it was given to', to),
    field('How well it was understood', understanding), field('Note', note)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/education`, { when: when.value ? new Date(when.value).toISOString() : '', topic: topic.value, givenTo: to.value, understanding: understanding.value, note: note.value });
    toast('Education recorded.');
    reload();
  });
}

const NOTE = {
  complete: ['More teaching done', 'What was done and how well it was understood', 'e.g. Went through it again; showed it back correctly', 'Save'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => { await send(x, action, { note: note.value }); reload(); });
}

const LABELS = { complete: 'More teaching done', error: 'Entered in error' };

function sessionCard(x, reload, showPatient = false) {
  return h('div', { class: `tile stack education education-${x.state.toLowerCase()}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/education`) }, h('b', {}, x.patient))) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.topic), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, fmtDateTime(x.givenAt)), ` · given to ${x.givenToLabel.toLowerCase()} · ${x.understandingLabel}`),
    x.note ? h('div', { class: 'small' }, x.note) : null,
    h('div', { class: 'small muted' }, `Recorded by ${x.recordedBy}`),
    x.closedNote ? h('div', { class: 'small' }, h('b', {}, `${x.state === 'ENTERED_IN_ERROR' ? 'Entered in error' : 'More teaching'} (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), x.closedNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'complete' ? ' primary' : ''}`, onclick: () => noteDialog(x, a, reload) }, LABELS[a]))) : null,
  );
}

// The person's Education view in the Live Workstation.
export function educationPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d.options, reload) }, 'Record education')) : null,
    d.more.length ? d.more.map((x) => sessionCard(x, reload)) : h('div', { class: 'card empty' }, 'No more teaching needed.'),
    d.given.length ? h('details', {}, h('summary', {}, `Education given (${d.given.length})`), h('div', { class: 'stack' }, d.given.map((x) => sessionCard(x, reload)))) : null,
  );
}

// Home → Education.
export async function educationView() {
  const d = await get('/api/work/education');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => sessionCard({ ...x, actions: [] }, () => go('/work/education'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Education', () => go('/work/home')),
    h('div', { class: 'banner' }, 'People who need more teaching, and education given this week. Open the person to record or follow up.'),
    section('More teaching needed', d.moreNeeded, 'No one needs more teaching.'),
    section('Given in the last 7 days', d.recent, 'Nothing recorded this week.'),
  );
}
