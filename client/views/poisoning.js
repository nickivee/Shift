import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Poisoning and overdose in ED: what was taken → advice as given → the doctor's plan with timed
// checks → checks done → medically cleared, or admitted. SHIFT holds no toxic doses of its own.
const LABEL = { advice: 'Advice given', plan: 'Plan and checks', safety: 'Safety assessment', clear: 'Medically cleared', admit: 'Admit' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function recordDialog(personId, o, reload) {
  const substances = h('input', { 'aria-label': 'What was taken', placeholder: 'e.g. Paracetamol 500 mg tablets' });
  const amount = h('input', { 'aria-label': 'How much', placeholder: 'e.g. About 20 tablets; packet of 24 found with 4 left' });
  const route = select(Object.entries(o.route), 'How', null);
  route.value = 'ORAL';
  const timeKnown = select(Object.entries(o.timeKnown), 'Is the time known', null);
  const takenAt = h('input', { type: 'datetime-local', 'aria-label': 'When', value: stamp(new Date(Date.now() - 3600_000)) });
  const whenField = field('When', takenAt);
  timeKnown.addEventListener('change', () => { whenField.hidden = timeKnown.value === 'UNKNOWN'; });
  const intent = select(Object.entries(o.intent), 'Why', 'Choose…');
  const source = h('input', { 'aria-label': 'Who told us', placeholder: 'e.g. Patient; flatmate who found her; ambulance' });
  dialog('Poisoning or overdose', h('div', { class: 'stack' }, field('What was taken', substances), field('How much', amount), field('How', route),
    field('Is the time known', timeKnown), whenField, field('Why', intent), field('Who told us', source)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/poisoning`, { substances: substances.value, amount: amount.value, route: route.value, timeKnown: timeKnown.value, takenAt: takenAt.value, intent: intent.value, source: source.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function adviceDialog(x, o, reload) {
  const from = select(Object.entries(o.adviceFrom), 'From', null);
  const who = h('input', { 'aria-label': 'Who', placeholder: 'e.g. Sam, by phone' });
  const advice = h('textarea', { 'aria-label': 'Advice', placeholder: 'Write it as it was given, e.g. "Level at 4 hours after the time taken; treat if above the line; obs hourly"' });
  dialog(`Advice: ${x.substances}`, h('div', { class: 'stack' }, field('From', from), field('Who', who), field('Advice', advice)), 'Save', async () => {
    await post(`/api/work/poisoning/${x.id}/advice`, { from: from.value, who: who.value, advice: advice.value });
    toast('Saved.');
    reload();
  });
}

function planDialog(x, reload) {
  const plan = h('textarea', { 'aria-label': 'Plan', placeholder: 'e.g. Obs hourly; cardiac monitor; tell me if drowsy, vomiting or heart rate over 120' });
  plan.value = x.plan ?? '';
  const until = h('input', { type: 'datetime-local', 'aria-label': 'Watch until' });
  const base = x.takenAt ? new Date(x.takenAt) : new Date();
  const rows = [0, 1, 2].map((i) => {
    const what = h('input', { 'aria-label': `Check ${i + 1}`, placeholder: i ? 'Optional' : 'e.g. Paracetamol level' });
    const at = h('input', { type: 'datetime-local', 'aria-label': `Check ${i + 1} time`, value: i ? '' : stamp(new Date(Math.max(base.getTime() + 4 * 3600_000, Date.now() + 15 * 60_000))) });
    return { what, at, el: h('div', { class: 'row' }, what, at) };
  });
  dialog(`Plan: ${x.substances}`, h('div', { class: 'stack' }, field('What to watch for and do', plan), field('Watch until', until),
    h('div', { class: 'stack' }, h('b', { class: 'small' }, 'Timed checks'), ...rows.map((r) => r.el)),
    h('p', { class: 'small muted' }, 'SHIFT has no toxic doses or treatment lines of its own. Use the advice given and your judgement.')), 'Save', async () => {
    await post(`/api/work/poisoning/${x.id}/plan`, { plan: plan.value, watchUntil: until.value, checks: rows.map((r) => ({ what: r.what.value, dueAt: r.what.value ? r.at.value : '' })) });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function checkDialog(x, c, reload) {
  const note = h('input', { 'aria-label': 'What was done or found', placeholder: 'e.g. Blood taken 3.10pm and sent; or not needed, because…' });
  dialog(`${c.what}`, h('div', { class: 'stack' }, field('What was done or found', note)), 'Save', async () => {
    await post(`/api/work/poisoning/${x.id}/checked`, { checkId: c.id, note: note.value });
    toast('Saved.');
    reload();
  });
}

function noteDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': action === 'safety' ? 'Safety assessment' : 'Why', placeholder: action === 'safety'
    ? 'e.g. Seen by Mental Health liaison (Aroha T) 4pm; low immediate risk; safety plan with her mum; follow-up tomorrow'
    : action === 'clear' ? 'e.g. 4-hour level below the treatment line on Poisons Centre advice; obs normal; eating and drinking' : 'e.g. Level above the line; needs acetylcysteine' });
  const to = h('input', { 'aria-label': 'Admitted to', placeholder: 'e.g. General Medicine' });
  const warn = action === 'clear' && x.intent === 'DELIBERATE' && !x.safety
    ? h('p', { class: 'small warn-text' }, 'No safety assessment is recorded yet for this deliberate self-harm.') : null;
  dialog(`${LABEL[action]}: ${x.substances}`, h('div', { class: 'stack' }, action === 'admit' ? field('Admitted to', to) : null,
    field(action === 'safety' ? 'Who assessed their safety, what they found, and the plan' : 'Why', note), warn), 'Save', async () => {
    await post(`/api/work/poisoning/${x.id}/${action}`, action === 'safety' ? { safety: note.value } : { note: note.value, admittedTo: to.value });
    toast('Saved.');
    reload();
  });
}

function card(x, o, reload) {
  const overdue = x.checks.some((c) => c.overdue);
  const tone = overdue ? 'warn' : x.state === 'CLEARED' ? 'ok' : '';
  return h('div', { class: 'tile stack poisoning' },
    h('div', { class: 'spread' }, h('b', {}, x.substances), h('span', { class: `tag ${tone}` }, overdue ? 'Check overdue' : x.stateLabel)),
    h('div', { class: 'small' }, `${x.amount} · ${x.routeLabel} · ${x.takenAt ? `${x.timeKnown === 'ESTIMATED' ? 'about ' : ''}${fmtDateTime(x.takenAt)}` : 'time not known'} · `,
      h('b', {}, x.intentLabel), ` · told by ${x.source}`),
    x.advice.length ? h('div', { class: 'stack' }, x.advice.map((a) => h('div', { class: 'small advice' }, h('b', {}, `${a.sourceLabel} (${a.who}): `), a.advice,
      h('div', { class: 'muted' }, `${a.by}, ${fmtDateTime(a.at)}`)))) : h('div', { class: 'small muted' }, 'No advice recorded yet.'),
    x.plan ? h('div', { class: 'small' }, h('b', {}, `Plan (${x.plannedBy}): `), x.plan, x.watchUntil ? ` Watch until ${fmtDateTime(x.watchUntil)}.` : '') : null,
    x.checks.length ? h('ul', { class: 'checks' }, x.checks.map((c) => h('li', { class: c.doneAt ? 'done' : c.overdue ? 'overdue' : '' },
      h('span', {}, h('b', {}, c.what), ` · ${fmtDateTime(c.dueAt)}`, c.doneAt ? h('span', { class: 'muted' }, ` · ${c.doneBy}: ${c.note}`) : c.overdue ? h('span', { class: 'warn-text' }, ' · overdue') : null),
      !c.doneAt && x.canTick ? h('button', { class: 'btn small primary', onclick: () => checkDialog(x, c, reload) }, 'Done') : null))) : null,
    x.intent === 'DELIBERATE' ? (x.safety ? h('div', { class: 'small' }, h('b', {}, `Safety (${x.safetyBy}): `), x.safety)
      : h('div', { class: 'small warn-text' }, 'Safety assessment not recorded yet.')) : null,
    x.outcomeNote ? h('div', { class: 'small' }, h('b', {}, x.state === 'ADMITTED' ? `Admitted to ${x.admittedTo} (${x.outcomeBy}): ` : `Medically cleared (${x.outcomeBy}): `), x.outcomeNote) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', { class: `btn small${a === 'plan' && !x.plan ? ' primary' : ''}`,
      onclick: () => (a === 'advice' ? adviceDialog(x, o, reload) : a === 'plan' ? planDialog(x, reload) : noteDialog(x, a, reload)) }, a === 'plan' && x.plan ? 'Change plan or add checks' : LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// ED doctors' Medical Assessment and ED nurses' Monitoring.
export function poisoningPanel(personId, s, reload) {
  if (!s || (!s.current.length && !s.past.length && !s.canRecord)) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Poisoning or overdose'),
      s.canRecord && !s.current.length ? h('button', { class: 'btn small', onclick: () => recordDialog(personId, s.options, reload) }, 'Record a poisoning') : null),
    s.current.length ? s.current.map((x) => card(x, s.options, reload)) : null,
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}
