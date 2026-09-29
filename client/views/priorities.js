import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Priority: request or presentation → evidence → priority assigned by a clinician → timeframe →
// reassessed, more or less urgent → seen and acted on.
const TONE = { ACTIONED: 'ok', CANCELLED: 'muted', ENTERED_IN_ERROR: 'muted' };

const send = (x, action, body) => post(`/api/work/priorities/${x.id}/${action}`, body);

// "in 25 min", "2 h 10 min late"
function clock(mins) {
  const a = Math.abs(mins);
  const t = a >= 1440 ? `${Math.floor(a / 1440)} d ${Math.floor((a % 1440) / 60)} h` : a >= 60 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${a} min`;
  return mins < 0 ? `${t} past the timeframe` : `due in ${t}`;
}

function assignDialog(personId, d, reload) {
  const o = d.options;
  const source = select(Object.entries(o.sources), 'How it came');
  const what = h('input', { type: 'text', 'aria-label': 'Request or presentation', placeholder: 'e.g. Central chest pain for 2 hours' });
  const evidence = h('textarea', { 'aria-label': 'Evidence', placeholder: 'e.g. HR 110, BP 92/60, sweaty, pain 8/10' });
  const level = select(o.levels, 'Priority');
  dialog('Assign a priority', h('div', { class: 'stack' }, h('div', { class: 'small muted' }, o.scaleLabel),
    field('How it came', source), field('Request or presentation', what), field('Evidence', evidence), field('Priority', level)), 'Assign', async () => {
    await post(`/api/work/patients/${personId}/priorities`, { source: source.value, what: what.value, evidence: evidence.value, level: level.value });
    toast('Priority assigned.');
    reload();
  });
}

function reassessDialog(x, d, reload) {
  const o = d.options;
  const level = select(o.levels, 'Priority now', null);
  level.value = x.level;
  const evidence = h('textarea', { 'aria-label': 'What you found', placeholder: 'e.g. Pain now 3/10 after analgesia; obs normal' });
  const note = h('textarea', { 'aria-label': 'Why less urgent', placeholder: 'Needed if you make it less urgent' });
  dialog(`Reassess: ${x.what}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, 'Now: '), x.levelLabel),
    field('What you found', evidence), field('Priority now', level), field('Why less urgent', note),
    d.canDowngrade ? null : h('div', { class: 'small muted' }, 'You can make it more urgent. Making it less urgent needs a senior clinician.')), 'Save', async () => {
    await send(x, 'reassess', { level: level.value, evidence: evidence.value, note: note.value });
    reload();
  });
}

function noteDialog(x, action, title, label, placeholder, submit, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.what}`, field(label, note), submit, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = { act: 'Seen and acted on', reassess: 'Reassess', cancel: 'Cancel', error: 'Entered in error' };

function priorityCard(x, d, reload, showPatient = false) {
  const handler = (a) => () => (a === 'reassess' ? reassessDialog(x, d, reload)
    : a === 'act' ? noteDialog(x, 'act', 'Seen and acted on', 'What was done', 'e.g. Seen by Dr Singh; ECG done', 'Save', reload)
    : a === 'cancel' ? noteDialog(x, 'cancel', 'Cancel', 'Why', 'e.g. Left before being seen', 'Cancel it', reload)
    : noteDialog(x, 'error', 'Entered in error', 'Why', 'e.g. Assigned to the wrong person', 'Mark as error', reload));
  const waiting = x.state === 'WAITING';
  const flag = waiting ? (x.overdue ? ['Past the timeframe', 'danger'] : ['Waiting', 'warn']) : x.state === 'ACTIONED'
    ? (x.metTimeframe ? ['Seen within the timeframe', 'ok'] : ['Seen after the timeframe', 'danger']) : [x.stateLabel, TONE[x.state]];
  return h('div', { class: `tile stack pri ${waiting ? `pri-l${Math.min(x.rank, 4)}` : 'pri-ended'}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/priorities`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('span', { class: 'pri-level' }, x.levelLabel), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('h3', {}, x.what),
    waiting ? h('div', { class: `pri-clock${x.overdue ? ' late' : ''}` }, `${clock(x.minutesLeft)} (by ${fmtDateTime(x.dueAt)})`) : null,
    h('div', { class: 'small' }, h('b', {}, 'Evidence: '), x.evidence),
    h('div', { class: 'small muted' }, `${x.sourceLabel} · assigned by ${x.assignedBy}, ${fmtDateTime(x.assignedAt)} · ${x.scaleLabel}`),
    x.actionNote ? h('div', { class: 'small' }, h('b', {}, `Acted on (${x.actedBy}, ${fmtDateTime(x.actedAt)}): `), x.actionNote) : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'act' ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Priority view in the Live Workstation.
export function prioritiesPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canAssign ? h('div', {}, h('button', { class: 'btn primary', onclick: () => assignDialog(personId, d, reload) }, 'Assign a priority')) : null,
    d.open.length ? d.open.map((x) => priorityCard(x, d, reload)) : h('div', { class: 'card empty' }, 'Nothing waiting with a priority.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => priorityCard(x, d, reload)))) : null,
  );
}

// Home → Priorities.
export async function prioritiesView() {
  const d = await get('/api/work/priorities');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => priorityCard({ ...x, actions: [] }, d, () => go('/work/priorities'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Priorities', () => go('/work/home')),
    h('div', { class: 'banner' }, `Everyone in your service waiting to be seen or acted on, soonest due first, on the ${d.options.scaleLabel}. Priorities are set by clinicians; SHIFT never sets one. Open the person to act.`),
    section('Past the timeframe', d.overdue, 'Nobody is past their timeframe.'),
    section('Waiting', d.waiting, 'Nobody else is waiting.'),
  );
}
