import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Declined care: care offered → what they were told → declined → their reason → what it means →
// the plan instead → escalated if risky → offered again.
const TONE = { DECLINED: 'warn', ESCALATED: 'danger', ACCEPTED: 'ok', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const local = (d) => `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const send = (x, action, body) => post(`/api/work/declined/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);
const dateInput = (label, value = '') => h('input', { type: 'date', 'aria-label': label, min: addDays(0), value });

function recordDialog(personId, d, reload) {
  const o = d.options;
  let decidedBy = 'PERSON';
  const category = select(Object.entries(o.categories), 'Kind of care');
  const offered = h('input', { type: 'text', 'aria-label': 'What was offered', placeholder: 'e.g. Enoxaparin 40 mg injection' });
  const information = h('textarea', { 'aria-label': 'What they were told', placeholder: 'e.g. Explained it prevents clots in the legs and lungs; risk is higher while in bed' });
  const representative = h('input', { type: 'text', 'aria-label': 'Representative', placeholder: 'Name and role, e.g. Rawiri Te Whare, EPOA welfare' });
  const repField = field('Representative', representative);
  repField.hidden = true;
  const who = h('fieldset', { class: 'stack' }, h('legend', {}, 'Who declined'),
    Object.entries(o.decidedBy).map(([k, v]) => choice('decidedBy', k, v, () => { decidedBy = k; repField.hidden = k !== 'REPRESENTATIVE'; })));
  who.querySelector('input[value=PERSON]').checked = true;
  const concern = h('input', { type: 'checkbox', 'aria-label': 'Concern about capacity' });
  const reason = h('textarea', { 'aria-label': 'Their reason', placeholder: 'In their words, if they gave one. Leave empty if they did not.' });
  const implications = h('textarea', { 'aria-label': 'What it means for them', placeholder: 'e.g. Higher risk of a clot while mostly in bed' });
  const risk = select(Object.entries(o.risks), 'Risk');
  const plan = h('textarea', { 'aria-label': 'Plan instead', placeholder: 'Optional, e.g. Compression stockings; walk every 2 hours' });
  const reofferBy = dateInput('Offer again by');
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When offered', value: local(new Date()) });
  dialog('Record declined care', h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, 'Everyone has the right to refuse care. Record what was offered and explained, and what happens now.'),
    field('Kind of care', category), field('What was offered', offered), field('When offered', when), field('What they were told', information),
    who, repField, h('label', { class: 'trend-choice' }, concern, 'I am concerned they may not be able to make this decision'),
    field('Their reason', reason), field('What it means for them', implications), field('Risk', risk), field('Plan instead', plan), field('Offer again by (optional)', reofferBy)),
  'Record', async () => {
    await post(`/api/work/patients/${personId}/declined`, {
      category: category.value, offered: offered.value, information: information.value, decidedBy, representative: representative.value,
      capacityConcern: concern.checked ? 'YES' : 'NO', reason: reason.value, implications: implications.value, risk: risk.value, plan: plan.value,
      reofferBy: reofferBy.value, offeredAt: when.value ? new Date(when.value).toISOString() : '',
    });
    toast(risk.value === 'HIGH' ? 'Recorded. This is high risk: escalate it to a senior clinician.' : 'Declined care recorded.');
    reload();
  });
}

function reofferDialog(x, reload) {
  let outcome = '';
  const note = h('textarea', { 'aria-label': 'What they said', placeholder: 'Optional if accepted' });
  const next = dateInput('Offer again by');
  const nextField = field('Offer again by (optional)', next);
  nextField.hidden = true;
  dialog(`Offer again: ${x.offered}`, h('div', { class: 'stack' },
    h('fieldset', { class: 'row' }, h('legend', {}, 'This time'),
      choice('outcome', 'ACCEPTED', 'Accepted', () => { outcome = 'ACCEPTED'; nextField.hidden = true; }),
      choice('outcome', 'DECLINED', 'Declined again', () => { outcome = 'DECLINED'; nextField.hidden = false; })),
    field('What they said', note), nextField), 'Save', async () => {
    await send(x, 'reoffer', { outcome, note: note.value, reofferBy: next.value });
    reload();
  });
}

function escalateDialog(x, reload) {
  const to = h('input', { type: 'text', 'aria-label': 'Escalated to', placeholder: 'e.g. Dr Li (consultant) by phone' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Escalate: ${x.offered}`, h('div', { class: 'stack' }, field('Escalated to', to), field('Note', note)), 'Escalate', async () => {
    await send(x, 'escalate', { to: to.value, note: note.value });
    reload();
  });
}

function respondDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Your response', placeholder: 'e.g. Spoke with her: she understands the risk and still declines' });
  const plan = h('textarea', { 'aria-label': 'Plan instead', placeholder: 'Optional; replaces the current plan', value: x.plan ?? '' });
  const next = dateInput('Offer again by', x.reofferBy ?? '');
  dialog(`Respond: ${x.offered}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, 'Escalated to: '), x.escalatedTo),
    field('Your response', note), field('Plan instead', plan), field('Offer again by (optional)', next)), 'Save response', async () => {
    await send(x, 'respond', { note: note.value, plan: plan.value, reofferBy: next.value });
    reload();
  });
}

function planDialog(x, reload) {
  const plan = h('textarea', { 'aria-label': 'Plan instead', value: x.plan ?? '', placeholder: 'e.g. Compression stockings; walk every 2 hours' });
  const next = dateInput('Offer again by', x.reofferBy ?? '');
  dialog(`Plan: ${x.offered}`, h('div', { class: 'stack' }, field('Plan instead', plan), field('Offer again by (optional)', next)), 'Save plan', async () => {
    await send(x, 'plan', { plan: plan.value, reofferBy: next.value });
    reload();
  });
}

function noteDialog(x, action, title, label, placeholder, submit, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.offered}`, field(label, note), submit, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = { reoffer: 'Offer again', escalate: 'Escalate', respond: 'Respond', plan: 'Change plan', close: 'Close', error: 'Entered in error' };
const PRIMARY = ['reoffer', 'respond'];

function declinedCard(x, d, reload, showPatient = false) {
  const handler = (a) => () => (a === 'reoffer' ? reofferDialog(x, reload) : a === 'escalate' ? escalateDialog(x, reload) : a === 'respond' ? respondDialog(x, reload)
    : a === 'plan' ? planDialog(x, reload)
    : a === 'close' ? noteDialog(x, 'close', 'Close', 'Why', 'e.g. Course finished, or Discharged home', 'Close it', reload)
    : noteDialog(x, 'error', 'Entered in error', 'Why', 'e.g. Recorded for the wrong person', 'Mark as error', reload));
  const flag = x.needsEscalation ? ['High risk: escalate', 'danger'] : x.reofferDue ? ['Offer again today', 'warn'] : [x.stateLabel, TONE[x.state]];
  const tone = x.needsEscalation || x.state === 'ESCALATED' ? 'alert' : x.state === 'DECLINED' ? 'waiting' : x.state === 'ACCEPTED' ? 'ok' : 'ended';
  const primary = x.needsEscalation ? ['escalate'] : PRIMARY;
  return h('div', { class: `tile stack dcl dcl-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/declined`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.offered), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'small muted' }, `${x.categoryLabel} · offered ${fmtDateTime(x.offeredAt)} · recorded by ${x.recordedBy}`),
    h('dl', { class: 'var-pair' },
      h('dt', {}, 'Declined by'), h('dd', {}, x.decidedBy === 'REPRESENTATIVE' ? x.representative : 'The person'),
      h('dt', {}, 'Told'), h('dd', {}, x.information),
      h('dt', {}, 'Reason'), h('dd', {}, x.reason ?? 'No reason given'),
      h('dt', {}, 'Means'), h('dd', {}, `${x.implications} (${x.risk.toLowerCase()} risk)`),
      x.plan ? [h('dt', {}, 'Plan'), h('dd', {}, x.plan)] : null,
      x.escalatedTo ? [h('dt', {}, 'Escalated'), h('dd', {}, `To ${x.escalatedTo}, ${fmtDateTime(x.escalatedAt)}`)] : null,
      x.response ? [h('dt', {}, 'Response'), h('dd', {}, `${x.response} (${x.respondedBy})`)] : null,
      x.reofferBy && ['DECLINED', 'ESCALATED'].includes(x.state) ? [h('dt', {}, 'Offer again'), h('dd', {}, `By ${x.reofferBy}`)] : null,
      x.endedNote && !['DECLINED', 'ESCALATED'].includes(x.state) ? [h('dt', {}, x.stateLabel), h('dd', {}, `${x.endedNote} (${x.endedBy})`)] : null),
    x.capacityConcern ? h('div', { class: 'small notice' }, 'Concern about their capacity to make this decision. Check the Capacity view.') : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${primary.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Declined care view in the Live Workstation.
export function declinedPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d, reload) }, 'Record declined care')) : null,
    d.open.length ? d.open.map((x) => declinedCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No declined care now.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => declinedCard(x, d, reload)))) : null,
  );
}

// Home → Declined care.
export async function declinedView() {
  const d = await get('/api/work/declined');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => declinedCard({ ...x, actions: [] }, view, () => go('/work/declined'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Declined care', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Care people in your service have declined: high-risk refusals to escalate or waiting for a senior, care to offer again today, and the rest. Open the person to act.'),
    section('Needs a senior', d.attention, 'Nothing needs a senior now.'),
    section('Offer again today', d.reoffer, 'Nothing to offer again today.'),
    section('Other declined care', d.others, 'No other declined care.'),
  );
}
