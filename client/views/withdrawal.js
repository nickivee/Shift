import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Alcohol and drug withdrawal: what they use and when they last did → readings as scored → the
// doctor's plan with timed checks → settled, or handed on. SHIFT works out no scores of its own.
const LABEL = { reading: 'Add a reading', plan: 'Plan and checks', settle: 'Settled', handon: 'Hand on' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function recordDialog(personId, o, reload) {
  const substance = select(Object.entries(o.substance), 'What from', 'Choose…');
  const usual = h('input', { 'aria-label': 'Usual use', placeholder: 'e.g. About 12 cans a day for 10 years' });
  const timeKnown = select(Object.entries(o.timeKnown), 'Is the time known', null);
  const lastUse = h('input', { type: 'datetime-local', 'aria-label': 'Last used', value: stamp(new Date(Date.now() - 12 * 3600_000)) });
  const whenField = field('Last used', lastUse);
  timeKnown.addEventListener('change', () => { whenField.hidden = timeKnown.value === 'UNKNOWN'; });
  const history = h('input', { 'aria-label': 'Past withdrawal', placeholder: 'Past severe withdrawal, seizures or delirium, or "None known"' });
  const source = h('input', { 'aria-label': 'Who told us', placeholder: 'e.g. Patient; wife; ambulance' });
  dialog('Alcohol or drug withdrawal', h('div', { class: 'stack' }, field('What from', substance), field('How much and how often they usually use', usual),
    field('Is the time of the last use known', timeKnown), whenField, field('Past severe withdrawal', history), field('Who told us', source)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/withdrawal`, { substance: substance.value, usual: usual.value, timeKnown: timeKnown.value, lastUse: lastUse.value, history: history.value, source: source.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function readingDialog(x, reload) {
  const scale = h('input', { 'aria-label': 'Scale or tool', placeholder: 'e.g. CIWA-Ar, or the ward chart' });
  const score = h('input', { 'aria-label': 'Score', placeholder: 'As scored, if there is one' });
  const signs = h('textarea', { 'aria-label': 'What you saw', placeholder: 'e.g. Tremor, sweating, anxious; says no hallucinations' });
  dialog(`Reading: ${x.substanceLabel}`, h('div', { class: 'stack' }, field('Scale or tool', scale), field('Score', score), field('What you saw and what they said', signs),
    h('p', { class: 'small muted' }, 'SHIFT does not work out or explain scores. Write the score as you scored it.')), 'Save', async () => {
    await post(`/api/work/withdrawal/${x.id}/reading`, { scale: scale.value, score: score.value, signs: signs.value });
    toast('Saved.');
    reload();
  });
}

function planDialog(x, reload) {
  const plan = h('textarea', { 'aria-label': 'Plan', placeholder: 'e.g. Readings every 4 hours per the ward protocol; tell me if confused, shaking more or seizure' });
  plan.value = x.plan ?? '';
  const until = h('input', { type: 'datetime-local', 'aria-label': 'Watch until' });
  const rows = [0, 1, 2].map((i) => {
    const what = h('input', { 'aria-label': `Check ${i + 1}`, placeholder: i ? 'Optional' : 'e.g. Reading and review' });
    const at = h('input', { type: 'datetime-local', 'aria-label': `Check ${i + 1} time`, value: i ? '' : stamp(new Date(Date.now() + 4 * 3600_000)) });
    return { what, at, el: h('div', { class: 'row' }, what, at) };
  });
  dialog(`Plan: ${x.substanceLabel}`, h('div', { class: 'stack' }, field('What to watch for and do', plan), field('Watch until', until),
    h('div', { class: 'stack' }, h('b', { class: 'small' }, 'Timed checks'), ...rows.map((r) => r.el)),
    h('p', { class: 'small muted' }, 'SHIFT has no withdrawal scores, thresholds or doses of its own. Use your service protocol and judgement.')), 'Save', async () => {
    await post(`/api/work/withdrawal/${x.id}/plan`, { plan: plan.value, watchUntil: until.value, checks: rows.map((r) => ({ what: r.what.value, dueAt: r.what.value ? r.at.value : '' })) });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function checkDialog(x, c, reload) {
  const note = h('input', { 'aria-label': 'What was done or found', placeholder: 'e.g. Seen 8.10pm, settled, eating; or not needed, because…' });
  dialog(`${c.what}`, h('div', { class: 'stack' }, field('What was done or found', note)), 'Save', async () => {
    await post(`/api/work/withdrawal/${x.id}/checked`, { checkId: c.id, note: note.value });
    toast('Saved.');
    reload();
  });
}

function noteDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: action === 'settle'
    ? 'e.g. No signs for 24 hours; eating and drinking; reviewed with the addiction service' : 'e.g. Wants support to stay off alcohol; given the service number' });
  const to = h('input', { 'aria-label': 'Handed on to', placeholder: 'e.g. Community alcohol and drug service' });
  dialog(`${LABEL[action]}: ${x.substanceLabel}`, h('div', { class: 'stack' }, action === 'handon' ? field('Handed on to', to) : null,
    field(action === 'settle' ? 'Why the withdrawal has settled' : 'Why, and what they were told', note)), 'Save', async () => {
    await post(`/api/work/withdrawal/${x.id}/${action}`, { note: note.value, handedTo: to.value });
    toast('Saved.');
    reload();
  });
}

function card(x, reload) {
  const overdue = x.checks.some((c) => c.overdue);
  const tone = overdue ? 'warn' : x.state === 'SETTLED' ? 'ok' : '';
  return h('div', { class: 'tile stack withdrawal' },
    h('div', { class: 'spread' }, h('b', {}, x.substanceLabel), h('span', { class: `tag ${tone}` }, overdue ? 'Check overdue' : x.stateLabel)),
    h('div', { class: 'small' }, `Usually ${x.usual} · ${x.lastUseAt ? `last used ${x.timeKnown === 'ESTIMATED' ? 'about ' : ''}${fmtDateTime(x.lastUseAt)}` : 'time of last use not known'} · past withdrawal: ${x.history} · told by ${x.source}`),
    x.readings.length ? h('div', { class: 'stack' }, x.readings.slice(0, 3).map((a) => h('div', { class: 'small advice' }, h('b', {}, `${a.scale}${a.score ? ` ${a.score}` : ''}: `), a.signs,
      h('div', { class: 'muted' }, `${a.by}, ${fmtDateTime(a.at)}`)))) : h('div', { class: 'small muted' }, 'No readings yet.'),
    x.plan ? h('div', { class: 'small' }, h('b', {}, `Plan (${x.plannedBy}): `), x.plan, x.watchUntil ? ` Watch until ${fmtDateTime(x.watchUntil)}.` : '') : null,
    x.checks.length ? h('ul', { class: 'checks' }, x.checks.map((c) => h('li', { class: c.doneAt ? 'done' : c.overdue ? 'overdue' : '' },
      h('span', {}, h('b', {}, c.what), ` · ${fmtDateTime(c.dueAt)}`, c.doneAt ? h('span', { class: 'muted' }, ` · ${c.doneBy}: ${c.note}`) : c.overdue ? h('span', { class: 'warn-text' }, ' · overdue') : null),
      !c.doneAt && x.canTick ? h('button', { class: 'btn small primary', onclick: () => checkDialog(x, c, reload) }, 'Done') : null))) : null,
    x.outcomeNote ? h('div', { class: 'small' }, h('b', {}, x.state === 'HANDED_ON' ? `Handed on to ${x.handedTo} (${x.outcomeBy}): ` : `Settled (${x.outcomeBy}): `), x.outcomeNote) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', { class: `btn small${a === 'plan' && !x.plan ? ' primary' : ''}`,
      onclick: () => (a === 'reading' ? readingDialog(x, reload) : a === 'plan' ? planDialog(x, reload) : noteDialog(x, a, reload)) }, a === 'plan' && x.plan ? 'Change plan or add checks' : LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// ED and ward doctors' assessment and review, ED and ward nurses' Monitoring.
export function withdrawalPanel(personId, s, reload) {
  if (!s || (!s.current.length && !s.past.length && !s.canRecord)) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Alcohol or drug withdrawal'),
      s.canRecord && !s.current.length ? h('button', { class: 'btn small', onclick: () => recordDialog(personId, s.options, reload) }, 'Record a withdrawal') : null),
    s.current.length ? s.current.map((x) => card(x, reload)) : null,
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, reload)))) : null,
  );
}
