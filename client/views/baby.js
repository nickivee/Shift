import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// The baby's own record and feeding. SHIFT creates no NHI for the baby and sets no checks or feeding targets.
const TONE = { ACTIVE: 'ok', ENTERED_IN_ERROR: 'muted', GIVEN: 'ok' };

function openDialog(g, personId, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When the baby was born' });
  if (g.birthAt) { const d = new Date(g.birthAt); const p = (n) => String(n).padStart(2, '0'); when.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  const note = h('textarea', { 'aria-label': 'How the baby is', placeholder: 'e.g. Girl, 3.4 kg, cried at once, skin to skin' });
  if (g.babyNote) note.value = g.babyNote;
  const another = h('input', { type: 'checkbox', 'aria-label': 'Another baby of this birth' });
  dialog('Open the baby\'s record', h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, 'This opens a record for the baby linked to the mother, with a placeholder name and a local number. It does not create an NHI.'),
    field('When the baby was born', when), field('How the baby is', note),
    g.babies ? h('label', { class: 'row' }, another, 'This is another baby of the same birth') : null),
  'Open the record', async () => {
    await post(`/api/work/pregnancy/${g.id}/baby`, { when: when.value ? new Date(when.value).toISOString() : '', note: note.value, another: another.checked ? 'yes' : '' });
    toast('The baby\'s record is open.');
    reload();
  });
}

function errorDialog(url, label, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Recorded on the wrong baby' });
  dialog('Entered in error', field('Why', note), 'Mark as error', async () => { await post(url, { note: note.value }); reload(); });
}

function babyCard(x, reload, link) {
  return h('div', { class: `tile stack baby baby-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, x.name), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `Born ${fmtDateTime(x.bornAt)}`), ` · mother: ${x.mother}`),
    x.note ? h('div', { class: 'small' }, x.note) : null,
    h('div', { class: 'small muted' }, `Opened by ${x.openedBy}. No NHI: SHIFT does not create one for a baby.`),
    x.closedNote ? h('div', { class: 'small' }, h('b', {}, `Entered in error (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), x.closedNote) : null,
    h('div', { class: 'row' },
      link ? h('button', { class: 'btn small primary', onclick: () => go(`/work/patient/${x.personId}/baby`) }, 'Open the baby\'s record') : null,
      x.actions && x.actions.length ? h('button', { class: 'btn small', onclick: () => errorDialog(`/api/work/baby/${x.id}/error`, 'Why', reload) }, 'Entered in error') : null),
  );
}

// The Baby tab: on a baby's own record the baby's details; on a mother's record her babies and any birth that can have a record opened.
export function babyPanel(personId, d, reload) {
  if (d.baby) {
    return h('div', { class: 'stack' }, babyCard(d.baby, reload, false),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => go(`/work/patient/${d.baby.motherId}/baby`) }, `Open the mother's record (${d.baby.mother})`)));
  }
  return h('div', { class: 'stack' },
    d.openable.map((g) => h('div', { class: 'tile stack' },
      h('div', { class: 'spread' }, h('h3', {}, `Birth ${fmtDateTime(g.birthAt)}`), h('span', { class: 'tag ok' }, g.babies ? `${g.babies} baby record${g.babies > 1 ? 's' : ''} open` : 'No baby record yet')),
      d.canRecord ? h('div', {}, h('button', { class: `btn small${g.babies ? '' : ' primary'}`, onclick: () => openDialog(g, personId, reload) }, g.babies ? 'Open another baby\'s record' : 'Open the baby\'s record')) : null)),
    d.babies.length ? d.babies.map((x) => babyCard(x, reload, true)) : h('div', { class: 'card empty' }, d.openable.length ? 'No baby record yet.' : 'No baby has been born on a pregnancy in this service.'),
  );
}

function feedDialog(personId, o, reload) {
  const method = select([['', 'Choose…'], ...o.methods.map((c) => [c.code, c.label])], 'How');
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When' });
  const amount = h('input', { type: 'text', 'aria-label': 'Amount', placeholder: 'Optional, as you would write it, e.g. 30 mL or left breast 15 min' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional. Needed if the way is another way' });
  dialog('Record a feed', h('div', { class: 'stack' }, field('How', method), field('When', when), field('Amount', amount), field('Note', note)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/babyfeed`, { method: method.value, when: when.value ? new Date(when.value).toISOString() : '', amount: amount.value, note: note.value });
    toast('Feed recorded.');
    reload();
  });
}

function feedCard(x, reload) {
  return h('div', { class: `tile stack babyfeed babyfeed-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, x.methodLabel), h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, fmtDateTime(x.fedAt)), x.amount ? ` · ${x.amount}` : ''),
    x.note ? h('div', { class: 'small' }, x.note) : null,
    h('div', { class: 'small muted' }, `Recorded by ${x.recordedBy}`),
    x.closedNote ? h('div', { class: 'small' }, h('b', {}, `Entered in error (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), x.closedNote) : null,
    x.actions && x.actions.length ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => errorDialog(`/api/work/babyfeed/${x.id}/error`, 'Why', reload) }, 'Entered in error')) : null,
  );
}

// The Feeding tab, on the baby's own record.
export function babyFeedingPanel(personId, d, reload) {
  if (!d.isBaby) return h('div', { class: 'card empty' }, 'Feeds are recorded on the baby\'s own record. Open it from the mother\'s Baby tab.');
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => feedDialog(personId, d.options, reload) }, 'Record a feed')) : null,
    h('div', { class: 'small muted' }, 'SHIFT shows the feeds as recorded. It sets no feeding targets or amounts.'),
    d.feeds.length ? d.feeds.map((x) => feedCard(x, reload)) : h('div', { class: 'card empty' }, 'No feeds recorded yet.'),
  );
}
