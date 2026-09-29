import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Clinical pathways: trigger or eligibility → started → each step done, skipped, not applicable or deferred → deviations → escalation → completed or exited.
const TONE = { SUGGESTED: 'warn', ACTIVE: 'ok', COMPLETED: 'muted', EXITED: 'muted', DECLINED: 'muted', ENTERED_IN_ERROR: 'muted' };
const STEP_TONE = { PENDING: 'muted', DONE: 'ok', SKIPPED: 'danger', NOT_APPLICABLE: 'muted', DEFERRED: 'warn' };
const URGENCY = { IMMEDIATE: 'Immediate', URGENT: 'Urgent', ROUTINE: 'Routine' };
const DEFER = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, 'Tomorrow (24 hours)']];

const send = (x, action, body) => post(`/api/work/pathways/${x.id}/${action}`, body);

// Yes/no for each eligibility question.
function questions(list) {
  const answers = list.map(() => null);
  const el = h('div', { class: 'stack' }, list.map((q, i) => h('fieldset', { class: 'row pathway-question' }, h('legend', {}, q),
    h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name: `q${i}`, value: 'yes', onchange: () => { answers[i] = true; } }), 'Yes'),
    h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name: `q${i}`, value: 'no', onchange: () => { answers[i] = false; } }), 'No'))));
  return { el, answers };
}

function startDialog(personId, o, reload) {
  const pathway = select(o.pathways.map((p) => [p.id, p.label]), 'Pathway');
  const purpose = h('p', { class: 'small muted' });
  const holder = h('div', {});
  let q = questions([]);
  pathway.addEventListener('change', () => {
    const p = o.pathways.find((x) => x.id === pathway.value);
    purpose.textContent = p?.purpose ?? '';
    q = questions(p?.eligibility ?? []);
    holder.replaceChildren(p ? h('b', { class: 'small' }, 'Does the person meet the pathway?') : '', q.el);
  });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'What happened, and why the pathway if a question is not met' });
  dialog('Start a pathway', h('div', { class: 'stack' }, field('Pathway', pathway), purpose, holder, field('Note', note)), 'Start', async () => {
    await post(`/api/work/patients/${personId}/pathways`, { pathwayId: pathway.value, answers: q.answers, note: note.value });
    toast('Pathway started.');
    reload();
  });
}

function confirmDialog(x, reload) {
  const q = questions(x.eligibility.map((e) => e.question));
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Why the pathway, if a question is not met' });
  dialog(`Start: ${x.label}`, h('div', { class: 'stack' },
    x.triggerText ? h('p', { class: 'small' }, h('b', {}, 'Suggested by: '), x.triggerText) : null,
    h('b', { class: 'small' }, 'Does the person meet the pathway?'), q.el, field('Note', note)), 'Start', async () => {
    await send(x, 'start', { answers: q.answers, note: note.value });
    reload();
  });
}

function stepDialog(x, s, o, reload) {
  const to = select(Object.entries(o.stepStates).filter(([k]) => k !== 'PENDING' && k !== s.state), 'What happened');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. No head strike; moving all limbs' });
  const defer = select(DEFER.map(([m, l]) => [m, l]), 'Defer for');
  const deferField = field('Defer for', defer);
  deferField.hidden = true;
  to.addEventListener('change', () => { deferField.hidden = to.value !== 'DEFERRED'; });
  dialog(s.label, h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, `Due ${fmtDateTime(s.dueAt)}${s.optional ? ' · optional' : ''}`),
    field('What happened', to), deferField, field('Note (why, if skipped, deferred or not applicable)', note),
  ), 'Save', async () => {
    await send(x, 'step', { stepId: s.id, to: to.value, note: note.value, deferMins: defer.value });
    reload();
  });
}

function escalateDialog(x, o, target, reload) {
  const to = select(o.recipients.map((r) => [r.roleKey, r.label]), 'Escalate to');
  if (o.recipients.length === 1) to.value = o.recipients[0].roleKey;
  const urgency = select(Object.entries(URGENCY), 'Urgency');
  const note = h('textarea', { 'aria-label': 'Why you are worried', placeholder: 'e.g. Still not told the doctor; she now has a headache' });
  dialog(`Escalate: ${target.label}`, h('div', { class: 'stack' },
    field('Escalate to', to), field('How urgent', urgency), field('Why you are worried', note),
  ), 'Escalate', async () => {
    await send(x, 'escalate', { ...target.body, roleKey: to.value, urgency: urgency.value, note: note.value });
    toast('Escalated.');
    reload();
  });
}

function exitDialog(x, o, reload) {
  const reason = select(Object.entries(o.exitReasons), 'Reason');
  const note = h('textarea', { 'aria-label': 'What happens next', placeholder: 'e.g. Transferred to the ward; handed over to Grace' });
  dialog(`Exit early: ${x.label}`, h('div', { class: 'stack' }, field('Why', reason), field('What happens next', note)), 'Exit', async () => {
    await send(x, 'exit', { reason: reason.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  decline: ['Not needed', 'Why', 'e.g. Sat down on the floor on purpose; not a fall', 'Save'],
  complete: ['Complete the pathway', 'Note', 'Optional', 'Complete'],
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

const LABELS = { start: 'Start', decline: 'Not needed', complete: 'Complete', exit: 'Exit early', error: 'Entered in error' };

function pathwayCard(x, d, reload) {
  const o = d.options;
  const handler = (a) => () => (a === 'start' ? confirmDialog(x, reload) : a === 'exit' ? exitDialog(x, o, reload) : noteDialog(x, a, reload));
  const primary = x.state === 'SUGGESTED' ? 'start' : 'complete';
  const done = x.steps.filter((s) => !['PENDING', 'DEFERRED'].includes(s.state)).length;
  return h('div', { class: `tile stack pathway pathway-${x.state.toLowerCase()}${x.overdue ? ' pathway-overdue' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, x.label),
      h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? `${x.overdue} overdue` : x.stateLabel)),
    x.triggerText ? h('div', { class: 'small' }, x.triggerText) : null,
    h('div', { class: 'small muted' }, [
      x.state === 'SUGGESTED' ? `Suggested ${fmtDateTime(x.suggestedAt)} by ${x.suggestedBy}` : x.startedAt ? `Started ${fmtDateTime(x.startedAt)} by ${x.startedBy}` : null,
      x.steps.length ? `${done} of ${x.steps.length} steps recorded` : null,
    ].filter(Boolean).join(' · ')),
    x.state === 'SUGGESTED' ? h('div', { class: 'notice small' }, 'An entry suggests this pathway. Check the person meets it, then start it or say it is not needed.') : null,
    x.steps.length ? h('ol', { class: 'pathway-steps' }, x.steps.map((s) => h('li', { class: s.overdue ? 'overdue' : '' },
      h('div', { class: 'spread' },
        h('span', {}, s.label, s.optional ? h('span', { class: 'small muted' }, ' (optional)') : null),
        h('span', { class: 'row' },
          s.overdue && x.canEscalate ? h('button', { class: 'btn small', onclick: () => escalateDialog(x, o, { label: s.label, body: { stepId: s.id } }, reload) }, 'Escalate') : null,
          x.canRecordSteps && ['PENDING', 'DEFERRED'].includes(s.state)
            ? h('button', { class: `btn small${s.overdue ? ' primary' : ''}`, onclick: () => stepDialog(x, s, o, reload) }, s.state === 'DEFERRED' ? 'Deferred: record' : 'Record')
            : h('span', { class: `tag ${s.overdue ? 'danger' : STEP_TONE[s.state]}` }, s.overdue ? 'Overdue' : s.stateLabel))),
      s.stepKey === 'whanau' && d.whanauLimits?.length && ['PENDING', 'DEFERRED'].includes(s.state)
        ? h('div', { class: 'notice small' }, `Check who they allow to be told. ${d.whanauLimits.join(' · ')}`) : null,
      h('div', { class: 'small muted' }, s.at && !['PENDING'].includes(s.state)
        ? `${s.stateLabel} by ${s.by} ${fmtDateTime(s.at)}${s.note ? `: ${s.note}` : ''}${s.state === 'DEFERRED' ? ` · now due ${fmtDateTime(s.dueAt)}` : ''}`
        : `Due ${fmtDateTime(s.dueAt)}`)))) : null,
    x.deviations.length ? h('div', { class: 'stack' }, h('b', { class: 'small' }, `Deviations (${x.deviations.length})`),
      h('ul', { class: 'pathway-deviations' }, x.deviations.map((v) => h('li', {},
        h('div', { class: 'spread' }, h('span', {}, h('b', {}, v.kindLabel), ` · ${v.by}, ${fmtDateTime(v.at)}`),
          v.escalationId ? h('span', { class: 'tag warn' }, 'Escalated')
            : x.canEscalate ? h('button', { class: 'btn small', onclick: () => escalateDialog(x, o, { label: v.kindLabel, body: { deviationId: v.id } }, reload) }, 'Escalate') : null),
        h('div', { class: 'small' }, v.note))))) : null,
    x.eligibility.some((e) => e.answer !== null) ? h('details', {}, h('summary', {}, 'Eligibility'),
      h('ul', { class: 'small' }, x.eligibility.map((e) => h('li', {}, `${e.question}: ${e.answer ? 'yes' : 'no'}`)))) : null,
    x.endNote || x.exitLabel ? h('div', { class: 'small muted' }, `${x.stateLabel} ${fmtDateTime(x.endedAt)} by ${x.endedBy}${x.exitLabel ? `: ${x.exitLabel}` : ''}${x.endNote ? `. ${x.endNote}` : ''}`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === primary ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Pathways view in the Live Workstation.
export function pathwaysPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canManage ? h('div', {}, h('button', { class: 'btn primary', onclick: () => startDialog(personId, d.options, reload) }, 'Start a pathway')) : null,
    d.open.length ? d.open.map((x) => pathwayCard(x, d, reload)) : h('div', { class: 'card empty' }, 'Not on any pathway.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Finished (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => pathwayCard(x, d, reload)))) : null,
    h('p', { class: 'small muted' }, 'These pathways are the organisation\'s own examples and are not clinically validated.'),
  );
}

function row(x) {
  const next = x.steps.find((s) => s.overdue) ?? x.steps.find((s) => ['PENDING', 'DEFERRED'].includes(s.state));
  return h('div', { class: `tile stack pathway-${x.state.toLowerCase()}${x.overdue ? ' pathway-overdue' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/pathways`) }, h('b', {}, x.patient)),
        x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null),
      h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? `${x.overdue} overdue` : x.stateLabel)),
    h('div', {}, h('b', {}, x.label), x.triggerText ? ` · ${x.triggerText}` : ''),
    next ? h('div', { class: 'small muted' }, `${next.overdue ? 'Overdue' : 'Next'}: ${next.label}, due ${fmtDateTime(next.dueAt)}`) : null,
  );
}

// Home → Pathways.
export async function pathwaysView() {
  const d = await get('/api/work/pathways');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Pathways', () => go('/work/home')),
    h('div', { class: 'banner' }, `Clinical pathways for people in your service (${d.active} under way): steps overdue, pathways suggested by an entry, and pathways ready to complete.`),
    section('Steps overdue', d.overdue, 'No steps overdue.'),
    section('Suggested', d.suggested, 'None suggested.'),
    section('Ready to complete', d.ready, 'None ready.'),
  );
}
