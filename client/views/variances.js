import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Variances: what was expected → what happened instead → why → clinical context → a decision by
// someone allowed to → what is done instead → followed up until closed.
const TONE = { RECORDED: 'warn', MONITORING: 'ok', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };

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
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const local = (d) => `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const send = (x, action, body) => post(`/api/work/variances/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

function recordDialog(personId, d, reload) {
  const o = d.options;
  const category = select(Object.entries(o.categories), 'Kind');
  const expected = h('input', { type: 'text', 'aria-label': 'What was expected', placeholder: 'e.g. Enoxaparin 40 mg at 1800' });
  const what = h('input', { type: 'text', 'aria-label': 'What happened instead', placeholder: 'e.g. Not given' });
  const reason = select(Object.entries(o.reasons), 'Why');
  const context = h('textarea', { 'aria-label': 'Clinical context', placeholder: 'e.g. Says the injections bruise her; walking the ward; platelets normal' });
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When', value: local(new Date()) });
  dialog('Record a variance', h('div', { class: 'stack' }, field('Kind', category), field('What was expected', expected), field('What happened instead', what),
    field('Why', reason), field('Clinical context', context), field('When', when)), 'Record', async () => {
    await post(`/api/work/patients/${personId}/variances`, {
      category: category.value, expected: expected.value, whatHappened: what.value, reason: reason.value, context: context.value,
      occurredAt: when.value ? new Date(when.value).toISOString() : '',
    });
    toast(reason.value === 'ERROR' ? 'Variance recorded. Please also report this mistake as an incident.' : 'Variance recorded.');
    reload();
  });
}

function decideDialog(x, o, reload) {
  let decision = '';
  let followUp = '';
  const action = h('textarea', { 'aria-label': 'What will be done instead', placeholder: 'e.g. Give at 2000 once she has eaten' });
  const actionField = field('What will be done instead', action);
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  const by = h('input', { type: 'date', 'aria-label': 'Follow up by', min: addDays(0), value: addDays(1) });
  const watch = h('input', { type: 'text', 'aria-label': 'What to watch for', placeholder: 'e.g. Calf swelling or chest pain' });
  const followBlock = h('div', { class: 'stack', hidden: true }, field('Follow up by', by), field('What to watch for', watch));
  const sync = () => { actionField.hidden = decision === 'ACCEPT'; followBlock.hidden = followUp !== 'YES'; };
  dialog(`Decide: ${x.expected}`, h('div', { class: 'stack' },
    h('dl', { class: 'var-pair' }, h('dt', {}, 'Instead'), h('dd', {}, x.whatHappened), h('dt', {}, 'Why'), h('dd', {}, x.reasonLabel), h('dt', {}, 'Context'), h('dd', {}, x.context)),
    h('fieldset', { class: 'stack' }, h('legend', {}, 'Decision'), Object.entries(o.decisions).map(([k, v]) => choice('decision', k, v, () => { decision = k; sync(); }))),
    actionField, field('Note', note),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Does it need following up?'),
      choice('followUp', 'YES', 'Yes', () => { followUp = 'YES'; sync(); }), choice('followUp', 'NO', 'No', () => { followUp = 'NO'; sync(); })),
    followBlock), 'Save decision', async () => {
    if (!followUp) throw new Error('Say whether it needs following up.');
    await send(x, 'decide', { decision, action: action.value, note: note.value, followUp, followUpBy: by.value, watch: watch.value });
    reload();
  });
}

function followDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What you found', placeholder: 'e.g. Weighed after X-ray: 82.4 kg, down 0.6' });
  const next = h('input', { type: 'date', 'aria-label': 'Next follow-up', min: addDays(0) });
  dialog(`Follow-up: ${x.expected}`, h('div', { class: 'stack' }, x.watch ? h('div', { class: 'small' }, h('b', {}, 'Watching for: '), x.watch) : null,
    field('What you found', note), field('Next follow-up (optional)', next)), 'Save', async () => {
    await send(x, 'followup', { note: note.value, followUpBy: next.value });
    reload();
  });
}

function noteDialog(x, action, title, label, placeholder, submit, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.expected}`, field(label, note), submit, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = { decide: 'Decide', followup: 'Add follow-up', close: 'Close', error: 'Entered in error' };
const PRIMARY = ['decide', 'followup'];

function varianceCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'decide' ? decideDialog(x, o, reload) : a === 'followup' ? followDialog(x, reload)
    : a === 'close' ? noteDialog(x, 'close', 'Close', 'Outcome', 'e.g. Given at 2000; no harm', 'Close it', reload)
    : noteDialog(x, 'error', 'Entered in error', 'Why', 'e.g. Recorded for the wrong person', 'Mark as error', reload));
  const flag = x.followUpDue ? ['Follow-up due', 'danger'] : [x.stateLabel, TONE[x.state]];
  const tone = x.followUpDue ? 'alert' : x.state === 'RECORDED' ? 'waiting' : x.state === 'MONITORING' ? 'active' : 'ended';
  return h('div', { class: `tile stack var var-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/variances`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.expected), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'small muted' }, `${x.categoryLabel} · ${fmtDateTime(x.occurredAt)} · recorded by ${x.recordedBy}`),
    h('dl', { class: 'var-pair' },
      h('dt', {}, 'Instead'), h('dd', {}, x.whatHappened),
      h('dt', {}, 'Why'), h('dd', {}, x.reasonLabel),
      h('dt', {}, 'Context'), h('dd', {}, x.context),
      x.decisionLabel ? [h('dt', {}, 'Decision'), h('dd', {}, `${x.decisionLabel}${x.action ? `: ${x.action}` : ''} (${x.decidedBy})`)] : null,
      x.watch ? [h('dt', {}, 'Watch for'), h('dd', {}, `${x.watch}${x.followUpBy && x.state === 'MONITORING' ? ` · follow up by ${x.followUpBy}` : ''}`)] : null,
      x.endedNote && x.state !== 'MONITORING' ? [h('dt', {}, x.state === 'ENTERED_IN_ERROR' ? 'Error' : 'Outcome'), h('dd', {}, `${x.endedNote} (${x.endedBy})`)] : null),
    x.mistake && x.state !== 'ENTERED_IN_ERROR' ? h('div', { class: 'small notice' }, 'A mistake or omission: report it as an incident too.') : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Variances view in the Live Workstation.
export function variancesPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d, reload) }, 'Record a variance')) : null,
    d.open.length ? d.open.map((x) => varianceCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No open variances.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier variances (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => varianceCard(x, d, reload)))) : null,
  );
}

// Home → Variances.
export async function variancesView() {
  const d = await get('/api/work/variances');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => varianceCard({ ...x, actions: [] }, view, () => go('/work/variances'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Variances', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Care in your service that did not happen as expected: decisions needed, follow-ups due, and what is being watched. Open the person to act.'),
    section('Waiting for a decision', d.toDecide, 'Nothing waiting for a decision.'),
    section('Follow-up due', d.followUpDue, 'No follow-ups due.'),
    section('Being followed up', d.monitoring, 'Nothing being followed up.'),
  );
}
