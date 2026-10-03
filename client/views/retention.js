import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Records retention and legal holds, on the privacy officer's screen. SHIFT sets no retention period
// and deletes nothing: it records holds, the decision against the rule named, and what was done.
const line = (label, v) => (v ? h('div', { class: 'small' }, h('b', {}, `${label} `), v) : null);

function holdDialog(reload) {
  const nhi = h('input', { type: 'text', 'aria-label': 'NHI', placeholder: 'e.g. ZZZ0091', autocapitalize: 'characters' });
  const asked = h('input', { type: 'text', 'aria-label': 'Who asked', placeholder: 'e.g. Coroner\'s office' });
  const reason = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Record needed for the coroner\'s inquiry' });
  const ref = h('input', { type: 'text', 'aria-label': 'Reference', placeholder: 'Their reference, if they gave one' });
  dialog('Put a record on legal hold', h('div', { class: 'stack' }, field('NHI of the person', nhi), field('Who asked for the hold', asked), field('Why', reason), field('Their reference (optional)', ref)), 'Save', async () => {
    await post('/api/work/retention/holds', { nhi: nhi.value, askedBy: asked.value, reason: reason.value, reference: ref.value });
    toast('On hold.');
    reload();
  }, { wide: true });
}

function reviewDialog(reload) {
  const nhi = h('input', { type: 'text', 'aria-label': 'NHI', placeholder: 'e.g. ZZZ0156', autocapitalize: 'characters' });
  const scope = h('textarea', { 'aria-label': 'Which records', placeholder: 'e.g. Paper file and electronic record of the 2019 stay' });
  const why = h('textarea', { 'aria-label': 'Why it is being reviewed', placeholder: 'e.g. Stay ended; due for retention review' });
  dialog('Review a record', h('div', { class: 'stack' }, field('NHI of the person', nhi), field('Which records', scope), field('Why it is being reviewed', why)), 'Save', async () => {
    await post('/api/work/retention/reviews', { nhi: nhi.value, scope: scope.value, why: why.value });
    toast('Logged.');
    reload();
  }, { wide: true });
}

function noteDialog(url, title, label, placeholder, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), 'Save', async () => { await post(url, { note: note.value }); toast('Saved.'); reload(); });
}

function decideDialog(v, o, reload) {
  const decision = select(Object.entries(o.decision), 'Decision');
  const basis = h('input', { type: 'text', 'aria-label': 'Rule or period relied on', placeholder: 'e.g. Retention schedule item 4.2' });
  const note = h('textarea', { 'aria-label': 'What you found and why', placeholder: 'e.g. Last entry was more than the required period ago and nothing is outstanding' });
  dialog('Decide', h('div', { class: 'stack' }, field('Decision', decision), field('Rule or period relied on', basis), field('What you found and why', note),
    h('div', { class: 'small muted' }, 'SHIFT sets no retention period. Name the rule your organisation follows.')), 'Save', async () => {
    await post(`/api/work/retention/reviews/${v.id}/decide`, { decision: decision.value, basis: basis.value, note: note.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

const holdCard = (x, reload) => h('div', { class: 'tile stack hold' },
  h('div', { class: 'spread' }, h('b', {}, `${x.person} · NHI ${x.nhi ?? 'none'}`), h('span', { class: `tag ${x.state === 'ACTIVE' ? 'danger' : 'muted'}` }, x.stateLabel)),
  line('Asked by:', `${x.askedBy}${x.reference ? ` (${x.reference})` : ''}`), h('div', { class: 'small' }, x.reason),
  h('div', { class: 'small muted' }, `Placed by ${x.placedBy}, ${fmtDateTime(x.placedAt)}`),
  x.releasedAt ? line('Released:', `${x.releaseNote} (${x.releasedBy}, ${fmtDateTime(x.releasedAt)})`) : null,
  x.canRelease ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => noteDialog(`/api/work/retention/holds/${x.id}/release`, 'Release the hold', 'Why, and who said so', 'e.g. Coroner\'s office confirmed the file is closed', reload) }, 'Release')) : null);

const reviewCard = (x, o, reload) => h('div', { class: 'tile stack hold' },
  h('div', { class: 'spread' }, h('b', {}, `${x.person} · NHI ${x.nhi ?? 'none'}`), h('span', { class: `tag ${x.state === 'DONE' ? 'ok' : 'warn'}` }, x.stateLabel)),
  h('div', { class: 'small' }, h('b', {}, 'Records: '), x.scope), h('div', { class: 'small' }, x.why),
  x.onHold ? h('div', { class: 'small' }, h('span', { class: 'tag danger' }, 'On legal hold'), ' It cannot be disposed of until the hold is released.') : null,
  x.decision ? line(`${x.decisionLabel}:`, `${x.decisionNote} Relied on: ${x.basis} (${x.decidedBy}, ${fmtDateTime(x.decidedAt)})`) : null,
  x.doneAt ? line('Done:', `${x.doneNote} (${x.doneBy}, ${fmtDateTime(x.doneAt)})`) : null,
  x.actions.length ? h('div', { class: 'row' },
    x.actions.includes('decide') ? h('button', { class: 'btn small primary', onclick: () => decideDialog(x, o, reload) }, 'Decide') : null,
    x.actions.includes('done') ? h('button', { class: 'btn small primary', onclick: () => noteDialog(`/api/work/retention/reviews/${x.id}/done`, 'Carried out', 'What was done and how', 'e.g. Paper file shredded by the contractor, certificate 4471', reload) }, 'Carried out') : null) : null);

export function retentionSections(d, reload) {
  const section = (title, rows, empty, make) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${rows.length})`),
    rows.length ? rows.map(make) : h('div', { class: 'card empty' }, empty));
  return [
    h('div', { class: 'banner' }, 'Legal holds and record reviews. SHIFT deletes nothing. It records the hold, what was decided against the rule you name, and what was done.' + (d.minimumYears ? ` Your organisation\'s rules say to keep a record for at least ${d.minimumYears} years from the last time the person was seen.` : ' Your organisation has not set a minimum time to keep a record.')),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => holdDialog(reload) }, 'Put a record on hold'), h('button', { class: 'btn', onclick: () => reviewDialog(reload) }, 'Review a record')),
    section('On legal hold', d.holds, 'No records on hold.', (x) => holdCard(x, reload)),
    section('Records to decide', d.toDecide, 'No records waiting for a decision.', (x) => reviewCard(x, d.options, reload)),
    section('Records to carry out', d.toDo, 'Nothing waiting to be carried out.', (x) => reviewCard(x, d.options, reload)),
    section('Done or released in the last fortnight', [...d.done, ...d.released], 'Nothing recently.', (x) => (x.scope ? reviewCard(x, d.options, reload) : holdCard(x, reload))),
  ];
}
