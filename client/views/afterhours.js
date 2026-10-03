import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// After-hours: a contact outside usual hours is recorded, then reviewed by the day team.
const TONE = { OPEN: 'warn', REVIEWED: 'muted', ENTERED_IN_ERROR: 'muted' };
const send = (x, action, body) => post(`/api/work/afterhours/${x.id}/${action}`, body);

function recordDialog(personId, o, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When it was' });
  const caller = select(o.callers.map((c) => [c.code, c.label]), 'Who made contact');
  const concern = h('textarea', { 'aria-label': 'What they were worried about', placeholder: 'e.g. Pain not settling since the evening dose' });
  const advice = h('textarea', { 'aria-label': 'Advice given or what was done', placeholder: 'e.g. Took the extra dose as charted; rang back in an hour' });
  const outcome = select(o.outcomes.map((c) => [c.code, c.label]), 'What came of it');
  const note = h('input', { type: 'text', 'aria-label': 'Note', placeholder: 'Needed if it was something else' });
  dialog('Record an after-hours contact', h('div', { class: 'stack' }, field('When it was', when), field('Who made contact', caller), field('What they were worried about', concern),
    field('Advice given or what was done', advice), field('What came of it', outcome), field('Note', note)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/afterhours`, { when: when.value ? new Date(when.value).toISOString() : '', caller: caller.value, concern: concern.value, advice: advice.value, outcome: outcome.value, note: note.value });
    toast('After-hours contact recorded.');
    reload();
  });
}

const NOTE = {
  review: ['Review for the day team', 'What the day team did or decided', 'e.g. Rang them; pain settled; dose changed', 'Save review'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => { await send(x, action, { note: note.value }); reload(); });
}

const LABELS = { review: 'Review', error: 'Entered in error' };

function contactCard(x, reload, showPatient = false) {
  return h('div', { class: `tile stack afterhours afterhours-${x.state.toLowerCase()}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/afterhours`) }, h('b', {}, x.patient))) : null,
    h('div', { class: 'spread' }, h('h3', {}, fmtDateTime(x.contactAt)), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `${x.callerLabel}: `), x.concern),
    h('div', { class: 'small' }, h('b', {}, 'Advice: '), x.advice),
    h('div', { class: 'small' }, h('b', {}, `${x.outcomeLabel}`), x.outcomeNote ? `. ${x.outcomeNote}` : '', ` · recorded by ${x.recordedBy}`),
    x.state === 'REVIEWED' ? h('div', { class: 'small' }, h('b', {}, `Reviewed (${x.reviewedBy}, ${fmtDateTime(x.reviewedAt)}): `), x.reviewNote) : null,
    x.state === 'ENTERED_IN_ERROR' ? h('div', { class: 'small' }, h('b', {}, 'Entered in error: '), x.reviewNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'review' ? ' primary' : ''}`, onclick: () => noteDialog(x, a, reload) }, LABELS[a]))) : null,
  );
}

// The person's After-hours view in the Live Workstation.
export function afterhoursPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d.options, reload) }, 'Record an after-hours contact')) : null,
    d.open.length ? d.open.map((x) => contactCard(x, reload)) : h('div', { class: 'card empty' }, 'Nothing waiting for review.'),
    d.past.length ? h('details', {}, h('summary', {}, `Earlier contacts (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((x) => contactCard(x, reload)))) : null,
  );
}

// Home → After-hours.
export async function afterhoursView() {
  const d = await get('/api/work/afterhours');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => contactCard({ ...x, actions: [] }, () => go('/work/afterhours'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('After-hours', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Contacts made outside usual hours that the day team has not yet reviewed. Open the person to review one.'),
    section('To review', d.toReview, 'Nothing waiting for review.'),
    section('Reviewed in the last 7 days', d.reviewed, 'Nothing reviewed this week.'),
  );
}
