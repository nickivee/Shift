import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Checklists: required → each item checked yes, no or not applicable → a "no" is an exception, fixed or escalated → completed.
const TONE = { REQUIRED: 'warn', IN_PROGRESS: 'ok', COMPLETED: 'muted', CANCELLED: 'muted', ENTERED_IN_ERROR: 'muted' };
const ITEM_TONE = { DUE: 'muted', DONE: 'ok', NOT_APPLICABLE: 'muted', EXCEPTION: 'danger', RESOLVED: 'ok', ESCALATED: 'warn' };
const URGENCY = { IMMEDIATE: 'Immediate', URGENT: 'Urgent', ROUTINE: 'Routine' };

const send = (x, action, body) => post(`/api/work/checklists/${x.id}/${action}`, body);

function requireDialog(personId, o, reload) {
  const which = select(o.checklists.map((c) => [c.id, c.label]), 'Checklist');
  const purpose = h('p', { class: 'small muted' });
  which.addEventListener('change', () => { purpose.textContent = o.checklists.find((c) => c.id === which.value)?.purpose ?? ''; });
  const reason = h('input', { type: 'text', 'aria-label': 'Why', placeholder: 'Optional, e.g. After her fall' });
  dialog('Start a checklist', h('div', { class: 'stack' }, field('Checklist', which), purpose, field('Why', reason)), 'Start', async () => {
    await post(`/api/work/patients/${personId}/checklists`, { templateId: which.value, reason: reason.value });
    toast('Checklist started.');
    reload();
  });
}

function checkDialog(x, it, reload) {
  let result = '';
  const evidence = h('input', { type: 'text', 'aria-label': 'Evidence', placeholder: it.evidenceLabel ?? '' });
  const evidenceField = field(it.evidenceLabel ?? 'Evidence', evidence);
  evidenceField.hidden = !it.evidenceLabel;
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'What is wrong, or why it does not apply' });
  const choice = (value, label) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name: 'result', value, onchange: () => { result = value; } }), label);
  dialog(it.label, h('div', { class: 'stack' },
    h('fieldset', { class: 'row' }, h('legend', {}, 'Is it met?'), choice('YES', 'Yes'), choice('NO', 'No'), choice('NA', 'Not applicable')),
    evidenceField, field('Note (what is wrong, if no)', note),
  ), 'Save', async () => {
    await send(x, 'check', { itemId: it.id, result, evidence: evidence.value, note: note.value });
    reload();
  });
}

function resolveDialog(x, it, reload) {
  const note = h('textarea', { 'aria-label': 'How it was fixed', placeholder: 'e.g. Bed swapped for one with working brakes' });
  dialog(`Fixed: ${it.label}`, h('div', { class: 'stack' }, h('p', { class: 'small' }, it.note), field('How it was fixed', note)), 'Save', async () => {
    await send(x, 'resolve', { itemId: it.id, note: note.value });
    reload();
  });
}

function escalateDialog(x, o, it, reload) {
  const to = select(o.recipients.map((r) => [r.roleKey, r.label]), 'Escalate to');
  if (o.recipients.length === 1) to.value = o.recipients[0].roleKey;
  const urgency = select(Object.entries(URGENCY), 'Urgency');
  const note = h('textarea', { 'aria-label': 'The risk and what you need', placeholder: 'e.g. No spare beds; she is at risk of falling again' });
  dialog(`Escalate: ${it.label}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, it.note), field('Escalate to', to), field('How urgent', urgency), field('The risk and what you need', note),
  ), 'Escalate', async () => {
    await send(x, 'escalate', { itemId: it.id, roleKey: to.value, urgency: urgency.value, note: note.value });
    toast('Escalated.');
    reload();
  });
}

const NOTE_ACTIONS = {
  complete: ['Complete the checklist', 'Note', 'Optional', 'Complete'],
  cancel: ['Cancel', 'Why it is no longer needed', 'e.g. Transfer cancelled', 'Cancel checklist'],
  error: ['Entered in error', 'Why', 'e.g. Started for the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.label}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = { complete: 'Complete', cancel: 'Cancel', error: 'Entered in error' };

function itemDetail(it) {
  if (it.state === 'DUE') return null;
  const parts = [`${it.stateLabel} · ${it.by}, ${fmtDateTime(it.at)}`, it.evidence ? `${it.evidenceLabel}: ${it.evidence}` : null, it.note].filter(Boolean).join(' · ');
  return h('div', { class: 'small muted' }, parts,
    it.resolution ? h('div', {}, `${it.state === 'ESCALATED' ? 'Escalated' : 'Fixed'} by ${it.resolvedBy} ${fmtDateTime(it.resolvedAt)}: ${it.resolution}`) : null);
}

function checklistCard(x, d, reload) {
  const o = d.options;
  const done = x.items.length - x.due;
  return h('div', { class: `tile stack checklist checklist-${x.state.toLowerCase()}${x.exceptions ? ' checklist-exception' : x.overdue ? ' checklist-overdue' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, x.label),
      h('span', { class: `tag ${x.exceptions ? 'danger' : x.overdue ? 'danger' : TONE[x.state]}` },
        x.exceptions ? `${x.exceptions} exception${x.exceptions > 1 ? 's' : ''}` : x.overdue ? 'Overdue' : x.stateLabel)),
    h('div', { class: 'small muted' }, [
      `Started by ${x.requiredBy} ${fmtDateTime(x.requiredAt)}`, x.reason,
      ['REQUIRED', 'IN_PROGRESS'].includes(x.state) ? `due ${fmtDateTime(x.dueAt)}` : null, `${done} of ${x.items.length} checked`,
    ].filter(Boolean).join(' · ')),
    h('ol', { class: 'checklist-items' }, x.items.map((it) => h('li', { class: it.state === 'EXCEPTION' ? 'exception' : '' },
      h('div', { class: 'spread' },
        h('span', {}, it.label),
        h('span', { class: 'row' },
          x.canCheck && it.state === 'DUE' ? h('button', { class: 'btn small', onclick: () => checkDialog(x, it, reload) }, 'Check') : null,
          x.canCheck && it.state === 'EXCEPTION' ? h('button', { class: 'btn small primary', onclick: () => resolveDialog(x, it, reload) }, 'Fixed') : null,
          x.canEscalate && it.state === 'EXCEPTION' ? h('button', { class: 'btn small', onclick: () => escalateDialog(x, o, it, reload) }, 'Escalate') : null,
          it.state !== 'DUE' && it.state !== 'EXCEPTION' ? h('span', { class: `tag ${ITEM_TONE[it.state]}` }, it.stateLabel) : null,
          it.state === 'EXCEPTION' && !x.canCheck ? h('span', { class: 'tag danger' }, 'Exception') : null)),
      itemDetail(it)))),
    x.endNote ? h('div', { class: 'small muted' }, `${x.stateLabel} ${fmtDateTime(x.endedAt)} by ${x.endedBy}: ${x.endNote}`)
      : x.endedAt ? h('div', { class: 'small muted' }, `${x.stateLabel} ${fmtDateTime(x.endedAt)} by ${x.endedBy}`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'complete' ? ' primary' : ''}`, onclick: () => noteDialog(x, a, reload) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Checklists view in the Live Workstation.
export function checklistsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canManage ? h('div', {}, h('button', { class: 'btn primary', onclick: () => requireDialog(personId, d.options, reload) }, 'Start a checklist')) : null,
    d.open.length ? d.open.map((x) => checklistCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No checklists open.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Finished (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => checklistCard(x, d, reload)))) : null,
    h('p', { class: 'small muted' }, 'These checklists are the organisation\'s own examples.'),
  );
}

function row(x) {
  return h('div', { class: `tile stack checklist-${x.state.toLowerCase()}${x.exceptions ? ' checklist-exception' : x.overdue ? ' checklist-overdue' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/checklists`) }, h('b', {}, x.patient)),
        x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null),
      h('span', { class: `tag ${x.exceptions || x.overdue ? 'danger' : TONE[x.state]}` }, x.exceptions ? 'Exception' : x.overdue ? 'Overdue' : x.stateLabel)),
    h('div', {}, h('b', {}, x.label), ` · ${x.items.length - x.due} of ${x.items.length} checked · due ${fmtDateTime(x.dueAt)}`),
    x.exceptionLabels.length ? h('div', { class: 'small' }, x.exceptionLabels.join(' · ')) : null,
  );
}

// Home → Checklists.
export async function checklistsView() {
  const d = await get('/api/work/checklists');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Checklists', () => go('/work/home')),
    h('div', { class: 'banner' }, `Checklists for people in your service (${d.open} open): exceptions not yet fixed, checklists overdue, and ones not started.`),
    section('Exceptions', d.exceptions, 'No open exceptions.'),
    section('Overdue', d.overdue, 'Nothing overdue.'),
    section('Not started', d.notStarted, 'None waiting.'),
  );
}
