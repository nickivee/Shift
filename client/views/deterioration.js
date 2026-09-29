import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Deterioration: noticed → escalated → responded to → intervention → reassessed → closed, or escalated again.
const TONE = { DETECTED: 'danger', ESCALATED: 'danger', RESPONDING: 'warn', REASSESSED: 'warn', CLOSED: 'muted' };
const LEVEL_LABELS = { STABLE: 'Stable', WATCH: 'Needs closer watching', UNWELL: 'Unwell: needs a senior review', CRITICAL: 'Critically unwell' };
const URGENCY_LABELS = { IMMEDIATE: 'Immediate', URGENT: 'Urgent', ROUTINE: 'Routine' };

function since(at) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
  return mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} days`;
}

const evidenceList = (e) => e ? h('dl', { class: 'acuity-evidence' }, [
  ['Latest observations', e.obs ? `${e.obs.text} (${fmtDateTime(e.obs.at)})` : 'None in the last 24 hours'],
  e.different.length ? ['Different from usual', e.different.join(' · ')] : null,
  e.escalations.length ? ['Open escalations', e.escalations.join(' · ')] : null,
  e.help.length ? ['Help needed', e.help.join(' · ')] : null,
  e.alerts.length ? ['Alerts', e.alerts.join(' · ')] : null,
].filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null;

function openDialog(personId, d, reload) {
  const change = h('textarea', { placeholder: 'e.g. More short of breath, sats down to 89% on air, clammy' });
  dialog('They are getting worse', h('div', { class: 'stack' },
    h('details', { open: true }, h('summary', {}, 'What SHIFT holds now'), evidenceList(d.evidence)),
    h('label', { class: 'field' }, 'What has changed', change),
    h('p', { class: 'small muted' }, 'Then escalate it to the right person.'),
  ), 'Record', async () => {
    await post(`/api/work/patients/${personId}/deterioration`, { change: change.value });
    toast('Recorded.');
    reload();
  });
}

function escalateDialog(ev, d, reload) {
  const to = h('select', {}, h('option', { value: '' }, 'Choose…'), d.recipients.map((r) => h('option', { value: r.roleKey }, r.label)));
  const urgency = h('select', {}, d.urgencies.map((u) => h('option', { value: u }, URGENCY_LABELS[u] ?? u)));
  const trigger = h('textarea', { placeholder: 'What has changed and why you are worried' });
  if (ev.state === 'DETECTED') trigger.value = ev.change;
  dialog(ev.state === 'DETECTED' ? 'Escalate' : 'Escalate further', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'To', to), h('label', { class: 'field' }, 'How urgent', urgency)),
    h('label', { class: 'field' }, 'Why', trigger),
  ), 'Escalate', async () => {
    await post(`/api/work/deterioration/${ev.id}/escalate`, { roleKey: to.value, urgency: urgency.value, trigger: trigger.value });
    toast('Escalated.');
    reload();
  });
}

function noteDialog(ev, action, reload) {
  const [title, label, placeholder] = action === 'response'
    ? ['Clinical response', 'Who reviewed them and what they found', 'e.g. Dr Patel reviewed at 10:40: likely chest infection, plan below']
    : ['Intervention', 'What was done', 'e.g. Oxygen 2 L by nasal prongs; IV antibiotics started'];
  const note = h('textarea', { placeholder });
  dialog(title, h('label', { class: 'field' }, label, note), 'Save', async () => {
    await post(`/api/work/deterioration/${ev.id}/${action}`, { note: note.value });
    reload();
  });
}

function reassessDialog(ev, d, reload) {
  let level = '';
  const basis = h('textarea', { placeholder: 'e.g. Resp rate 20, sats 94% on 2 L, less confused' });
  dialog('Reassess', h('div', { class: 'stack' },
    h('fieldset', { class: 'stack' }, h('legend', {}, 'How are they now?'), d.levels.map((l) => h('label', { class: `acuity-choice acuity-${l.toLowerCase()}` },
      h('input', { type: 'radio', name: 'det-level', value: l, onchange: () => { level = l; } }), h('b', {}, LEVEL_LABELS[l])))),
    h('label', { class: 'field' }, 'What you are basing this on', basis),
    h('p', { class: 'small muted' }, 'This also updates their clinical status.'),
  ), 'Record', async () => {
    await post(`/api/work/deterioration/${ev.id}/reassess`, { level, basis: basis.value });
    reload();
  });
}

function closeDialog(ev, d, reload) {
  const outcome = h('select', {}, h('option', { value: '' }, 'Choose…'), Object.entries(d.outcomes).map(([k, v]) => h('option', { value: k }, v)));
  const note = h('textarea', { placeholder: 'e.g. Obs back within his usual after antibiotics; 4-hourly obs' });
  dialog('Close: how did it end?', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Outcome', outcome), h('label', { class: 'field' }, 'Note', note),
    h('p', { class: 'small muted' }, 'If they are getting worse again, escalate further instead.'),
  ), 'Close it', async () => {
    await post(`/api/work/deterioration/${ev.id}/close`, { outcome: outcome.value, note: note.value });
    reload();
  });
}

const LABELS = { escalate: 'Escalate', response: 'Record response', intervention: 'Add intervention', reassess: 'Reassess', close: 'Close' };

function timeline(ev) {
  return h('ol', { class: 'det-steps' }, ev.steps.map((s) => h('li', { class: `det-step det-${s.kind.toLowerCase()}` },
    h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
    h('div', {}, s.kind === 'ESCALATED' ? `${URGENCY_LABELS[s.urgency] ?? ''} to ${s.roleLabel ?? ''}: ${s.body}` : s.body),
    s.kind === 'ESCALATED' && s.escalationResponse ? h('div', { class: 'small muted' }, `Their response: ${s.escalationResponse}`) : null,
  )));
}

function episode(ev, d, reload, full) {
  const label = (a) => (a === 'escalate' && ev.state !== 'DETECTED' ? 'Escalate further' : LABELS[a]);
  return h('div', { class: `tile stack det-episode det-${ev.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, ev.state === 'CLOSED' ? ev.outcomeLabel : 'Getting worse'),
      h('span', { class: `tag ${TONE[ev.state]}` }, ev.state === 'CLOSED' ? 'Closed' : ev.stateLabel)),
    h('div', { class: 'small muted' }, ev.state === 'CLOSED'
      ? `Noticed by ${ev.detectedBy} ${fmtDateTime(ev.detectedAt)}; closed by ${ev.closedBy} ${fmtDateTime(ev.closedAt)}`
      : `Noticed by ${ev.detectedBy} ${fmtDateTime(ev.detectedAt)} · ${since(ev.detectedAt)} ago`),
    ev.state === 'DETECTED' ? h('div', { class: 'notice small' }, 'Not escalated yet.') : null,
    timeline(ev),
    full && ev.evidence ? h('details', {}, h('summary', {}, 'What SHIFT held when it was noticed'), evidenceList(ev.evidence)) : null,
    ev.actions.length ? h('div', { class: 'row' }, ev.actions.map((a) => h('button', {
      class: `btn small${(a === 'escalate' && ev.state === 'DETECTED') || (a === 'close' && ev.state === 'REASSESSED') ? ' primary' : ''}`,
      onclick: () => (a === 'escalate' ? escalateDialog(ev, d, reload) : a === 'reassess' ? reassessDialog(ev, d, reload) : a === 'close' ? closeDialog(ev, d, reload) : noteDialog(ev, a, reload)),
    }, label(a)))) : null,
    ev.actions.includes('escalate') && !d.recipients.length ? h('p', { class: 'small muted' }, d.escalationNote ?? 'No one to escalate to is set up for your role.') : null,
  );
}

// The person's Deterioration view in the Live Workstation.
export function deteriorationPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.open ? episode(d.open, d, reload, true) : h('div', { class: 'card empty' }, 'Nothing open.'),
    !d.open && d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => openDialog(personId, d, reload) }, 'They are getting worse')) : null,
    h('p', { class: 'small muted' }, 'SHIFT does not detect deterioration or set response times; it shows how long it has been.'),
    d.closed.length ? h('details', {}, h('summary', {}, `Earlier (${d.closed.length})`), h('div', { class: 'stack' }, d.closed.map((ev) => episode(ev, d, reload, false)))) : null,
  );
}

function row(ev) {
  return h('div', { class: `tile stack det-${ev.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${ev.personId}/deterioration`) }, h('b', {}, ev.patient)),
        ev.location ? h('span', { class: 'small muted' }, ` · ${ev.location}`) : null),
      h('span', { class: `tag ${TONE[ev.state]}` }, ev.state === 'CLOSED' ? ev.outcomeLabel : ev.stateLabel)),
    h('div', { class: 'small' }, ev.change),
    h('div', { class: 'small muted' }, ev.state === 'CLOSED' ? `Closed ${fmtDateTime(ev.closedAt)}` : `${since(ev.detectedAt)} since noticed · ${ev.escalations} escalation${ev.escalations === 1 ? '' : 's'} · last: ${ev.steps[ev.steps.length - 1].kindLabel.toLowerCase()}`),
  );
}

// Home → Deterioration.
export async function deteriorationView() {
  const d = await get('/api/work/deterioration');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Deterioration', () => go('/work/home')),
    h('div', { class: 'banner' }, 'People getting worse in your service, from when it was noticed to how it ended.'),
    section('Not escalated yet', d.notEscalated, 'None.'),
    section('Open', d.open, 'No one is being followed for deterioration.'),
    section('Closed in the last week', d.recent, 'None.'),
  );
}
