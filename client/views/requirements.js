import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Requirements: generated → waiting to be assigned → assigned and accepted → actioned, deferred or cancelled → outcome → closed.
const TONE = { PENDING: 'warn', ASSIGNED: 'ok', ACTIONED: 'ok', DEFERRED: 'muted', CANCELLED: 'muted', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };
const PRIORITY_TONE = { URGENT: 'danger', TODAY: 'warn', ROUTINE: 'muted' };

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const send = (x, action, body) => post(`/api/work/requirements/${x.id}/${action}`, body);

function addDialog(personId, o, reload) {
  const what = h('input', { type: 'text', 'aria-label': 'What needs doing', placeholder: 'e.g. Organise a hoist assessment before discharge' });
  const detail = h('textarea', { 'aria-label': 'Detail', placeholder: 'Optional, e.g. Transfers need two people; family want to take her home' });
  const priority = select(Object.entries(o.priorities), 'How soon');
  priority.value = 'ROUTINE';
  const by = h('input', { type: 'date', 'aria-label': 'Due by', min: today() });
  const from = h('input', { type: 'text', 'aria-label': 'Where it came from', placeholder: 'Optional, e.g. Ward round; family meeting' });
  dialog('Add a requirement', h('div', { class: 'stack' },
    field('What needs doing', what), field('Detail', detail), field('How soon', priority), field('Due by (optional)', by), field('Where it came from', from),
  ), 'Add', async () => {
    await post(`/api/work/patients/${personId}/requirements`, { what: what.value, detail: detail.value, priority: priority.value, dueBy: by.value, from: from.value });
    toast('Requirement added.');
    reload();
  });
}

function assignDialog(x, o, reload) {
  const to = select(o.colleagues.map((c) => [c.id, c.label]), 'Assign to');
  const note = h('input', { type: 'text', 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Assign: ${x.what}`, h('div', { class: 'stack' }, field('Assign to', to), field('Note', note),
    h('p', { class: 'small muted' }, 'They accept it before working on it.')), 'Assign', async () => {
    await send(x, 'assign', { to: to.value, note: note.value });
    reload();
  });
}

function deferDialog(x, o, reload) {
  const reason = select(Object.entries(o.deferReasons), 'Why');
  const until = h('input', { type: 'date', 'aria-label': 'Come back to it on', min: today() });
  const note = h('textarea', { 'aria-label': 'Meanwhile', placeholder: 'e.g. Waiting for her HbA1c; will book once it is back' });
  dialog(`Defer: ${x.what}`, h('div', { class: 'stack' }, field('Why', reason), field('Come back to it on', until), field('What happens in the meantime', note)), 'Defer', async () => {
    await send(x, 'defer', { reason: reason.value, until: until.value, note: note.value });
    reload();
  });
}

function closeDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcomes), 'Outcome');
  if (x.state === 'ACTIONED') outcome.value = 'MET';
  const note = h('textarea', { 'aria-label': 'What the outcome was', placeholder: 'Needed unless the need was met' });
  dialog(`Outcome: ${x.what}`, h('div', { class: 'stack' }, field('Outcome', outcome), field('What the outcome was', note)), 'Close it', async () => {
    await send(x, 'close', { outcome: outcome.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  accept: ['Accept', 'Note', 'Optional', 'Accept'],
  action: ['Actioned', 'What was done', 'e.g. Mattress ordered and on her bed at 2 pm', 'Save'],
  release: ['Hand back', 'Why', 'e.g. Going off shift; not started', 'Hand back'],
  resume: ['End the deferral', 'Note', 'Optional, e.g. Result is back', 'Put back on the list'],
  cancel: ['Cancel', 'Why it is no longer needed', 'e.g. Going home with her daughter instead', 'Cancel requirement'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
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
  take: 'Take it on', accept: 'Accept', action: 'Actioned', assign: 'Assign', release: 'Hand back', defer: 'Defer', resume: 'End deferral',
  close: 'Record outcome', cancel: 'Cancel', error: 'Entered in error',
};
const PRIMARY = ['take', 'accept', 'action', 'close'];

function requirementCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => async () => {
    if (a === 'take') { await send(x, 'take', {}); toast('It is yours now.'); reload(); return; }
    if (a === 'assign') return assignDialog(x, o, reload);
    if (a === 'defer') return deferDialog(x, o, reload);
    if (a === 'close') return closeDialog(x, o, reload);
    return noteDialog(x, a, reload);
  };
  const flag = x.overdue ? 'Overdue' : x.deferralEnded ? 'Deferral ended' : null;
  return h('div', { class: `tile stack requirement requirement-${x.state.toLowerCase()}${x.overdue || x.deferralEnded ? ' requirement-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/requirements`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.what),
      h('span', { class: 'row' }, h('span', { class: `tag ${PRIORITY_TONE[x.priority]}` }, x.priorityLabel),
        h('span', { class: `tag ${flag ? 'danger' : TONE[x.state]}` }, flag ?? x.stateLabel))),
    x.detail ? h('div', { class: 'small' }, x.detail) : null,
    h('div', { class: 'small muted' }, [
      `Came from: ${x.sourceLabel}`, `added by ${x.generatedBy} ${fmtDateTime(x.generatedAt)}`, x.dueBy ? `due ${x.dueBy}` : null,
    ].filter(Boolean).join(' · ')),
    x.assignedTo ? h('div', { class: 'small' }, h('b', {}, x.mine ? 'Assigned to you' : `Assigned to ${x.assignedTo}`),
      x.accepted ? '' : ' · not yet accepted') : null,
    x.state === 'DEFERRED' ? h('div', { class: 'small' }, h('b', {}, `Deferred until ${x.deferredUntil}: `), x.deferReasonLabel) : null,
    x.actionNote ? h('div', { class: 'small' }, h('b', {}, `Actioned (${x.actionedBy}, ${fmtDateTime(x.actionedAt)}): `), x.actionNote) : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.state === 'ENTERED_IN_ERROR' ? 'Entered in error' : 'Cancelled'}: `), x.endedNote) : null,
    x.outcomeLabel ? h('div', { class: 'small' }, h('b', {}, `Outcome (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), [x.outcomeLabel, x.outcomeNote].filter(Boolean).join('. ')) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Requirements view in the Live Workstation.
export function requirementsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canAdd ? h('div', {}, h('button', { class: 'btn primary', onclick: () => addDialog(personId, d.options, reload) }, 'Add a requirement')) : null,
    d.open.length ? d.open.map((x) => requirementCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No open requirements.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Closed (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => requirementCard(x, d, reload)))) : null,
  );
}

// Home → Requirements.
export async function requirementsView() {
  const d = await get('/api/work/requirements');
  const view = { options: { colleagues: [], priorities: {}, deferReasons: {}, outcomes: {} } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => requirementCard({ ...x, actions: [] }, view, () => go('/work/requirements'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Requirements', () => go('/work/home')),
    h('div', { class: 'banner' }, 'What your service has to do for the people in its care: yours, waiting to be assigned, with others, deferred, and done but waiting for an outcome. Open the person to act.'),
    section('Yours', d.mine, 'Nothing assigned to you.'),
    section('Waiting to be assigned', d.toAssign, 'Nothing waiting.'),
    section('Deferred', d.deferred, 'Nothing deferred.'),
    section('Waiting for an outcome', d.toClose, 'Nothing waiting for an outcome.'),
    section('With others', d.others, 'Nothing with others.'),
  );
}
