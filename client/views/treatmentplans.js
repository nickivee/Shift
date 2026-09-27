import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Treatment plans: need → options → agreed plan → components and responsible services → under way → how it is going → review → changed, completed or stopped.
const TONE = { DRAFT: 'muted', AWAITING_AGREEMENT: 'warn', AGREED: 'warn', ACTIVE: 'ok', COMPLETED: 'muted', STOPPED: 'muted', ENTERED_IN_ERROR: 'muted' };
const PROGRESS_TONE = { ON_TRACK: 'ok', SLOWER: 'warn', NOT_WORKING: 'danger' };

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
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const send = (t, action, body) => post(`/api/work/treatment-plans/${t.id}/${action}`, body);

function createDialog(personId, o, reload) {
  const problem = select(o.problems.map((p) => [p.id, p.title]), 'Problem', o.problems.length ? 'Something else (describe it below)' : 'Describe it below');
  const need = h('input', { type: 'text', 'aria-label': 'Need', placeholder: 'e.g. Low mood since her husband died' });
  const goal = h('input', { type: 'text', 'aria-label': 'Goal', placeholder: 'e.g. Chest clear and home by Friday' });
  dialog('Start a treatment plan', h('div', { class: 'stack' },
    field('What needs treating', problem), field('Or describe the need', need), field('Goal the person and team are aiming for', goal),
    h('p', { class: 'small muted' }, 'Next, add the options you are weighing up, with their benefits and risks.'),
  ), 'Start', async () => {
    await post(`/api/work/patients/${personId}/treatment-plans`, { problemId: problem.value, need: need.value, goal: goal.value });
    toast('Treatment plan started.');
    reload();
  });
}

function optionDialog(t, reload) {
  const what = h('input', { type: 'text', 'aria-label': 'Option', placeholder: 'e.g. Oral antibiotics and chest physiotherapy' });
  const benefits = h('input', { type: 'text', 'aria-label': 'Benefits', placeholder: 'e.g. Can stay mobile; no drip' });
  const risks = h('input', { type: 'text', 'aria-label': 'Risks', placeholder: 'e.g. Slower if the infection is resistant' });
  dialog('Add an option', h('div', { class: 'stack' }, field('Option', what), field('Benefits', benefits), field('Risks', risks)), 'Add', async () => {
    await send(t, 'option', { what: what.value, benefits: benefits.value, risks: risks.value });
    reload();
  });
}

const optionChoice = (t, label) => select(t.options.map((x) => [x.id, x.what]), label);

function proposeDialog(t, reload) {
  const option = optionChoice(t, 'Option');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Peggy would like to try this first' });
  dialog('Propose an option', h('div', { class: 'stack' }, field('Option', option), field('Note', note),
    h('p', { class: 'small muted' }, 'A doctor or physiotherapist then agrees it with the person.')), 'Propose', async () => {
    await send(t, 'propose', { optionId: option.value, note: note.value });
    reload();
  });
}

function agreeDialog(t, o, reload) {
  const option = optionChoice(t, 'Option');
  if (t.proposed) option.value = t.proposed.id;
  const agreedWith = select(Object.entries(o.agreedWith), 'Agreed with');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Explained both options; Aroha prefers tablets' });
  dialog('Agree the plan', h('div', { class: 'stack' },
    field('Option agreed', option), field('Agreed with', agreedWith), field('Note (why, if they cannot agree themselves)', note),
  ), 'Agree', async () => {
    await send(t, 'agree', { optionId: option.value, agreedWith: agreedWith.value, note: note.value });
    toast('Agreed.');
    reload();
  });
}

function componentDialog(t, o, reload) {
  const kind = select(Object.entries(o.components), 'Kind');
  const intervention = select(o.interventions.map((i) => [i.id, i.what]), 'Intervention', 'A new one (describe it below)');
  const interventionField = field('Which intervention', intervention);
  const what = h('input', { type: 'text', 'aria-label': 'What', placeholder: 'e.g. Chest physiotherapy twice a day' });
  const service = select(o.services.map((s) => [s.id, s.name]), 'Responsible service');
  const sync = () => { interventionField.hidden = kind.value !== 'INTERVENTION' || !o.interventions.length; };
  kind.addEventListener('change', sync);
  sync();
  dialog('Add to the plan', h('div', { class: 'stack' },
    field('What kind', kind), interventionField, field('What will be done', what), field('Responsible service', service),
  ), 'Add', async () => {
    await send(t, 'component', { kind: kind.value, interventionId: kind.value === 'INTERVENTION' ? intervention.value : '', what: what.value, serviceId: service.value });
    reload();
  });
}

function componentStateDialog(t, c, o, reload) {
  const to = select(Object.entries(o.componentStates).filter(([k]) => k !== c.state && k !== 'PLANNED'), 'Now');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Why, if stopped' });
  dialog(c.what, h('div', { class: 'stack' }, field('What has happened', to), field('Note', note)), 'Save', async () => {
    await send(t, 'component-state', { componentId: c.id, state: to.value, note: note.value });
    reload();
  });
}

function startDialog(t, reload) {
  const review = h('input', { type: 'date', 'aria-label': 'Review by', min: today() });
  dialog('Start the plan', h('div', { class: 'stack' }, field('Review by', review),
    h('p', { class: 'small muted' }, 'Everything planned is marked under way.')), 'Start', async () => {
    await send(t, 'start', { reviewDue: review.value });
    reload();
  });
}

function progressDialog(t, o, reload) {
  const progress = select(Object.entries(o.progress), 'How it is going');
  const note = h('textarea', { 'aria-label': 'What you have seen', placeholder: 'e.g. Walked to the bathroom with a frame; less breathless' });
  dialog('How is it going?', h('div', { class: 'stack' }, field('How it is going', progress), field('What you have seen', note)), 'Save', async () => {
    await send(t, 'progress', { progress: progress.value, note: note.value });
    reload();
  });
}

function reviewDialog(t, o, reload) {
  const outcome = select(Object.entries(o.review), 'Decision');
  const note = h('textarea', { 'aria-label': 'Progress towards the goal', placeholder: 'e.g. Off oxygen; walking the corridor' });
  const goal = h('input', { type: 'text', 'aria-label': 'Goal', value: t.goal });
  const option = select(t.options.map((x) => [x.id, x.what]), 'Approach', null);
  if (t.chosen) option.value = t.chosen.id;
  const change = h('div', { class: 'stack', hidden: true }, field('Goal', goal), field('Approach', option),
    h('p', { class: 'small muted' }, 'Choosing a different approach needs agreeing again.'));
  const review = h('input', { type: 'date', 'aria-label': 'Next review', min: today() });
  const reviewField = field('Next review', review);
  const sync = () => { change.hidden = outcome.value !== 'MODIFY'; reviewField.hidden = ['COMPLETE', 'STOP'].includes(outcome.value); };
  outcome.addEventListener('change', sync);
  dialog('Review the plan', h('div', { class: 'stack' },
    field('Progress towards the goal', note), field('Decision', outcome), change, reviewField,
  ), 'Save', async () => {
    await send(t, 'review', { outcome: outcome.value, note: note.value, goal: goal.value, optionId: option.value, reviewDue: review.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  'not-agreed': ['Not agreed', 'Why, and what to consider instead', 'e.g. Wants to talk it over with her son first', 'Save'],
  stop: ['Not going ahead', 'Why', 'e.g. No longer needed', 'Save'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(t, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => {
    await send(t, action, { note: note.value });
    reload();
  });
}

const LABELS = {
  option: 'Add an option', propose: 'Propose', agree: 'Agree the plan', 'not-agreed': 'Not agreed', component: 'Add to the plan', start: 'Start',
  progress: 'How is it going?', review: 'Review', stop: 'Not going ahead', error: 'Entered in error',
};

function planCard(t, d, reload) {
  const o = d.options;
  const handler = (a) => () => ({
    option: () => optionDialog(t, reload), propose: () => proposeDialog(t, reload), agree: () => agreeDialog(t, o, reload), component: () => componentDialog(t, o, reload),
    start: () => startDialog(t, reload), progress: () => progressDialog(t, o, reload), review: () => reviewDialog(t, o, reload),
  }[a] ?? (() => noteDialog(t, a, reload)))();
  const primary = { DRAFT: t.options.length ? 'propose' : 'option', AWAITING_AGREEMENT: 'agree', AGREED: 'start', ACTIVE: t.reviewOverdue ? 'review' : 'progress' }[t.state];
  const latest = t.latestProgress;
  return h('div', { class: `tile stack treatment treatment-${t.state.toLowerCase()}${t.offTrack ? ' treatment-off' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, t.problemTitle ?? t.need),
      h('span', { class: `tag ${TONE[t.state]}` }, t.stateLabel)),
    h('div', {}, h('b', {}, 'Goal: '), t.goal),
    h('div', { class: 'small muted' }, [`started by ${t.createdBy} ${fmtDateTime(t.createdAt)}`, t.version > 1 ? `version ${t.version}` : null, t.serviceName].filter(Boolean).join(' · ')),
    t.state === 'AWAITING_AGREEMENT' ? h('div', { class: 'notice small' }, `Waiting for a doctor or physiotherapist to agree${t.proposed ? `: ${t.proposed.what}` : ''}.`) : null,
    t.authorisedBy ? h('div', { class: 'small' }, `Agreed by ${t.authorisedBy} ${fmtDateTime(t.authorisedAt)} with ${t.agreedWithLabel.toLowerCase()}${t.agreementNote ? `: ${t.agreementNote}` : ''}`) : null,
    t.options.length ? h('div', { class: 'stack' }, h('b', { class: 'small' }, 'Options'),
      h('ul', { class: 'treatment-options' }, t.options.map((x) => h('li', { class: x.chosen ? 'chosen' : x.proposed ? 'proposed' : '' },
        h('div', {}, x.what, x.chosen ? h('span', { class: 'tag ok' }, 'Agreed') : x.proposed ? h('span', { class: 'tag warn' }, 'Proposed') : null),
        x.benefits || x.risks ? h('div', { class: 'small muted' }, [x.benefits ? `Benefits: ${x.benefits}` : '', x.risks ? `Risks: ${x.risks}` : ''].filter(Boolean).join(' · ')) : null)))) : null,
    t.components.length ? h('div', { class: 'stack' }, h('b', { class: 'small' }, 'What will be done'),
      h('ul', { class: 'treatment-components' }, t.components.map((c) => h('li', {},
        h('div', { class: 'spread' },
          h('span', {}, h('span', { class: 'small muted' }, `${c.kindLabel}: `), c.what),
          d.canRecord && t.canUpdateComponents && ['PLANNED', 'UNDER_WAY'].includes(c.state)
            ? h('button', { class: 'btn small', onclick: () => componentStateDialog(t, c, o, reload) }, c.stateLabel)
            : h('span', { class: 'tag muted' }, c.stateLabel)),
        h('div', { class: 'small muted' }, `Responsible: ${c.serviceName}${c.note ? ` · ${c.note}` : ''}`))))) : null,
    t.state === 'ACTIVE' ? h('div', { class: 'small' }, [
      latest ? null : 'No progress recorded yet',
      t.reviewDue ? `Review by ${t.reviewDue}${t.reviewOverdue ? ' (due)' : ''}` : null,
    ].filter(Boolean).join(' · ')) : null,
    latest ? h('div', { class: 'small' }, h('span', { class: `tag ${PROGRESS_TONE[latest.progress]}` }, latest.progressLabel), ` ${latest.note} (${latest.by}, ${fmtDateTime(latest.at)})`) : null,
    t.endNote ? h('div', { class: 'small muted' }, `${t.stateLabel} ${fmtDateTime(t.endedAt)} by ${t.endedBy}: ${t.endNote}`) : null,
    t.actions.length ? h('div', { class: 'row' }, t.actions.map((a) => h('button', { class: `btn small${a === primary ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${t.steps.length})`),
      h('ol', { class: 'det-steps' }, t.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Treatment plans view in the Live Workstation.
export function treatmentPlansPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canPlan ? h('div', {}, h('button', { class: 'btn primary', onclick: () => createDialog(personId, d.options, reload) }, 'Start a treatment plan')) : null,
    d.open.length ? d.open.map((t) => planCard(t, d, reload)) : h('div', { class: 'card empty' }, 'No treatment plans.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Completed or stopped (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((t) => planCard(t, d, reload)))) : null,
  );
}

function row(t) {
  const latest = t.latestProgress;
  return h('div', { class: `tile stack treatment-${t.state.toLowerCase()}${t.offTrack ? ' treatment-off' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${t.personId}/treatmentplans`) }, h('b', {}, t.patient)),
        t.location ? h('span', { class: 'small muted' }, ` · ${t.location}`) : null),
      h('span', { class: `tag ${TONE[t.state]}` }, t.stateLabel)),
    h('div', {}, h('b', {}, t.problemTitle ?? t.need), ` · ${t.goal}`),
    h('div', { class: 'small muted' }, [
      t.proposed && t.state === 'AWAITING_AGREEMENT' ? `Proposed: ${t.proposed.what}` : null,
      latest && t.state === 'ACTIVE' ? `${latest.progressLabel}: ${latest.note}` : null,
      t.reviewOverdue ? `review due ${t.reviewDue}` : null,
    ].filter(Boolean).join(' · ')),
  );
}

// Home → Treatment plans.
export async function treatmentPlansView() {
  const d = await get('/api/work/treatment-plans');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Treatment plans', () => go('/work/home')),
    h('div', { class: 'banner' }, `Treatment plans for people in your service (${d.active} under way): plans waiting to be agreed, plans not going to plan, and reviews due.`),
    section('Waiting for agreement', d.toAgree, 'Nothing waiting.'),
    !d.canAuthorise && d.toAgree.length ? h('p', { class: 'small muted' }, 'A doctor or physiotherapist agrees treatment plans; your workstation cannot.') : null,
    section('Not going to plan', d.offTrack, 'Everything under way is going to plan.'),
    section('Reviews due', d.reviews, 'None due.'),
    d.notStarted.length ? section('Not started yet', d.notStarted, '') : null,
  );
}
