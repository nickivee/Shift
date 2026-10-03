import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Privacy access review, on the privacy officer's screen. SHIFT lists who opened a record and whether
// a care link is on file; whether it was appropriate is the privacy officer's finding, not SHIFT's.
const line = (label, v) => (v ? h('div', { class: 'small' }, h('b', {}, `${label} `), v) : null);

function openDialog(o, reload, preset = {}) {
  const nhi = h('input', { type: 'text', 'aria-label': 'NHI', placeholder: 'e.g. ZZZ0276', autocapitalize: 'characters', value: preset.nhi ?? '' });
  const source = select(Object.entries(o.source), 'What started this');
  if (preset.source) source.value = preset.source;
  const why = h('textarea', { 'aria-label': 'What you are looking into', placeholder: 'e.g. The person says a neighbour who works here knew about her visit' });
  dialog('Look into who opened a record', h('div', { class: 'stack' }, field('NHI of the person', nhi), field('What started this', source), field('What you are looking into', why)), 'Save', async () => {
    await post('/api/work/privacy-reviews', { nhi: nhi.value, source: source.value, why: why.value });
    toast('Opened.');
    reload();
  }, { wide: true });
}

function noteDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What you did or were told', placeholder: 'e.g. Spoke to Kate; she was covering for a colleague who was away' });
  dialog('Add a note', field('What you did or were told', note), 'Save', async () => { await post(`/api/work/privacy-reviews/${x.id}/note`, { note: note.value }); toast('Saved.'); reload(); });
}
function findingDialog(x, o, reload) {
  const finding = select(Object.entries(o.finding), 'What you found');
  const note = h('textarea', { 'aria-label': 'What it is based on', placeholder: 'e.g. Kate had no reason to open the record and could not explain it' });
  dialog('Record the finding', h('div', { class: 'stack' }, field('What you found', finding), field('What it is based on', note)), 'Save', async () => {
    await post(`/api/work/privacy-reviews/${x.id}/finding`, { finding: finding.value, note: note.value });
    toast('Saved.');
    reload();
  });
}
function closeDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What was done', placeholder: 'e.g. Talked with the staff member and her manager; no further action' });
  dialog('Close the review', h('div', { class: 'stack' }, field('What was done, and who was told', note),
    h('div', { class: 'small muted' }, 'SHIFT does not decide what must be reported or to whom. Record what you did.')), 'Save', async () => {
    await post(`/api/work/privacy-reviews/${x.id}/close`, { note: note.value });
    toast('Closed.');
    reload();
  });
}

const viewerRow = (v) => h('li', { class: 'small row' }, `${v.name} · ${v.role}, ${v.service} · opened ${v.opened}× · last ${fmtDateTime(v.last)}`,
  v.noLink ? h('span', { class: 'tag warn' }, 'No care link on file') : null);

function card(x, o, reload) {
  return h('div', { class: 'tile stack review' },
    h('div', { class: 'spread' }, h('b', {}, `${x.person} · NHI ${x.nhi ?? 'none'}`), h('span', { class: `tag ${x.state === 'CLOSED' ? 'ok' : 'warn'}` }, x.stateLabel)),
    h('div', { class: 'small muted' }, `${x.sourceLabel} · opened by ${x.openedBy}, ${fmtDateTime(x.openedAt)}`), h('div', { class: 'small' }, x.why),
    h('details', {}, h('summary', { class: 'small' }, `Who opened this record (${x.viewers.length})`),
      x.viewers.length ? h('ul', { class: 'stack' }, x.viewers.map(viewerRow)) : h('div', { class: 'small muted' }, 'No one is recorded as opening it.')),
    x.steps.map((s) => h('div', { class: 'small' }, h('b', {}, `${s.by}, ${fmtDateTime(s.at)}: `), s.body)),
    x.finding ? line(`${x.findingLabel}:`, `${x.findingNote} (${x.foundBy}, ${fmtDateTime(x.foundAt)})`) : null,
    x.closedAt ? line('Done:', `${x.outcomeNote} (${x.closedBy}, ${fmtDateTime(x.closedAt)})`) : null,
    x.actions.length ? h('div', { class: 'row' },
      x.actions.includes('note') ? h('button', { class: 'btn small', onclick: () => noteDialog(x, reload) }, 'Add a note') : null,
      x.actions.includes('finding') ? h('button', { class: 'btn small primary', onclick: () => findingDialog(x, o, reload) }, 'Record the finding') : null,
      x.actions.includes('close') ? h('button', { class: 'btn small primary', onclick: () => closeDialog(x, reload) }, 'Close') : null) : null);
}

export function reviewSections(d, reload) {
  const section = (title, rows, empty, make) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${rows.length})`),
    rows.length ? rows.map(make) : h('div', { class: 'card empty' }, empty));
  return [
    h('div', { class: 'banner' }, `Who has opened records. SHIFT lists what it can see; it does not decide what was appropriate or what must be reported.`),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => openDialog(d.options, reload) }, 'Look into a record')),
    section(`Worth a look (last ${d.windowDays} days)`, d.flagged, 'Nothing to flag.', (f) => h('div', { class: 'tile stack flagged' },
      h('div', { class: 'spread' }, h('b', {}, `${f.name} opened ${f.person}`), h('span', { class: 'tag warn' }, 'No care link on file')),
      h('div', { class: 'small muted' }, `${f.role}, ${f.service} · NHI ${f.nhi ?? 'none'} · opened ${f.opened}× · last ${fmtDateTime(f.last)}`),
      h('div', { class: 'small muted' }, 'There can be good reasons, for example covering for a colleague.'),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => openDialog(d.options, reload, { nhi: f.nhi, source: 'FLAGGED' }) }, 'Look into it')))),
    section('Looking into', d.open, 'Nothing being looked into.', (x) => card(x, d.options, reload)),
    section('To close', d.toClose, 'Nothing waiting to be closed.', (x) => card(x, d.options, reload)),
    section('Closed in the last fortnight', d.closed, 'Nothing closed recently.', (x) => card(x, d.options, reload)),
  ];
}
