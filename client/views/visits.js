import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Visits: planned for a day and time, then done, not done with a reason, or cancelled. A planned visit can be moved.
const TONE = { PLANNED: 'ok', DONE: 'muted', NOT_DONE: 'warn', CANCELLED: 'muted' };
const send = (x, action, body) => post(`/api/work/visits/${x.id}/${action}`, body);

function planDialog(personId, o, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'Day and time' });
  const purpose = h('input', { type: 'text', 'aria-label': 'What the visit is for', placeholder: 'e.g. Wound dressing change' });
  const place = h('input', { type: 'text', 'aria-label': 'Where', placeholder: 'e.g. At home, 14 Rata Street' });
  const who = select([['', 'Not yet decided'], ...o.goers.map((g) => [g.id, g.name])], 'Who is going');
  dialog('Plan a visit', h('div', { class: 'stack' }, field('Day and time', when), field('What the visit is for', purpose), field('Where', place), field('Who is going', who)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/visits`, { when: when.value ? new Date(when.value).toISOString() : '', purpose: purpose.value, place: place.value, assignedTo: who.value });
    toast('Visit planned.');
    reload();
  });
}

function doneDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What was done and how they were', placeholder: 'e.g. Dressing changed; wound clean and dry' });
  dialog(`Visit done: ${x.purpose}`, field('What was done and how they were', note), 'Save', async () => { await send(x, 'done', { note: note.value }); reload(); });
}

function notDoneDialog(x, o, reload) {
  const reason = select(o.reasons.map((r) => [r.code, r.label]), 'Why');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed if the reason is another reason' });
  dialog(`Visit not done: ${x.purpose}`, h('div', { class: 'stack' }, field('Why', reason), field('Note', note)), 'Save', async () => { await send(x, 'notdone', { reason: reason.value, note: note.value }); reload(); });
}

function moveDialog(x, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'New day and time' });
  const note = h('input', { type: 'text', 'aria-label': 'Why', placeholder: 'Optional, e.g. They asked for the afternoon' });
  dialog(`Move: ${x.purpose}`, h('div', { class: 'stack' }, field('New day and time', when), field('Why', note)), 'Move', async () => {
    await send(x, 'reschedule', { when: when.value ? new Date(when.value).toISOString() : '', note: note.value });
    reload();
  });
}

function cancelDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why it is no longer needed', placeholder: 'e.g. Moved to the hospice unit' });
  dialog(`Cancel: ${x.purpose}`, field('Why it is no longer needed', note), 'Cancel visit', async () => { await send(x, 'cancel', { note: note.value }); reload(); });
}

const LABELS = { done: 'Visit done', notdone: 'Not done', reschedule: 'Move', cancel: 'Cancel' };

function visitCard(x, o, reload, showPatient = false) {
  const handler = (a) => () => (a === 'done' ? doneDialog(x, reload) : a === 'notdone' ? notDoneDialog(x, o, reload) : a === 'reschedule' ? moveDialog(x, reload) : cancelDialog(x, reload));
  return h('div', { class: `tile stack visit visit-${x.state.toLowerCase()}${x.overdue ? ' visit-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/visits`) }, h('b', {}, x.patient))) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.purpose), h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? 'Overdue' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, fmtDateTime(x.plannedFor)), ` · ${x.place}`),
    h('div', { class: 'small muted' }, x.assignedTo ? `Going: ${x.assignedTo}` : 'No one assigned yet', ` · planned by ${x.plannedBy}`),
    x.state === 'DONE' ? h('div', { class: 'small' }, h('b', {}, `Done (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), x.endedNote) : null,
    x.state === 'NOT_DONE' ? h('div', { class: 'small' }, h('b', {}, `Not done (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), [x.endedReasonLabel, x.endedNote].filter(Boolean).join('. ')) : null,
    x.state === 'CANCELLED' ? h('div', { class: 'small' }, h('b', {}, `Cancelled (${x.endedBy}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'done' ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Visits view in the Live Workstation.
export function visitsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canPlan ? h('div', {}, h('button', { class: 'btn primary', onclick: () => planDialog(personId, d.options, reload) }, 'Plan a visit')) : null,
    d.planned.length ? d.planned.map((x) => visitCard(x, d.options, reload)) : h('div', { class: 'card empty' }, 'No visits planned.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Past visits (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => visitCard(x, d.options, reload)))) : null,
  );
}

// Home → Visits.
export async function visitsView() {
  const d = await get('/api/work/visits');
  const view = { reasons: [], goers: [] };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => visitCard({ ...x, actions: [] }, view, () => go('/work/visits'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Visits', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Visits your service has planned. Open the person to plan, move or record a visit.'),
    section('Overdue', d.overdue, 'Nothing overdue.'),
    section('Today', d.today, 'No visits left today.'),
    section('Coming up (next 7 days)', d.coming, 'Nothing in the next 7 days.'),
    d.later.length ? section('Later', d.later, '') : null,
    section('Done or not done in the last 7 days', d.recent, 'Nothing recorded this week.'),
  );
}
