import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Interventions: considered → planned → authorised where needed → done, with the response → reviewed → continued, changed or stopped.
const TONE = { CONSIDERED: 'muted', AWAITING_AUTHORISATION: 'warn', ACTIVE: 'ok', DECLINED: 'muted', CEASED: 'muted', ENTERED_IN_ERROR: 'muted' };

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

// How often: a choice, and the hours when it is every few hours.
function howOften(o, current) {
  const frequency = select(Object.entries(o.frequencies), 'How often');
  const hours = h('input', { type: 'number', min: 1, max: 12, 'aria-label': 'Hours apart', placeholder: 'e.g. 2' });
  const hoursField = field('Hours apart', hours);
  const sync = () => { hoursField.hidden = frequency.value !== 'HOURS'; };
  frequency.addEventListener('change', sync);
  if (current) { frequency.value = current.frequency; hours.value = current.everyHours ?? ''; }
  sync();
  return { el: h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How often', frequency), hoursField), frequency, hours };
}

function planDialog(personId, o, reload) {
  const category = select(o.categories.map((c) => [c.id, c.label + (c.authorise ? ' (needs a doctor to authorise)' : '')]), 'Kind');
  const what = h('input', { type: 'text', 'aria-label': 'What', placeholder: 'e.g. Deep breathing and coughing exercises, 10 breaths' });
  const forId = select(o.purposes.map((p) => [p.id, p.label]), 'What it is for', o.purposes.length ? 'Something else (write it below)' : 'Write it below');
  const purpose = h('input', { type: 'text', 'aria-label': 'Reason', placeholder: 'e.g. Prevent pressure injury' });
  const often = howOften(o);
  const review = h('input', { type: 'date', 'aria-label': 'Review by', min: today() });
  const consider = h('input', { type: 'checkbox', 'aria-label': 'Only considering it' });
  dialog('Plan an intervention', h('div', { class: 'stack' },
    field('What kind', category), field('Exactly what is to be done', what),
    field('What it is for', forId), field('Reason (if not one of the above)', purpose),
    often.el, field('Review by (optional)', review),
    h('label', { class: 'row small' }, consider, 'Only considering it for now'),
  ), 'Plan', async () => {
    await post(`/api/work/patients/${personId}/interventions`, {
      category: category.value, what: what.value, forId: forId.value, purpose: purpose.value, frequency: often.frequency.value, everyHours: often.hours.value,
      reviewDue: review.value, considerOnly: consider.checked,
    });
    toast('Planned.');
    reload();
  });
}

function deliverDialog(x, reload) {
  let done = true;
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. 10 breaths and two good coughs' });
  const response = h('input', { type: 'text', 'aria-label': 'How they responded', placeholder: 'e.g. Coughed up green sputum; sats 95% after' });
  dialog(x.what, h('div', { class: 'stack' },
    h('fieldset', { class: 'row' }, h('legend', {}, 'Was it done?'),
      h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name: 'done', checked: true, onchange: () => { done = true; } }), 'Done'),
      h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name: 'done', value: 'no', onchange: () => { done = false; } }), 'Not done')),
    field('Note (why, if not done)', note), field('How they responded', response),
  ), 'Save', async () => {
    await post(`/api/work/interventions/${x.id}/deliver`, { done, note: note.value, response: response.value });
    reload();
  });
}

function reviewDialog(x, o, reload) {
  const outcome = select(Object.entries(o.review), 'Decision');
  const note = h('textarea', { 'aria-label': 'Response', placeholder: 'How they have responded, e.g. Sputum clearing, chest sounds better' });
  const what = h('input', { type: 'text', 'aria-label': 'Changed to', value: x.what });
  const often = howOften(o, x);
  const change = h('div', { class: 'stack', hidden: true }, field('Change it to', what), often.el);
  outcome.addEventListener('change', () => { change.hidden = outcome.value !== 'MODIFY'; });
  const review = h('input', { type: 'date', 'aria-label': 'Next review', min: today() });
  dialog(`Review: ${x.what}`, h('div', { class: 'stack' },
    field('How they have responded', note), field('Decision', outcome), change, field('Next review (optional)', review),
    x.needsAuthorisation ? h('p', { class: 'small muted' }, 'Changing what is done needs a doctor to authorise it again.') : null,
  ), 'Save', async () => {
    await post(`/api/work/interventions/${x.id}/review`, { outcome: outcome.value, note: note.value, what: what.value, frequency: often.frequency.value, everyHours: often.hours.value, reviewDue: review.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  plan: ['Go ahead with it', 'Note', 'Optional', 'Go ahead', 0],
  authorise: ['Authorise', 'Note', 'Optional, e.g. Remove after 48 hours if passing urine', 'Authorise', 0],
  decline: ['Do not authorise', 'Why, and what to do instead', 'e.g. Try a bladder scan and timed toileting first', 'Do not authorise', 1],
  cease: ['Not going ahead', 'Why', 'e.g. No longer needed', 'Save', 1],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error', 1],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.what}`, field(label, note), button, async () => {
    await post(`/api/work/interventions/${x.id}/${action}`, { note: note.value });
    reload();
  });
}

const LABELS = { plan: 'Go ahead', authorise: 'Authorise', decline: 'Do not authorise', deliver: 'Record it', review: 'Review', cease: 'Not going ahead', error: 'Entered in error' };

function interventionCard(x, d, reload) {
  const handler = (a) => () => (a === 'deliver' ? deliverDialog(x, reload) : a === 'review' ? reviewDialog(x, d.options, reload) : noteDialog(x, a, reload));
  const primary = x.state === 'AWAITING_AUTHORISATION' ? 'authorise' : x.state === 'ACTIVE' ? (x.reviewOverdue && !x.dueNow ? 'review' : 'deliver') : 'plan';
  const last = x.deliveries[0];
  return h('div', { class: `tile stack intervention intervention-${x.state.toLowerCase()}${x.dueNow ? ' intervention-due' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, x.what),
      h('span', { class: `tag ${x.dueNow ? 'danger' : TONE[x.state]}` }, x.dueNow ? 'Due now' : x.stateLabel)),
    h('div', { class: 'small muted' }, [x.categoryLabel, x.frequencyLabel, x.forLabel ?? x.purpose, `planned by ${x.plannedBy}`].filter(Boolean).join(' · ')),
    x.state === 'AWAITING_AUTHORISATION' ? h('div', { class: 'notice small' }, 'Waiting for a doctor to authorise it before it starts.') : null,
    x.authorisedBy ? h('div', { class: 'small' }, `${x.state === 'DECLINED' ? 'Not authorised' : 'Authorised'} by ${x.authorisedBy} ${fmtDateTime(x.authorisedAt)}${x.authNote ? `: ${x.authNote}` : ''}`) : null,
    x.state === 'ACTIVE' ? h('div', { class: 'small' }, [
      x.nextDue ? `Next due ${fmtDateTime(x.nextDue)}` : x.frequency === 'AS_NEEDED' ? 'When needed' : 'Done',
      last ? `last ${last.done ? 'done' : 'not done'} ${fmtDateTime(last.at)} by ${last.by}` : 'not done yet',
      x.reviewDue ? `review by ${x.reviewDue}${x.reviewOverdue ? ' (due)' : ''}` : null,
    ].filter(Boolean).join(' · ')) : null,
    last?.response ? h('div', { class: 'small' }, h('b', {}, 'Last response: '), last.response) : null,
    x.ceaseNote ? h('div', { class: 'small muted' }, `${x.stateLabel} ${fmtDateTime(x.ceasedAt)} by ${x.ceasedBy}: ${x.ceaseNote}`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === primary ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Interventions view in the Live Workstation.
export function interventionsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canPlan ? h('div', {}, h('button', { class: 'btn primary', onclick: () => planDialog(personId, d.options, reload) }, 'Plan an intervention')) : null,
    d.open.length ? d.open.map((x) => interventionCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No interventions planned.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Stopped or not authorised (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => interventionCard(x, d, reload)))) : null,
  );
}

function row(x) {
  return h('div', { class: `tile stack intervention-${x.state.toLowerCase()}${x.dueNow ? ' intervention-due' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/interventions`) }, h('b', {}, x.patient)),
        x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null),
      h('span', { class: `tag ${x.dueNow ? 'danger' : TONE[x.state]}` }, x.dueNow ? 'Due now' : x.stateLabel)),
    h('div', {}, h('b', {}, x.what)),
    h('div', { class: 'small muted' }, [x.frequencyLabel, x.forLabel ?? x.purpose, x.nextDue ? `due ${fmtDateTime(x.nextDue)}` : null, x.reviewOverdue ? `review due ${x.reviewDue}` : null].filter(Boolean).join(' · ')),
  );
}

// Home → Interventions.
export async function interventionsView() {
  const d = await get('/api/work/interventions');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Interventions', () => go('/work/home')),
    h('div', { class: 'banner' }, `Interventions for people in your service (${d.active} under way): what is due now, what is waiting for a doctor to authorise, and reviews due.`),
    section('Due now', d.due, 'Nothing due now.'),
    section('Waiting for authorisation', d.toAuthorise, 'Nothing waiting.'),
    section('Reviews due', d.reviews, 'None due.'),
    d.considered.length ? section('Being considered', d.considered, '') : null,
  );
}
