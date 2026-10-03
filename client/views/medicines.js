import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Medicines: an authorised prescriber writes the order → a nurse gives each dose, or records why it
// was not given and who was told → the prescriber holds, resumes or stops it. A controlled drug is
// entered in the ward's book in the same step it is given. A medicine is given only as prescribed;
// SHIFT suggests no medicine, dose or rate.
const LABEL = { give: 'Give a dose', notgiven: 'Not given', hold: 'Hold', resume: 'Resume', stop: 'Stop' };
const time = (s) => new Date(s).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false });
const check = (el, text) => h('label', { class: 'check' }, el, ` ${text}`);

function prescribeDialog(personId, s, reload) {
  const medicine = h('input', { 'aria-label': 'Medicine', placeholder: 'Generic name in full, e.g. PARACETAMOL', autocapitalize: 'characters' });
  const dose = h('input', { 'aria-label': 'Dose', placeholder: 'e.g. 500 mg' });
  const route = h('input', { 'aria-label': 'Route', placeholder: 'e.g. Oral' });
  const frequency = h('input', { 'aria-label': 'How often', placeholder: 'e.g. Twice daily' });
  const indication = h('input', { 'aria-label': 'What it is for', placeholder: 'e.g. Pain' });
  const prn = h('input', { type: 'checkbox' });
  const prnWhy = h('input', { 'aria-label': 'As needed for', placeholder: 'e.g. Pain not eased by rest' });
  const minH = h('input', { type: 'number', step: '0.5', min: '0.5', 'aria-label': 'Hours between doses', placeholder: 'e.g. 4' });
  const max24 = h('input', { type: 'number', min: '1', 'aria-label': 'Most doses in 24 hours', placeholder: 'e.g. 4' });
  const prnBox = h('div', { class: 'stack', hidden: true }, field('Why it may be given', prnWhy), h('div', { class: 'row' }, field('At least this many hours apart', minH), field('At most this many doses in 24 hours', max24)));
  prn.addEventListener('change', () => { prnBox.hidden = !prn.checked; });
  const controlled = h('input', { type: 'checkbox' });
  const override = h('input', { 'aria-label': 'Why prescribed despite the recorded allergy', placeholder: 'Only if SHIFT says they have a recorded allergy to it' });
  const a = s.allergies;
  dialog('Prescribe a medicine', h('div', { class: 'stack' },
    h('p', { class: `small ${a.status === 'RECORDED' ? '' : 'muted'}` }, a.status === 'RECORDED'
      ? `Recorded allergies: ${a.items.map((x) => `${x.substance}${x.reaction ? ` (${x.reaction})` : ''}`).join(', ')}.`
      : a.status === 'NONE_KNOWN' ? 'No known allergies recorded.' : 'No allergy status is recorded yet. Record it in the Allergies screen first.'),
    field('Medicine', medicine), h('div', { class: 'row' }, field('Dose', dose), field('Route', route)), field('How often', frequency), field('What it is for', indication),
    check(prn, 'Only when needed (as needed)'), prnBox, check(controlled, 'Controlled drug'), field('If there is an allergy to it, why prescribe it', override),
    h('p', { class: 'small muted' }, 'You write the order. SHIFT suggests no medicine, dose or rate. The name is kept in capitals, as the national chart asks.')), 'Save', async () => {
    await post(`/api/work/patients/${personId}/medicines`, { medicine: medicine.value, dose: dose.value, route: route.value, frequency: frequency.value, indication: indication.value,
      prn: prn.checked ? 'yes' : '', prnIndication: prnWhy.value, prnMinHours: minH.value, prnMax24h: max24.value, controlled: controlled.checked ? 'yes' : '', override: override.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function giveDialog(m, s, reload) {
  const dose = h('input', { 'aria-label': 'Dose given', value: m.dose });
  const ago = h('input', { type: 'number', min: '0', max: '1440', value: '0', 'aria-label': 'Minutes ago' });
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Optional' });
  const pageSel = select(s.pages.map((p) => [p.id, `${p.drug} (book shows ${p.balance} ${p.unit})`]), 'Page of the ward book', 'Choose the page…');
  const qty = h('input', { type: 'number', step: 'any', min: '0', 'aria-label': 'Amount used from the book', placeholder: 'Amount used' });
  const witness = select(s.witnesses.map((w) => [w.id, w.name]), 'Witness', 'No witness');
  const book = m.controlled ? h('div', { class: 'stack' },
    h('p', { class: 'small' }, h('b', {}, 'Controlled drug. '), 'It is entered in this ward\'s book now, as you give it.'),
    field('Page of the ward book', pageSel), field('Amount used from the book', qty), field('Witness, if your service uses one', witness)) : null;
  dialog(`Give ${m.medicine}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, `Ordered: ${m.dose}, ${m.route}, ${m.frequency.toLowerCase()}. For ${m.indication}.`),
    m.prn ? h('p', { class: 'small' }, `As needed for ${m.prnIndication}: at least ${m.prnMinHours} hours apart, at most ${m.prnMax24h} in 24 hours.${m.prnNow?.last ? ` Last given ${time(m.prnNow.last)}; ${m.prnNow.count24} in the last 24 hours.` : ''}`) : null,
    field('Dose given', dose), field('Given how many minutes ago (0 for now)', ago), book, field('Note (optional)', note)), 'Save', async () => {
    await post(`/api/work/medicines/${m.id}/give`, { doseGiven: dose.value, minutesAgo: ago.value, note: note.value, pageId: pageSel.value, qty: qty.value, witness: witness.value });
    toast('Recorded.');
    reload();
  }, { wide: true });
}

function notGivenDialog(m, s, reload) {
  const reason = select(Object.entries(s.options.notGiven), 'Why it was not given');
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Write the reason if "Another reason"' });
  const told = h('input', { 'aria-label': 'Who you told', placeholder: 'e.g. Dr Li' });
  dialog(`${m.medicine} not given`, h('div', { class: 'stack' }, field('Why it was not given', reason), field('Note', note),
    field('Who you told (the prescriber is told when a dose is not given)', told)), 'Save', async () => {
    await post(`/api/work/medicines/${m.id}/notgiven`, { reason: reason.value, note: note.value, told: told.value });
    toast('Recorded.');
    reload();
  });
}

function whyDialog(m, action, reload) {
  const note = h('textarea', { 'aria-label': 'Why' });
  dialog(`${LABEL[action]} ${m.medicine}`, field('Why', note), 'Save', async () => {
    await post(`/api/work/medicines/${m.id}/${action}`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function dose(d) {
  return h('div', { class: `small${d.kind === 'NOT_GIVEN' ? ' muted' : ''}` },
    h('b', {}, d.kind === 'GIVEN' ? `Given ${d.dose}` : `Not given: ${d.reasonLabel?.toLowerCase() ?? ''}`), ` · ${fmtDateTime(d.givenAt)} · ${d.by}`,
    d.witness ? ` · witnessed by ${d.witness}` : '', d.told ? ` · told ${d.told}` : '', d.note ? ` · ${d.note}` : '');
}

function card(m, s, reload) {
  const live = m.state === 'ACTIVE';
  const warn = m.allergy.length;
  return h('div', { class: `tile stack${warn ? ' overdue' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, `${m.medicine} ${m.dose}`),
      h('span', { class: 'row' }, m.controlled ? h('span', { class: 'tag warn' }, 'Controlled drug') : null, m.prn ? h('span', { class: 'tag' }, 'As needed') : null,
        h('span', { class: `tag${live ? ' ok' : m.state === 'HELD' ? ' warn' : ''}` }, m.stateLabel))),
    h('div', { class: 'small' }, `${m.route} · ${m.frequency} · for ${m.indication} · ${m.prescriber ?? 'prescriber not recorded'}${m.startedAt ? `, ${fmtDateTime(m.startedAt)}` : ''}`),
    m.prn ? h('div', { class: 'small' }, `As needed for ${m.prnIndication}: at least ${m.prnMinHours} hours apart, at most ${m.prnMax24h} in 24 hours.`,
      m.prnNow ? ` ${m.prnNow.count24} given in the last 24 hours.` : '',
      m.prnNow?.tooSoon ? h('b', {}, ` Next dose not before ${time(m.prnNow.nextAt)}.`) : '', m.prnNow?.atMax ? h('b', {}, ' The 24-hour limit is reached.') : null) : null,
    warn ? h('div', { class: 'small notice' }, `Recorded ${String(m.allergy[0].kind).toLowerCase()} to ${m.allergy[0].substance}${m.allergyOverride ? `. The prescriber wrote: ${m.allergyOverride}` : '. The prescriber has not written why it is given.'}`) : null,
    m.stopNote ? h('div', { class: 'small' }, h('b', {}, 'Stopped: '), m.stopNote) : null,
    m.doses.length ? h('div', { class: 'stack' }, m.doses.slice(0, 3).map(dose)) : h('div', { class: 'small muted' }, 'No doses recorded in SHIFT yet.'),
    m.acts.length ? h('div', { class: 'row' }, m.acts.map((a) => h('button', { class: `btn small${a === 'give' ? ' primary' : ''}`,
      onclick: () => (a === 'give' ? giveDialog(m, s, reload) : a === 'notgiven' ? notGivenDialog(m, s, reload) : whyDialog(m, a, reload)) }, LABEL[a]))) : null,
    m.steps.length ? h('details', {}, h('summary', { class: 'small' }, `History (${m.steps.length})`),
      h('ol', { class: 'det-steps' }, m.steps.map((x) => h('li', { class: 'det-step' }, h('div', { class: 'small muted' }, `${x.by} · ${fmtDateTime(x.at)}`), h('div', { class: 'small' }, x.body))))) : null,
  );
}

export function medicinesPanel(personId, s, reload) {
  const a = s.allergies;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Medicines'),
      s.canPrescribe ? h('button', { class: 'btn small', onclick: () => prescribeDialog(personId, s, reload) }, 'Prescribe') : null),
    h('div', { class: `small${a.status === 'NOT_RECORDED' ? ' notice' : ' muted'}` }, a.status === 'RECORDED'
      ? `Allergies: ${a.items.map((x) => `${x.substance}${x.reaction ? ` (${x.reaction})` : ''}`).join(', ')}`
      : a.status === 'NONE_KNOWN' ? 'No known allergies recorded.' : 'No allergy status is recorded. Record it in the Allergies screen.'),
    s.current.length ? s.current.map((m) => card(m, s, reload)) : h('div', { class: 'empty' }, 'No medicines ordered.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Stopped (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((m) => card(m, s, reload)))) : null,
  );
}
