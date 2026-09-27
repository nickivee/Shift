import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Care due: set up once or repeating → scheduled → upcoming → due → overdue → done, moved or stopped.
const TONE = { SCHEDULED: 'muted', UPCOMING: 'warn', DUE: 'warn', OVERDUE: 'danger' };

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', {},
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { await onSubmit(); dlg.close(); dlg.remove(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; }
    } },
      h('h2', {}, title), body, error,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label, el) => h('label', { class: 'field' }, label, el);
const select = (entries, label, blank = 'Choose…') => h('select', { 'aria-label': label }, blank === null ? null : h('option', { value: '' }, blank), entries.map(([k, v]) => h('option', { value: k }, v)));
const local = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toIso = (v) => (v ? new Date(v).toISOString() : '');
const send = (x, action, body) => post(`/api/work/care-due/${x.id}/${action}`, body);

function setUpDialog(personId, o, reload) {
  const kind = select(o.kinds.map((k) => [k.id, k.label]), 'Care');
  const what = h('input', { type: 'text', 'aria-label': 'What exactly', placeholder: 'Optional, e.g. Change the dressing on her left heel' });
  const every = select(Object.entries(o.intervals), 'How often');
  kind.addEventListener('change', () => {
    const k = o.kinds.find((x) => x.id === kind.value);
    if (k) every.value = String(k.every ?? 0);
  });
  const first = h('input', { type: 'datetime-local', 'aria-label': 'First due', value: local(new Date()) });
  const detail = h('textarea', { 'aria-label': 'Detail', placeholder: 'Optional, e.g. Left side, back, right side' });
  dialog('Set up care due', h('div', { class: 'stack' },
    field('Care', kind), field('What exactly', what), field('How often', every), field('First due', first), field('Detail', detail),
  ), 'Set up', async () => {
    await post(`/api/work/patients/${personId}/care-due`, { kind: kind.value, what: what.value, every: every.value, firstDue: toIso(first.value), detail: detail.value });
    toast('Care due set up.');
    reload();
  });
}

function doneDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: x.timing === 'SCHEDULED' ? 'Not due yet: say why you are doing it now' : 'Optional, e.g. Turned to her left side; skin unchanged' });
  dialog(`Done: ${x.what}`, h('div', { class: 'stack' }, field('Note', note),
    x.everyHours ? h('p', { class: 'small muted' }, `Next due ${x.everyLabel.toLowerCase().replace('every ', '')} from now.`) : null), 'Save', async () => {
    await send(x, 'done', { note: note.value });
    reload();
  });
}

function rescheduleDialog(x, o, reload) {
  const to = h('input', { type: 'datetime-local', 'aria-label': 'New time', value: local(new Date(Date.now() + 60 * 60_000)) });
  const reason = select(Object.entries(o.reasons), 'Why');
  const note = h('textarea', { 'aria-label': 'What is happening', placeholder: 'e.g. At X-ray; will turn her when she is back' });
  dialog(`Move: ${x.what}`, h('div', { class: 'stack' }, field('New time', to), field('Why', reason), field('What is happening', note)), 'Move', async () => {
    await send(x, 'reschedule', { to: toIso(to.value), reason: reason.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  cease: ['Stop', 'Why it is being stopped', 'e.g. Skin healed; walking on her own now', 'Stop it'],
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

const LABELS = { done: 'Done', reschedule: 'Move', cease: 'Stop', error: 'Entered in error' };

function dueCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'done' ? doneDialog(x, reload) : a === 'reschedule' ? rescheduleDialog(x, o, reload) : noteDialog(x, a, reload));
  const when = x.timing === 'OVERDUE' || x.timing === 'DUE' ? `was due ${fmtDateTime(x.dueAt)} (${x.late} ago)` : x.dueAt ? `due ${fmtDateTime(x.dueAt)}` : null;
  return h('div', { class: `tile stack caredue caredue-${(x.timing ?? x.state).toLowerCase()}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/caredue`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.what),
      h('span', { class: `tag ${x.timing ? TONE[x.timing] : 'muted'}` }, x.timingLabel ?? x.stateLabel)),
    h('div', { class: 'small' }, [x.everyLabel, when].filter(Boolean).join(' · ')),
    x.detail ? h('div', { class: 'small' }, x.detail) : null,
    h('div', { class: 'small muted' }, [
      `Set up by ${x.setBy} ${fmtDateTime(x.setAt)}`, x.lastDoneAt ? `last done ${fmtDateTime(x.lastDoneAt)}` : 'not done yet',
    ].join(' · ')),
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'done' ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Care due view in the Live Workstation.
export function careDuePanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canSetUp ? h('div', {}, h('button', { class: 'btn primary', onclick: () => setUpDialog(personId, d.options, reload) }, 'Set up care due')) : null,
    d.active.length ? d.active.map((x) => dueCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No care due.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Done or stopped (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => dueCard(x, d, reload)))) : null,
  );
}

// Home → Care due.
export async function careDueView() {
  const d = await get('/api/work/care-due');
  const view = { options: { kinds: [], intervals: {}, reasons: {} } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => dueCard({ ...x, actions: [] }, view, () => go('/work/care-due'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Care due', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Care that falls due in your service over the next day: overdue, due now, coming up, and later. Open the person to record it done or move it.'),
    section('Overdue', d.overdue, 'Nothing overdue.'),
    section('Due now', d.due, 'Nothing due now.'),
    section('Coming up', d.upcoming, 'Nothing coming up.'),
    section('Later today', d.later, 'Nothing else in the next day.'),
  );
}
