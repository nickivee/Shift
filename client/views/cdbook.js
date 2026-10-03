import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Home → Controlled drug book (nurses). A page for each form of each drug → each receipt signed by the
// person who issued it and the person who received it → each dose entered as it is given (where the
// dose is recorded) → a joint check against stock once in every week → a count as at 30 June and
// 31 December, with any difference explained.
const KIND = { RECEIPT: 'Received', GIVEN: 'Given', CHECK: 'Weekly check', STOCKTAKE: 'Stocktake' };

function pageDialog(reload) {
  const drug = h('input', { 'aria-label': 'Drug and form', placeholder: 'e.g. MORPHINE injection 10 mg/mL' });
  const unit = h('input', { 'aria-label': 'Unit', placeholder: 'e.g. mL, or tablets' });
  dialog('Add a page to the book', h('div', { class: 'stack' }, field('Drug and form', drug), field('The book counts in', unit)), 'Save', async () => {
    await post('/api/work/controlled-drugs/page', { drug: drug.value, unit: unit.value });
    toast('Added.');
    reload();
  });
}

function receiptDialog(p, reload) {
  const qty = h('input', { type: 'number', step: 'any', min: '0', 'aria-label': 'Amount received' });
  const issuedBy = h('input', { 'aria-label': 'Issued by', placeholder: 'e.g. Pharmacy, J Singh' });
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Receive ${p.drug}`, h('div', { class: 'stack' }, h('p', { class: 'small' }, `The book shows ${p.balance} ${p.unit}. You sign as the person receiving it.`),
    field(`Amount received (${p.unit})`, qty), field('Issued by', issuedBy), field('Note (optional)', note)), 'Save', async () => {
    await post('/api/work/controlled-drugs/receipt', { pageId: p.id, qty: qty.value, issuedBy: issuedBy.value, note: note.value });
    toast('Recorded.');
    reload();
  });
}

function countDialog(p, d, action, reload) {
  const counted = h('input', { type: 'number', step: 'any', min: '0', 'aria-label': 'Counted' });
  const second = select(d.colleagues.map((c) => [c.id, c.name]), 'Checked with', action === 'check' ? 'Choose…' : 'No second person');
  const asAt = action === 'stocktake' ? select(d.stocktakes.map((x) => [x.value, x.label]), 'As at') : null;
  const note = h('textarea', { 'aria-label': 'Explanation', placeholder: 'Only needed if the count differs from the book' });
  dialog(action === 'check' ? `Weekly check: ${p.drug}` : `Stocktake: ${p.drug}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, `The book shows ${p.balance} ${p.unit}. Count the stock and write what you counted.`),
    asAt ? field('Stocktake as at', asAt) : null, field(`Counted (${p.unit})`, counted),
    field(action === 'check' ? 'Checked jointly with' : 'Counted with (optional)', second), field('If the count differs, why', note)), 'Save', async () => {
    await post(`/api/work/controlled-drugs/${action}`, { pageId: p.id, counted: counted.value, second: second.value, note: note.value, asAt: asAt ? asAt.value : '' });
    toast('Recorded.');
    reload();
  });
}

function entryRow(e, unit) {
  return h('li', { class: `det-step${e.variance ? ' overdue' : ''}` },
    h('div', { class: 'small muted' }, `${fmtDateTime(e.at)} · ${e.by}${e.second ? ` with ${e.second}` : ''}${e.issuedBy ? ` · issued by ${e.issuedBy}` : ''}`),
    h('div', { class: 'small' }, h('b', {}, KIND[e.kind]),
      e.kind === 'RECEIPT' ? ` ${e.qty} ${unit}` : e.kind === 'GIVEN' ? ` ${e.qty} ${unit}${e.patient ? ` to ${e.patient}` : ''}` : ` counted ${e.counted} ${unit}${e.asAt ? ` as at ${e.asAt}` : ''}${e.variance ? ' (differs from the book)' : ''}`,
      ` · book shows ${e.balance} ${unit}`, e.note ? ` · ${e.note}` : ''));
}

function pageCard(p, d, reload) {
  return h('div', { class: `tile stack${p.checkOverdue || p.stocktakeDue ? ' overdue' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, p.drug), h('span', { class: 'tag' }, `${p.balance} ${p.unit} in the book`)),
    h('div', { class: 'row' },
      h('span', { class: `tag${p.checkDue ? ' warn' : ' ok'}` }, p.lastCheck ? `Weekly check: last ${fmtDateTime(p.lastCheck)}${p.checkDue ? ', due' : ''}` : 'Weekly check: none yet'),
      p.stocktakeFor ? h('span', { class: 'tag warn' }, `Stocktake due: as at ${p.stocktakeFor}`) : h('span', { class: 'tag ok' }, 'Stocktakes up to date')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => receiptDialog(p, reload) }, 'Receive stock'),
      h('button', { class: `btn small${p.checkDue ? ' primary' : ''}`, onclick: () => countDialog(p, d, 'check', reload) }, 'Weekly check'),
      h('button', { class: `btn small${p.stocktakeDue ? ' primary' : ''}`, onclick: () => countDialog(p, d, 'stocktake', reload) }, 'Stocktake')),
    p.entries.length ? h('details', {}, h('summary', { class: 'small' }, `Entries (${p.entries.length} most recent)`), h('ol', { class: 'det-steps' }, p.entries.map((e) => entryRow(e, p.unit)))) : h('div', { class: 'small muted' }, 'No entries yet.'));
}

export async function cdBookView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/controlled-drugs');
    mount(root,
      workHeader(),
      pageTitle('Controlled drug book', () => go('/work/home')),
      h('div', { class: 'banner' }, `This ward's book: each receipt is signed by who issued it and who received it, each dose is entered as it is given, the book is checked with a colleague every ${d.checkDays} days, and the stock is counted as at 30 June and 31 December.`),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => pageDialog(load) }, 'Add a page')),
      d.pages.length ? d.pages.map((p) => pageCard(p, d, load)) : h('div', { class: 'card empty' }, 'No pages in this ward\'s book yet.'),
    );
  };
  await load();
  return root;
}
