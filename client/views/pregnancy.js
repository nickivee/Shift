import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Pregnancy: booked and antenatal → in labour → baby born → postnatal → care ended. What the clinician enters is what is recorded.
const TONE = { ANTENATAL: 'ok', LABOUR: 'warn', BIRTHED: 'warn', POSTNATAL: 'ok', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };
const send = (x, action, body) => post(`/api/work/pregnancy/${x.id}/${action}`, body);

function bookDialog(personId, reload) {
  const due = h('input', { type: 'date', 'aria-label': 'Due date' });
  const basis = h('input', { type: 'text', 'aria-label': 'How it was worked out', placeholder: 'e.g. Dating scan at 12 weeks' });
  const gravida = h('input', { type: 'number', min: '1', 'aria-label': 'Pregnancies, this one included' });
  const parity = h('input', { type: 'number', min: '0', 'aria-label': 'Births before' });
  const considerations = h('textarea', { 'aria-label': 'Things the team should know', placeholder: 'Optional, in your own words' });
  dialog('Book a pregnancy', h('div', { class: 'stack' }, field('Due date', due), field('How it was worked out', basis), field('Pregnancies, this one included', gravida), field('Births before', parity), field('Things the team should know', considerations)),
    'Save', async () => {
      await post(`/api/work/patients/${personId}/pregnancy`, { dueDate: due.value, dueBasis: basis.value, gravida: gravida.value, parity: parity.value, considerations: considerations.value });
      toast('Pregnancy booked.');
      reload();
    });
}

const NOTE = {
  contact: ['Contact', 'What happened', 'e.g. 28 week visit: bp and fundal height checked, baby active, plan unchanged', 'Save'],
  labour: ['Labour started', 'Note', 'Optional, e.g. Waters broke at home, contractions 5 minutes apart', 'Start labour'],
  postnatal: ['Postnatal care', 'Note', 'Optional, e.g. Mother and baby settled on the ward', 'Start postnatal care'],
  close: ['End care', 'Why or how care ended', 'e.g. Handed to the Well Child provider and her GP', 'End care'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => { await send(x, action, { note: note.value }); reload(); });
}

function birthDialog(x, o, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When the baby was born' });
  const mode = select(o.modes.map((m) => [m.code, m.label]), 'How');
  const note = h('textarea', { 'aria-label': 'Birth note', placeholder: 'Optional, needed if the way is another way' });
  const baby = h('textarea', { 'aria-label': 'How the baby is', placeholder: 'e.g. Girl, 3.4 kg, cried at once, skin to skin' });
  dialog('Record the birth', h('div', { class: 'stack' }, field('When the baby was born', when), field('How', mode), field('Birth note', note), field('How the baby is', baby)), 'Save', async () => {
    await send(x, 'birth', { when: when.value ? new Date(when.value).toISOString() : '', mode: mode.value, note: note.value, baby: baby.value });
    reload();
  });
}

const LABELS = { contact: 'Record a contact', labour: 'Labour started', birth: 'Record the birth', postnatal: 'Start postnatal care', close: 'End care', error: 'Entered in error' };
const PRIMARY = ['labour', 'birth', 'postnatal'];

function card(x, o, reload) {
  const handler = (a) => () => (a === 'birth' ? birthDialog(x, o, reload) : noteDialog(x, a, reload));
  return h('div', { class: `tile stack pregnancy pregnancy-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, `Due ${x.dueDate}`), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Dated by: '), x.dueBasis, ` · pregnancies ${x.gravida}, births before ${x.parity}`),
    x.considerations ? h('div', { class: 'small' }, h('b', {}, 'Team should know: '), x.considerations) : null,
    x.labourAt ? h('div', { class: 'small' }, h('b', {}, 'Labour started: '), fmtDateTime(x.labourAt)) : null,
    x.birthAt ? h('div', { class: 'small' }, h('b', {}, `Born ${fmtDateTime(x.birthAt)}: `), [x.birthModeLabel, x.birthNote].filter(Boolean).join('. '), x.babyNote ? ` Baby: ${x.babyNote}` : '') : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Pregnancy view in the Live Workstation.
export function pregnancyPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canBook ? h('div', {}, h('button', { class: 'btn primary', onclick: () => bookDialog(personId, reload) }, 'Book a pregnancy')) : null,
    d.open.length ? d.open.map((x) => card(x, d.options, reload)) : h('div', { class: 'card empty' }, 'No pregnancy open.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier pregnancies (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => card(x, d.options, reload)))) : null,
  );
}
