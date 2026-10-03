import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime, fmtDate } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Eligibility: each check of whether someone is eligible for publicly funded services, as the checker records it.
const TONE = { ELIGIBLE: 'ok', NOT_ELIGIBLE: 'danger', UNCONFIRMED: 'warn' };

function recordDialog(personId, o, reload) {
  const outcome = select([['', 'Choose…'], ...o.outcomes.map((c) => [c.code, c.label])], 'Outcome');
  const on = h('input', { type: 'date', 'aria-label': 'Date checked' });
  const basis = h('input', { type: 'text', 'aria-label': 'What it is based on', placeholder: 'e.g. Says they are a New Zealand citizen' });
  const evidence = h('input', { type: 'text', 'aria-label': 'What was seen', placeholder: 'e.g. Passport seen' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed if not yet confirmed: what is still needed' });
  dialog('Record an eligibility check', h('div', { class: 'stack' }, field('Outcome', outcome), field('Date checked', on), field('What it is based on', basis),
    field('What was seen (needed unless not yet confirmed)', evidence), field('Note', note)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/eligibility`, { outcome: outcome.value, checkedOn: on.value, basis: basis.value, evidence: evidence.value, note: note.value });
    toast('Eligibility check recorded.');
    reload();
  });
}

function errorDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Recorded on the wrong person' });
  dialog('Entered in error', field('Why', note), 'Mark as error', async () => { await post(`/api/work/eligibility/${x.id}/error`, { note: note.value }); reload(); });
}

function card(x, reload, current) {
  return h('div', { class: `tile stack eligibility eligibility-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, current ? 'Current check' : fmtDate(x.checkedOn)),
      h('span', { class: `tag ${x.state === 'ENTERED_IN_ERROR' ? 'muted' : TONE[x.outcome]}` }, x.state === 'ENTERED_IN_ERROR' ? x.stateLabel : x.outcomeLabel)),
    h('div', { class: 'small' }, h('b', {}, `Checked ${fmtDate(x.checkedOn)}`), ` · based on: ${x.basis}`),
    x.evidence ? h('div', { class: 'small' }, `Seen: ${x.evidence}`) : null,
    x.note ? h('div', { class: 'small' }, x.note) : null,
    h('div', { class: 'small muted' }, `Recorded by ${x.recordedBy}, ${fmtDateTime(x.recordedAt)}`),
    x.closedNote ? h('div', { class: 'small' }, h('b', {}, `Entered in error (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), x.closedNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => errorDialog(x, reload) }, 'Entered in error')) : null,
  );
}

// The person's Eligibility view in the Live Workstation.
export function eligibilityPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d.options, reload) }, 'Record an eligibility check')) : null,
    h('div', { class: 'small muted' }, d.sourceNote),
    d.current ? card(d.current, reload, true) : h('div', { class: 'card empty' }, 'No eligibility check recorded here.'),
    d.earlier.length ? h('details', {}, h('summary', {}, `Earlier checks (${d.earlier.length})`), h('div', { class: 'stack' }, d.earlier.map((x) => card(x, reload, false)))) : null,
  );
}
