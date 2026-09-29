import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Infections: suspected → evidence → source → organism → sensitivities and resistance → treatment →
// response → source control → complications → resolved, ongoing, or came back.
const TONE = { SUSPECTED: 'warn', CONFIRMED: 'warn', ONGOING: 'warn', RESOLVED: 'ok', RECURRED: 'muted', NOT_INFECTION: 'muted', ENTERED_IN_ERROR: 'muted' };

const send = (x, action, body) => post(`/api/work/infections/${x.id}/${action}`, body);

function raiseDialog(personId, o, reload) {
  const site = select(Object.entries(o.sites), 'Where');
  const detail = h('input', { type: 'text', 'aria-label': 'Detail', placeholder: 'Optional, e.g. Left heel pressure injury' });
  const why = h('textarea', { 'aria-label': 'Why you suspect it', placeholder: 'e.g. Temp 38.4, new cough with green sputum' });
  dialog('Suspected infection', h('div', { class: 'stack' }, field('Where', site), field('Detail', detail), field('Why you suspect it', why)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/infections`, { site: site.value, siteDetail: detail.value, suspicion: why.value });
    toast('Suspected infection recorded.');
    reload();
  });
}

const PLACEHOLDER = {
  EVIDENCE: 'e.g. CRP 142; chest X-ray: right lower lobe consolidation', ORGANISM: 'e.g. Staphylococcus aureus', SUSCEPTIBILITY: 'The antibiotic, e.g. Flucloxacillin',
  TREATMENT: 'e.g. IV amoxicillin and clavulanic acid started 1400', RESPONSE: 'e.g. Afebrile for 24 hours, eating again', SOURCE_CONTROL: 'e.g. Remove the left forearm cannula',
  COMPLICATION: 'e.g. Sepsis: lactate 3.2, BP 88/50',
};
function addDialog(x, o, reload) {
  const kind = select(Object.entries(o.kinds), 'What you are adding');
  const what = h('textarea', { 'aria-label': 'Detail' });
  const lists = { ORGANISM: ['Resistance', o.resistance], SUSCEPTIBILITY: ['Result', o.susceptibility], RESPONSE: ['How they are', o.responses], SOURCE_CONTROL: ['Planned or done', o.sourceStatus] };
  const value = h('select', { 'aria-label': 'Value' });
  const valueLabel = h('span', {});
  const valueField = h('label', { class: 'field' }, valueLabel, value);
  const sync = () => {
    what.placeholder = PLACEHOLDER[kind.value] ?? '';
    const l = lists[kind.value];
    valueField.hidden = !l;
    value.replaceChildren(h('option', { value: '' }, 'Choose…'), ...(l ? Object.entries(l[1]).map(([k, v]) => h('option', { value: k }, v)) : []));
    valueLabel.textContent = l ? l[0] : '';
  };
  kind.addEventListener('change', sync);
  sync();
  dialog(`Add to: ${x.siteLabel}`, h('div', { class: 'stack' }, field('What you are adding', kind), field('Detail', what), valueField), 'Add', async () => {
    await send(x, 'add', { kind: kind.value, what: what.value, value: value.value });
    reload();
  });
}

function sourceDoneDialog(x, s, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Tip sent for culture' });
  dialog(`Done: ${s.what}`, field('Note', note), 'Save', async () => {
    await send(x, 'add', { kind: 'SOURCE_CONTROL', refId: s.id, what: note.value });
    reload();
  });
}

function confirmDialog(x, reload) {
  const source = h('input', { type: 'text', 'aria-label': 'Source', placeholder: 'e.g. Right lower lobe pneumonia' });
  const note = h('textarea', { 'aria-label': 'Who diagnosed it and how', placeholder: 'e.g. Dr Li: clinical and X-ray findings' });
  dialog(`Confirm: ${x.siteLabel}`, h('div', { class: 'stack' }, field('Source', source), field('Who diagnosed it and how', note)), 'Confirm', async () => {
    await send(x, 'confirm', { source: source.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  ruleout: ['Not an infection', 'Why', 'e.g. Fever from the blood transfusion; cultures negative', 'Rule out'],
  ongoing: ['Ongoing', 'Why, and the plan', 'e.g. Chronic osteomyelitis; long-term suppression, ID clinic follows', 'Save'],
  resolve: ['Resolved', 'How you know', 'e.g. Afebrile 48 hours, CRP 18, antibiotics finished', 'Resolved'],
  recur: ['Came back', 'Why you think so', 'e.g. Temp 38.6 and the wound is red again', 'Save'],
  error: ['Entered in error', 'Why', 'e.g. Raised for the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.siteLabel}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = { add: 'Add', confirm: 'Confirm', ruleout: 'Not an infection', ongoing: 'Ongoing', resolve: 'Resolved', recur: 'Came back', error: 'Entered in error' };
const PRIMARY = ['add', 'confirm'];

const line = (label, list, fmt) => (list.length ? h('div', { class: 'small' }, h('b', {}, `${label}: `), list.map(fmt).join(' · ')) : null);

function infectionCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const can = x.actions.includes('add');
  const handler = (a) => () => (a === 'add' ? addDialog(x, o, reload) : a === 'confirm' ? confirmDialog(x, reload) : noteDialog(x, a, reload));
  const ended = ['RESOLVED', 'RECURRED', 'NOT_INFECTION', 'ENTERED_IN_ERROR'].includes(x.state);
  const tone = ended ? 'ended' : x.worse || x.resistant.length ? 'alert' : x.state === 'SUSPECTED' ? 'waiting' : 'active';
  return h('div', { class: `tile stack inf inf-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/infections`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, `${x.siteLabel}${x.siteDetail ? `: ${x.siteDetail}` : ''}`),
      h('span', { class: 'row' }, x.resistant.map((r) => h('span', { class: 'tag danger' }, r)), x.worse && !ended ? h('span', { class: 'tag danger' }, 'Getting worse') : null,
        h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel))),
    h('div', { class: 'small' }, h('b', {}, 'Suspected: '), `${x.suspicion} (${x.raisedBy}, ${fmtDateTime(x.raisedAt)})`),
    x.source ? h('div', { class: 'small' }, h('b', {}, 'Source: '), `${x.source} · ${x.confirmNote}`) : null,
    line('Evidence', x.evidence, (e) => e.what),
    line('Organism', x.organisms, (e) => (e.value && e.value !== 'NONE' ? `${e.what} (${e.valueLabel})` : e.what)),
    line('Sensitivities', x.sensitivities, (e) => `${e.what}: ${e.valueLabel.toLowerCase()}`),
    line('Treatment', x.treatments, (e) => e.what),
    x.response ? h('div', { class: 'small' }, h('b', {}, `Response (${x.response.valueLabel.toLowerCase()}, ${fmtDateTime(x.response.at)}): `), x.response.what) : null,
    x.sourceControl.length ? h('div', { class: 'small stack' }, h('b', {}, 'Source control'),
      x.sourceControl.map((s) => h('div', { class: 'spread' }, h('span', {}, s.what), s.done ? h('span', { class: 'tag ok' }, 'Done')
        : h('span', { class: 'row' }, h('span', { class: 'tag warn' }, 'Planned'), can ? h('button', { class: 'btn small', onclick: () => sourceDoneDialog(x, s, reload) }, 'Mark done') : null)))) : null,
    line('Complications', x.complications, (e) => e.what),
    x.outcomeNote && x.state !== 'CONFIRMED' ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel}${x.endedBy ? ` (${x.endedBy}, ${fmtDateTime(x.endedAt)})` : ''}: `), x.outcomeNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.valueLabel ? `${s.kindLabel}: ${s.valueLabel}` : s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.what))))),
  );
}

// The person's Infections view in the Live Workstation.
export function infectionsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRaise ? h('div', {}, h('button', { class: 'btn primary', onclick: () => raiseDialog(personId, d.options, reload) }, 'Suspected infection')) : null,
    d.active.length ? d.active.map((x) => infectionCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No current infection.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Resolved or ruled out (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => infectionCard(x, d, reload)))) : null,
  );
}

// Home → Infections.
export async function infectionsView() {
  const d = await get('/api/work/infections');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => infectionCard({ ...x, actions: [] }, view, () => go('/work/infections'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Infections', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Infections in your service: suspected ones to confirm or rule out, people getting worse or waiting for source control, and the rest being treated. Open the person to act.'),
    section('Suspected', d.suspected, 'No suspected infections.'),
    section('Getting worse or source control waiting', d.attention, 'Nobody getting worse.'),
    section('Being treated', d.treating, 'No other infections.'),
  );
}
