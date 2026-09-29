import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Recalls: set up → due → still eligible → invited → booked → came or did not come → outcome → next recall or end.
const TONE = { SCHEDULED: 'muted', INVITED: 'warn', BOOKED: 'ok', DID_NOT_ATTEND: 'danger', DONE: 'muted', EXITED: 'muted', ENTERED_IN_ERROR: 'muted' };

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const send = (x, action, body) => post(`/api/work/recalls/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

function setUpDialog(personId, o, reload) {
  const kind = select(o.kinds.map((k) => [k.id, k.label]), 'Recall');
  const what = h('input', { type: 'text', 'aria-label': 'What exactly', placeholder: 'Optional, e.g. Bone density scan' });
  const every = select(Object.entries(o.intervals), 'How often');
  const due = h('input', { type: 'date', 'aria-label': 'Due', min: addDays(0) });
  kind.addEventListener('change', () => {
    const k = o.kinds.find((x) => x.id === kind.value);
    if (k) { every.value = String(k.everyDays ?? 0); if (!due.value && k.everyDays) due.value = addDays(k.everyDays); }
  });
  const detail = h('textarea', { 'aria-label': 'Detail', placeholder: 'Optional' });
  dialog('Set up a recall', h('div', { class: 'stack' }, field('Recall', kind), field('What exactly', what), field('How often', every), field('Due', due), field('Detail', detail)),
    'Set up', async () => {
      await post(`/api/work/patients/${personId}/recalls`, { kind: kind.value, what: what.value, every: every.value, dueDate: due.value, detail: detail.value });
      toast('Recall set up.');
      reload();
    });
}

function checkDialog(x, reload) {
  let eligible = '';
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed if no, e.g. Allergic reaction to last year\'s vaccine' });
  dialog(`Still eligible: ${x.what}`, h('div', { class: 'stack' },
    h('fieldset', { class: 'row' }, h('legend', {}, 'Is the recall still right for them?'),
      choice('eligible', 'YES', 'Yes', () => { eligible = 'YES'; }), choice('eligible', 'NO', 'No, end it', () => { eligible = 'NO'; })),
    field('Note', note)), 'Save', async () => {
    await send(x, 'check', { eligible, note: note.value });
    reload();
  });
}

function inviteDialog(x, o, reload) {
  const channel = select(Object.entries(o.channels), 'How');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed for whānau: who you spoke to' });
  dialog(`Invite: ${x.what}`, h('div', { class: 'stack' }, field('How you contacted them', channel), field('Note', note)), 'Save', async () => {
    await send(x, 'invite', { channel: channel.value, note: note.value });
    reload();
  });
}

function bookDialog(x, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When' });
  const where = h('input', { type: 'text', 'aria-label': 'Where', placeholder: 'e.g. Treatment room' });
  dialog(`Book: ${x.what}`, h('div', { class: 'stack' }, field('When', when), field('Where', where)), 'Book', async () => {
    await send(x, 'book', { when: when.value ? new Date(when.value).toISOString() : '', where: where.value });
    reload();
  });
}

function attendedDialog(x, reload) {
  let next = x.everyDays ? 'NEXT' : 'STOP';
  const outcome = h('textarea', { 'aria-label': 'Outcome', placeholder: 'e.g. Vaccine given, left arm; no reaction' });
  const nextDue = h('input', { type: 'date', 'aria-label': 'Next due', min: addDays(1), value: x.nextDue ?? '' });
  const nextField = field('Next due', nextDue);
  nextField.hidden = next !== 'NEXT';
  const pick = (v) => () => { next = v; nextField.hidden = v !== 'NEXT'; };
  const yes = choice('next', 'NEXT', 'Set the next recall', pick('NEXT'));
  const no = choice('next', 'STOP', 'No more recalls', pick('STOP'));
  (next === 'NEXT' ? yes : no).querySelector('input').checked = true;
  dialog(`They came: ${x.what}`, h('div', { class: 'stack' }, field('Outcome', outcome),
    h('fieldset', { class: 'row' }, h('legend', {}, 'What next?'), yes, no), nextField), 'Save', async () => {
    await send(x, 'attended', { note: outcome.value, next, nextDue: nextDue.value });
    reload();
  });
}

function exitDialog(x, o, reload) {
  const reason = select(Object.entries(o.exitReasons), 'Why');
  const note = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Moved to another rest home' });
  dialog(`End: ${x.what}`, h('div', { class: 'stack' }, field('Why', reason), field('What happened', note)), 'End recall', async () => {
    await send(x, 'exit', { reason: reason.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  dna: ['Did not attend', 'What happened', 'e.g. Not in her room when the optometrist came', 'Save'],
  error: ['Entered in error', 'Why', 'e.g. Set up for the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.what}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = {
  check: 'Still eligible?', invite: 'Invite', book: 'Book', attended: 'They came', dna: 'Did not attend', exit: 'End recall', error: 'Entered in error',
};
const PRIMARY = ['check', 'invite', 'book', 'attended'];

function recallCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'check' ? checkDialog(x, reload) : a === 'invite' ? inviteDialog(x, o, reload) : a === 'book' ? bookDialog(x, reload)
    : a === 'attended' ? attendedDialog(x, reload) : a === 'exit' ? exitDialog(x, o, reload) : noteDialog(x, a, reload));
  const flag = x.overdue ? 'Overdue' : null;
  return h('div', { class: `tile stack recall recall-${x.state.toLowerCase()}${x.overdue ? ' recall-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/recalls`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.what), h('span', { class: `tag ${flag ? 'danger' : TONE[x.state]}` }, flag ?? x.stateLabel)),
    h('div', { class: 'small' }, `${x.everyLabel} · due ${x.dueDate}`),
    x.detail ? h('div', { class: 'small' }, x.detail) : null,
    h('div', { class: 'small muted' }, [
      `Set up by ${x.setBy}`, x.checkedBy ? `still eligible (${x.checkedBy})` : ['SCHEDULED'].includes(x.state) ? 'eligibility not checked yet' : null,
      x.invitedBy ? `invited ${fmtDateTime(x.invitedAt)} (${x.channelLabel.toLowerCase()})` : null,
    ].filter(Boolean).join(' · ')),
    x.inviteNote && x.state === 'INVITED' ? h('div', { class: 'small' }, x.inviteNote) : null,
    x.bookedFor && ['BOOKED', 'DID_NOT_ATTEND'].includes(x.state) ? h('div', { class: 'small' }, h('b', {}, 'Booked: '), `${fmtDateTime(x.bookedFor)} · ${x.bookedWhere}`) : null,
    x.state === 'DID_NOT_ATTEND' ? h('div', { class: 'small' }, h('b', {}, 'Did not attend: '), x.dnaNote) : null,
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `Outcome (${x.doneBy}, ${fmtDateTime(x.doneAt)}): `), x.outcome) : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.exitLabel ?? x.stateLabel} (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Recalls view in the Live Workstation.
export function recallsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canSetUp ? h('div', {}, h('button', { class: 'btn primary', onclick: () => setUpDialog(personId, d.options, reload) }, 'Set up a recall')) : null,
    d.open.length ? d.open.map((x) => recallCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No recalls.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Done or ended (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => recallCard(x, d, reload)))) : null,
  );
}

// Home → Recalls.
export async function recallsView() {
  const d = await get('/api/work/recalls');
  const view = { options: { kinds: [], intervals: {}, channels: {}, exitReasons: {} } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => recallCard({ ...x, actions: [] }, view, () => go('/work/recalls'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Recalls', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Recalls for people in your service: overdue, due in the next 30 days, booked, and those who did not come. Open the person to act.'),
    section('Overdue', d.overdue, 'Nothing overdue.'),
    section('Due in the next 30 days', d.dueSoon, 'Nothing due soon.'),
    section('Booked', d.booked, 'Nothing booked.'),
    section('Did not attend', d.dna, 'Nobody missed a booking.'),
  );
}
