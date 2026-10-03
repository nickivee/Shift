import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Immunisation: each vaccine given or not given, as the clinician records it. Nothing is worked out as due.
const TONE = { GIVEN: 'ok', NOT_GIVEN: 'warn', ENTERED_IN_ERROR: 'muted' };
const send = (x, action, body) => post(`/api/work/immunisation/${x.id}/${action}`, body);

function recordDialog(personId, o, reload) {
  const given = select([['yes', 'Given'], ['no', 'Not given']], 'Given or not given');
  const vaccine = select(o.vaccines.map((c) => [c.code, c.label]), 'Vaccine');
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When' });
  const dose = h('input', { type: 'text', 'aria-label': 'Dose', placeholder: 'e.g. Dose 2' });
  const site = h('input', { type: 'text', 'aria-label': 'Where it was given', placeholder: 'e.g. Left thigh' });
  const batch = h('input', { type: 'text', 'aria-label': 'Batch number', placeholder: 'From the vial' });
  const reason = select([['', 'Choose…'], ...o.reasons.map((c) => [c.code, c.label])], 'Why it was not given');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed if the vaccine is "another vaccine", or the reason is "another reason"' });
  dialog('Record a vaccine', h('div', { class: 'stack' }, field('Given or not given', given), field('Vaccine', vaccine), field('When', when),
    field('Dose (if given)', dose), field('Where it was given (if given)', site), field('Batch number (if given)', batch),
    field('Why it was not given (if not given)', reason), field('Note', note)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/immunisation`, {
      given: given.value, vaccine: vaccine.value, when: when.value ? new Date(when.value).toISOString() : '', dose: dose.value, site: site.value,
      batch: batch.value, reason: reason.value, note: note.value,
    });
    toast('Vaccine recorded.');
    reload();
  });
}

const NOTE = {
  reaction: ['Record a reaction', 'The reaction and what was done', 'e.g. Sore arm for two days; settled with paracetamol', 'Save'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => { await send(x, action, { note: note.value }); reload(); });
}
const LABELS = { reaction: 'Record a reaction', error: 'Entered in error' };

function card(x, reload) {
  return h('div', { class: `tile stack immunisation immunisation-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, x.vaccineLabel), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, fmtDateTime(x.givenAt)), x.state === 'GIVEN' ? ` · ${x.dose} · ${x.site} · batch ${x.batch}` : x.reasonLabel ? ` · ${x.reasonLabel}` : ''),
    x.note ? h('div', { class: 'small' }, x.note) : null,
    x.reaction ? h('div', { class: 'small' }, h('b', {}, 'Reaction: '), x.reaction) : null,
    h('div', { class: 'small muted' }, `Recorded by ${x.recordedBy}`),
    x.closedNote ? h('div', { class: 'small' }, h('b', {}, `Entered in error (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), x.closedNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: 'btn small', onclick: () => noteDialog(x, a, reload) }, LABELS[a]))) : null,
  );
}

// The person's Immunisation view in the Live Workstation.
export function immunisationPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    !d.ruleSet ? h('div', { class: 'banner' }, 'No list of vaccines has been set for your organisation yet, so vaccines cannot be recorded.') : null,
    d.canRecord && d.ruleSet ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d.options, reload) }, 'Record a vaccine')) : null,
    h('div', { class: 'small muted' }, 'SHIFT shows what was recorded. It does not work out what is due.'),
    d.records.length ? d.records.map((x) => card(x, reload)) : h('div', { class: 'card empty' }, 'No vaccines recorded here.'),
  );
}
