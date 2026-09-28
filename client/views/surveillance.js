import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Surveillance: need → how often or what triggers a check → the check → due → performed → result →
// review → continue, change or stop.
const TONE = { DUE: 'muted', PERFORMED: 'warn', RESULTED: 'warn', NOT_DONE: 'danger' };

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
const localNow = () => { const d = new Date(); return `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const send = (x, action, body) => post(`/api/work/surveillance/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

// How often, with a trigger and a first/next due date that show when they apply.
function timingFields(o, x = null) {
  const every = select(Object.entries(o.intervals), 'How often');
  const trigger = h('input', { type: 'text', 'aria-label': 'Also check when', placeholder: 'e.g. If she falls again or becomes drowsy' });
  const due = h('input', { type: 'date', 'aria-label': 'Next check due', min: addDays(0) });
  const dueField = field('Next check due', due);
  const sync = () => { dueField.hidden = every.value === '0' || every.value === ''; };
  every.addEventListener('change', () => { sync(); if (!due.value && Number(every.value)) due.value = addDays(Number(every.value)); });
  if (x) { every.value = String(x.everyDays ?? 0); trigger.value = x.triggerText ?? ''; due.value = x.nextDue ?? ''; }
  sync();
  return { every, trigger, due, fields: [field('How often', every), field('Also check when (the trigger)', trigger), dueField] };
}

function setUpDialog(personId, o, reload) {
  const kind = select(o.kinds.map((k) => [k.id, k.label]), 'Watching for');
  const need = h('textarea', { 'aria-label': 'Why it is needed', placeholder: 'e.g. Started spironolactone; risk of high potassium' });
  const check = h('input', { type: 'text', 'aria-label': 'The check each time', placeholder: 'e.g. Creatinine, eGFR and potassium' });
  const t = timingFields(o);
  kind.addEventListener('change', () => {
    const k = o.kinds.find((x) => x.id === kind.value);
    if (!k) return;
    check.value = k.check;
    t.every.value = String(k.everyDays ?? 0);
    t.every.dispatchEvent(new Event('change'));
  });
  dialog('Set up surveillance', h('div', { class: 'stack' }, field('Watching for', kind), field('Why it is needed', need), field('The check each time', check), ...t.fields),
    'Set up', async () => {
      await post(`/api/work/patients/${personId}/surveillance`, { kind: kind.value, need: need.value, investigation: check.value, every: t.every.value, trigger: t.trigger.value, firstDue: t.due.value });
      toast('Surveillance set up.');
      reload();
    });
}

function performDialog(x, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When', value: localNow() });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Bloods taken, sent to the lab' });
  dialog(`Done: ${x.investigation}`, h('div', { class: 'stack' }, field('When', when), field('Note', note)), 'Save', async () => {
    await send(x, 'perform', { when: when.value ? new Date(when.value).toISOString() : '', note: note.value });
    reload();
  });
}

function resultDialog(x, o, reload) {
  let finding = '';
  const result = h('textarea', { 'aria-label': 'Result', placeholder: 'e.g. Potassium 5.4, creatinine 128 (was 110)' });
  dialog(`Result: ${x.investigation}`, h('div', { class: 'stack' }, field('Result', result),
    h('fieldset', { class: 'row' }, h('legend', {}, 'What does it show?'), Object.entries(o.findings).map(([k, v]) => choice('finding', k, v, () => { finding = k; })))),
  'Save', async () => {
    await send(x, 'result', { result: result.value, finding });
    reload();
  });
}

function notDoneDialog(x, o, reload) {
  const reason = select(Object.entries(o.notDoneReasons), 'Why');
  const note = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Declined the blood test; will ask again tomorrow' });
  dialog(`Not done: ${x.investigation}`, h('div', { class: 'stack' }, field('Why', reason), field('What happened', note)), 'Save', async () => {
    await send(x, 'notdone', { reason: reason.value, note: note.value });
    reload();
  });
}

function reviewDialog(x, o, reload) {
  const c = x.current;
  let decision = '';
  const note = h('textarea', { 'aria-label': 'Your review', placeholder: 'e.g. Potassium a little high; spironolactone halved' });
  const next = h('input', { type: 'date', 'aria-label': 'Next check due', min: addDays(1), value: x.nextDue ?? '' });
  const nextField = field('Next check due', next);
  const check = h('input', { type: 'text', 'aria-label': 'The check each time', value: x.investigation });
  const t = timingFields(o, x);
  const change = h('div', { class: 'stack' }, field('The check each time', check), ...t.fields);
  const reason = select(Object.entries(o.ceaseReasons), 'Why stop');
  const stop = field('Why stop', reason);
  const sync = () => { nextField.hidden = decision !== 'CONTINUE' || !x.everyDays; change.hidden = decision !== 'MODIFY'; stop.hidden = decision !== 'CEASE'; };
  sync();
  const shown = c.state === 'RESULTED'
    ? h('div', { class: 'small' }, h('b', {}, `Result (${c.findingLabel.toLowerCase()}): `), c.result)
    : h('div', { class: 'small' }, h('b', {}, `Not done (${c.notDoneLabel.toLowerCase()}): `), c.notDoneNote);
  dialog(`Review: ${x.investigation}`, h('div', { class: 'stack' }, shown,
    h('fieldset', { class: 'row' }, h('legend', {}, 'What next?'), Object.entries(o.decisions).map(([k, v]) => choice('decision', k, v, () => { decision = k; sync(); }))),
    field('Your review', note), nextField, change, stop), 'Save review', async () => {
    const body = { decision, note: note.value };
    if (decision === 'CONTINUE') body.nextDue = next.value;
    if (decision === 'MODIFY') Object.assign(body, { investigation: check.value, every: t.every.value, trigger: t.trigger.value, nextDue: t.due.value });
    if (decision === 'CEASE') body.reason = reason.value;
    await send(x, 'review', body);
    reload();
  });
}

function ceaseDialog(x, o, reload) {
  const reason = select(Object.entries(o.ceaseReasons), 'Why');
  const note = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Spironolactone stopped by cardiology' });
  dialog(`Stop: ${x.kindLabel}`, h('div', { class: 'stack' }, field('Why', reason), field('What happened', note)), 'Stop surveillance', async () => {
    await send(x, 'cease', { reason: reason.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  trigger: ['Trigger happened', 'What happened', 'e.g. Found on the floor at 0300; hit her head', 'Check now'],
  error: ['Entered in error', 'Why', 'e.g. Set up for the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.kindLabel}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = {
  perform: 'Done', result: 'Add result', notdone: 'Not done', review: 'Review', trigger: 'Trigger happened', cease: 'Stop surveillance', error: 'Entered in error',
};
const PRIMARY = ['perform', 'result', 'review'];

function checkLine(c) {
  if (!c) return null;
  const flag = c.overdue ? ['Overdue', 'danger'] : c.concerning ? ['Concerning result', 'danger'] : c.dueToday ? ['Due today', 'warn'] : [c.stateLabel, TONE[c.state]];
  return h('div', { class: 'surv-check stack' },
    h('div', { class: 'spread' }, h('b', {}, c.state === 'DUE' ? `Next check due ${c.dueDate}` : `Check due ${c.dueDate}`), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    c.why && c.why !== 'Scheduled' ? h('div', { class: 'small' }, h('b', {}, 'Triggered: '), c.why) : null,
    c.performedAt && c.state !== 'NOT_DONE' ? h('div', { class: 'small muted' }, `Done ${fmtDateTime(c.performedAt)} by ${c.performedBy}${c.performedNote ? ` · ${c.performedNote}` : ''}`) : null,
    c.result ? h('div', { class: 'small' }, h('b', {}, `Result (${c.findingLabel.toLowerCase()}, ${c.resultBy}): `), c.result) : null,
    c.state === 'NOT_DONE' ? h('div', { class: 'small' }, h('b', {}, `Not done (${c.notDoneLabel.toLowerCase()}): `), c.notDoneNote) : null,
  );
}

function planCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'perform' ? performDialog(x, reload) : a === 'result' ? resultDialog(x, o, reload) : a === 'notdone' ? notDoneDialog(x, o, reload)
    : a === 'review' ? reviewDialog(x, o, reload) : a === 'cease' ? ceaseDialog(x, o, reload) : noteDialog(x, a, reload));
  const c = x.current;
  const tone = x.state !== 'ACTIVE' ? 'ended' : c?.overdue || c?.concerning || c?.state === 'NOT_DONE' ? 'alert' : c && c.state !== 'DUE' ? 'waiting' : 'active';
  return h('div', { class: `tile stack surv surv-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/surveillance`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.kindLabel), x.state !== 'ACTIVE' ? h('span', { class: 'tag muted' }, x.stateLabel) : null),
    h('div', { class: 'small' }, x.need),
    h('div', { class: 'small' }, h('b', {}, 'Check: '), `${x.investigation} · ${x.everyLabel.toLowerCase()}`),
    x.triggerText ? h('div', { class: 'small' }, h('b', {}, 'Also check when: '), x.triggerText) : null,
    x.state === 'ACTIVE' ? (checkLine(c) ?? h('div', { class: 'small muted' }, 'No check due. The next one is when the trigger happens.')) : null,
    x.last ? h('div', { class: 'small muted' }, `Last reviewed ${fmtDateTime(x.last.reviewedAt)} by ${x.last.reviewedBy}: ${x.last.decisionLabel.toLowerCase()}. ${x.last.reviewNote}`) : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.ceaseLabel ?? x.stateLabel} (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), x.endedNote) : null,
    h('div', { class: 'small muted' }, `Set up by ${x.setBy} · ${fmtDateTime(x.setAt)}`),
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    x.past.length ? h('details', {}, h('summary', {}, `Earlier checks (${x.past.length})`),
      h('ol', { class: 'det-steps' }, x.past.map((p) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, `Due ${p.dueDate}`), h('span', { class: 'small muted' }, p.stateLabel)),
        p.result ? h('div', {}, `${p.result} (${p.findingLabel.toLowerCase()})`) : null,
        p.notDoneNote ? h('div', {}, `Not done: ${p.notDoneNote}`) : null,
        p.reviewNote ? h('div', { class: 'small' }, `${p.decisionLabel} (${p.reviewedBy}): ${p.reviewNote}`) : null)))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Surveillance view in the Live Workstation.
export function surveillancePanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canSetUp ? h('div', {}, h('button', { class: 'btn primary', onclick: () => setUpDialog(personId, d.options, reload) }, 'Set up surveillance')) : null,
    d.active.length ? d.active.map((x) => planCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No surveillance.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Stopped (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => planCard(x, d, reload)))) : null,
  );
}

// Home → Surveillance.
export async function surveillanceView() {
  const d = await get('/api/work/surveillance');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => planCard({ ...x, actions: [] }, view, () => go('/work/surveillance'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Surveillance', () => go('/work/home')),
    h('div', { class: 'banner' }, `Surveillance checks in your service: ${d.canReview ? 'results and missed checks for you to review, ' : 'results and missed checks waiting for review, '}overdue, due in the next 7 days, and done but waiting for a result. Open the person to act.`),
    section('To review', d.toReview, 'Nothing to review.'),
    section('Overdue', d.overdue, 'Nothing overdue.'),
    section('Due in the next 7 days', d.dueSoon, 'Nothing due soon.'),
    section('Waiting for a result', d.waiting, 'Nothing waiting for a result.'),
  );
}
