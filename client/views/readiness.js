import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Readiness: assessment asked for → what must be done first → done, still to do or not applicable →
// decided by someone allowed to → ready, ready with conditions, or not ready → reassessed.
const TONE = { ASSESSING: 'warn', READY: 'ok', CONDITIONAL: 'warn', NOT_READY: 'danger', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };

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
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const send = (x, action, body) => post(`/api/work/readiness/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

function raiseDialog(personId, d, reload) {
  const kind = select(Object.entries(d.options.kinds), 'Ready for');
  const purpose = h('input', { type: 'text', 'aria-label': 'What exactly', placeholder: 'e.g. Home to her daughter\'s, or Knee aspiration' });
  const neededBy = h('input', { type: 'date', 'aria-label': 'Needed by', min: addDays(0) });
  const note = h('input', { type: 'text', 'aria-label': 'Note', placeholder: 'Optional' });
  dialog('Assess readiness', h('div', { class: 'stack' }, field('Ready for', kind), field('What exactly', purpose), field('Needed by', neededBy), field('Note', note),
    h('div', { class: 'small muted' }, 'SHIFT adds the usual things to be done first. You can add more.')), 'Start', async () => {
    await post(`/api/work/patients/${personId}/readiness`, { kind: kind.value, purpose: purpose.value, neededBy: neededBy.value, note: note.value });
    toast('Readiness assessment started.');
    reload();
  });
}

function naDialog(x, i, reload) {
  const note = h('textarea', { 'aria-label': 'Why it does not apply', placeholder: 'e.g. No blood thinners charted' });
  dialog(`Not applicable: ${i.label}`, field('Why it does not apply', note), 'Save', async () => {
    await send(x, 'item', { itemId: i.id, status: 'NOT_APPLICABLE', note: note.value });
    reload();
  });
}

function addDialog(x, reload) {
  const label = h('input', { type: 'text', 'aria-label': 'What must be done', placeholder: 'e.g. Hearing aids in' });
  let essential = 'YES';
  const ess = h('fieldset', { class: 'row' }, h('legend', {}, 'Must it be done before they are ready?'),
    choice('essential', 'YES', 'Yes, essential', () => { essential = 'YES'; }), choice('essential', 'NO', 'No, helpful', () => { essential = 'NO'; }));
  ess.querySelector('input[value=YES]').checked = true;
  dialog(`Add to: ${x.purpose}`, h('div', { class: 'stack' }, field('What must be done', label), ess), 'Add', async () => {
    await send(x, 'add', { label: label.value, essential });
    reload();
  });
}

function decideDialog(x, reload) {
  let decision = '';
  const conditions = h('textarea', { 'aria-label': 'Conditions', placeholder: 'e.g. Only once the INR is under 1.5 this morning' });
  const condField = field('Conditions', conditions);
  const note = h('textarea', { 'aria-label': 'Your assessment', placeholder: 'Optional' });
  const when = h('input', { type: 'date', 'aria-label': 'Reassess by', min: addDays(0), value: addDays(1) });
  const whenField = field('Reassess by', when);
  const sync = () => {
    condField.hidden = decision !== 'CONDITIONAL';
    whenField.firstChild.textContent = decision === 'READY' ? 'Valid until (optional)' : 'Reassess by';
    if (decision === 'READY') when.value = '';
    else if (!when.value) when.value = addDays(1);
    note.placeholder = decision === 'NOT_READY' ? 'Why not ready, e.g. Still needs oxygen; not safe on the stairs yet' : 'Optional';
  };
  const out = x.essentialOutstanding;
  dialog(`Decide: ${x.purpose}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, x.kindLabel),
    out.length ? h('div', { class: 'small notice' }, `Essential and still to do: ${out.join('; ')}`) : h('div', { class: 'small' }, 'Everything essential is done or not applicable.'),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Decision'),
      choice('decision', 'READY', 'Ready', () => { decision = 'READY'; sync(); }),
      choice('decision', 'CONDITIONAL', 'Ready with conditions', () => { decision = 'CONDITIONAL'; sync(); }),
      choice('decision', 'NOT_READY', 'Not ready', () => { decision = 'NOT_READY'; sync(); })),
    condField, field('Your assessment', note), whenField), 'Save decision', async () => {
    await send(x, 'decide', { decision, conditions: conditions.value, note: note.value, reassessBy: when.value });
    reload();
  });
  sync();
}

function reassessDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why reassess', placeholder: 'e.g. Oxygen now off; walking the stairs with the physio' });
  dialog(`Reassess: ${x.purpose}`, field('Why reassess', note), 'Reassess', async () => {
    await send(x, 'reassess', { note: note.value });
    reload();
  });
}

function closeDialog(x, o, reload) {
  const reason = select(Object.entries(o.endReasons), 'Why close');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Close: ${x.purpose}`, h('div', { class: 'stack' }, field('Why close', reason), field('Note', note)), 'Close it', async () => {
    await send(x, 'close', { reason: reason.value, note: note.value });
    reload();
  });
}

function errorDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Raised for the wrong person' });
  dialog(`Entered in error: ${x.purpose}`, field('Why', note), 'Mark as error', async () => {
    await send(x, 'error', { note: note.value });
    reload();
  });
}

const LABELS = { add: 'Add an item', decide: 'Decide', reassess: 'Reassess', close: 'Close', error: 'Entered in error' };
const PRIMARY = ['decide', 'reassess'];

function itemRow(x, i, reload) {
  const act = async (status) => { await send(x, 'item', { itemId: i.id, status }); reload(); };
  return h('li', { class: `rdy-item rdy-${i.status}${i.essential ? ' rdy-essential' : ''}` },
    h('span', {}, h('b', {}, i.label), i.essential ? null : h('span', { class: 'small muted' }, ' (helpful)'),
      i.status !== 'OUTSTANDING' ? h('span', { class: 'small muted' }, ` · ${i.statusLabel}${i.note ? `: ${i.note}` : ''} · ${i.doneBy}`) : null),
    x.canUpdateItems ? h('div', { class: 'row' },
      i.status === 'OUTSTANDING' ? [
        h('button', { class: 'btn small', onclick: () => act('COMPLETED') }, 'Done'),
        h('button', { class: 'btn small', onclick: () => naDialog(x, i, reload) }, 'Not applicable')]
        : h('button', { class: 'btn small', onclick: () => act('OUTSTANDING') }, 'Undo')) : null);
}

function readinessCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'add' ? addDialog(x, reload) : a === 'decide' ? decideDialog(x, reload) : a === 'reassess' ? reassessDialog(x, reload)
    : a === 'close' ? closeDialog(x, o, reload) : errorDialog(x, reload));
  const flag = x.reassessDue ? ['Reassess due', 'danger'] : x.late ? ['Needed by date passed', 'danger'] : [x.stateLabel, TONE[x.state]];
  const tone = x.reassessDue || x.late || x.state === 'NOT_READY' ? 'alert' : x.state === 'READY' ? 'ready' : ['ASSESSING', 'CONDITIONAL'].includes(x.state) ? 'waiting' : 'ended';
  const open = ['ASSESSING', 'READY', 'CONDITIONAL', 'NOT_READY'].includes(x.state);
  const done = x.items.filter((i) => i.status !== 'OUTSTANDING').length;
  return h('div', { class: `tile stack rdy rdy-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/readiness`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.purpose), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'small' }, `${x.kindLabel}${x.neededBy ? ` · needed by ${x.neededBy}` : ''} · asked by ${x.raisedBy}`),
    x.decidedBy ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.decidedBy}, ${fmtDateTime(x.decidedAt)})`),
      x.decisionNote ? `: ${x.decisionNote}` : '', x.reassessBy ? ` · ${x.state === 'READY' ? 'valid until' : 'reassess by'} ${x.reassessBy}` : '') : null,
    x.conditions ? h('div', { class: 'small rdy-conditions' }, h('b', {}, 'Conditions: '), x.conditions) : null,
    x.items.length ? h('div', { class: 'small muted' }, `${done} of ${x.items.length} done or not applicable`) : null,
    open && x.items.length ? h('ul', { class: 'rdy-items' }, x.items.map((i) => itemRow(x, i, reload))) : null,
    x.state === 'ASSESSING' && x.essentialOutstanding.length === 0 && x.items.length ? h('div', { class: 'small' }, 'Everything essential is done. Waiting for a decision.') : null,
    x.state === 'CLOSED' || x.state === 'ENTERED_IN_ERROR' ? h('div', { class: 'small' }, h('b', {}, `${x.endLabel ?? x.stateLabel} (${x.endedBy}): `), x.endedNote ?? '') : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Readiness view in the Live Workstation.
export function readinessPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRaise ? h('div', {}, h('button', { class: 'btn primary', onclick: () => raiseDialog(personId, d, reload) }, 'Assess readiness')) : null,
    d.open.length ? d.open.map((x) => readinessCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No readiness being assessed now.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => readinessCard(x, d, reload)))) : null,
  );
}

// Home → Readiness.
export async function readinessView() {
  const d = await get('/api/work/readiness');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => readinessCard({ ...x, actions: [], canUpdateItems: false }, view, () => go('/work/readiness'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Readiness', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Readiness in your service: assessments waiting for a decision, reassessments due, what is still to do, and who is ready. Open the person to act.'),
    section('Waiting for a decision', d.toDecide, 'Nothing waiting for a decision.'),
    section('Reassessment due', d.reassess, 'No reassessments due.'),
    section('Still to do', d.assessing, 'Nothing with essential items still to do.'),
    section('Decided', d.decided, 'Nothing decided yet.'),
  );
}
