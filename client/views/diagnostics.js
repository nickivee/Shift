import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime, stateTag, showError } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Tests and results: a doctor orders → the sample is taken (identity checked, labelled at the
// bedside) → sent → the result comes back, or the lab phones it and it is read back. A critical
// result stays on the record until a doctor acknowledges it with a plan. Corrections keep the original.
const ORDER_LABEL = { collect: 'Sample taken', send: 'Sent to the lab', cancel: 'Cancel' };
const yesNo = (label) => select([['yes', 'Yes'], ['no', 'No']], label);

function orderDialog(personId, o, reload) {
  const test = select(Object.entries(o.tests), 'Test');
  const priority = select(Object.entries(o.priority), 'How soon', null);
  priority.value = 'ROUTINE';
  const reason = h('input', { 'aria-label': 'Why', placeholder: 'e.g. Chest pain; check troponin' });
  dialog('Order a test', h('div', { class: 'stack' }, field('Test', test), field('How soon', priority), field('Why', reason)), 'Order', async () => {
    await post(`/api/work/patients/${personId}/tests`, { test: test.value, priority: priority.value, reason: reason.value });
    toast('Ordered.');
    reload();
  });
}

function orderActDialog(x, action, reload) {
  const note = h('input', { 'aria-label': 'Note' });
  if (action === 'send') return post(`/api/work/tests/${x.id}/send`, {}).then(() => { toast('Sent to the lab.'); reload(); }).catch(showError);
  if (action === 'cancel') {
    note.placeholder = 'e.g. Already done in ED this morning';
    return dialog(`Cancel ${x.label}`, h('div', { class: 'stack' }, field('Why', note)), 'Cancel test', async () => { await post(`/api/work/tests/${x.id}/cancel`, { note: note.value }); toast('Cancelled.'); reload(); });
  }
  const checked = h('input', { type: 'checkbox' });
  note.placeholder = 'Optional, e.g. Difficult; second attempt left arm';
  return dialog(`Sample taken: ${x.label}`, h('div', { class: 'stack' },
    h('label', { class: 'check' }, checked, ' I checked their name and NHI with them (or their wristband) and labelled the sample at the bedside'),
    field('Note', note)), 'Save', async () => {
    await post(`/api/work/tests/${x.id}/collect`, { idChecked: checked.checked ? 'yes' : 'no', note: note.value });
    toast('Saved.');
    reload();
  });
}

function phonedDialog(personId, d, reload) {
  const o = d.options;
  const order = select(o.waiting.map((w) => [w.id, w.label]), 'Which test', 'Not ordered in SHIFT');
  const test = h('input', { 'aria-label': 'Test name', placeholder: 'e.g. Potassium' });
  const testField = field('Test name', test);
  order.addEventListener('change', () => { testField.hidden = !!order.value; });
  const value = h('input', { 'aria-label': 'Result', placeholder: 'e.g. 6.8' });
  const units = h('input', { 'aria-label': 'Units', placeholder: 'e.g. mmol/L' });
  const range = h('input', { 'aria-label': 'Normal range', placeholder: 'Optional, e.g. 3.5–5.2' });
  const critical = yesNo('Did the lab say it is critical');
  const from = h('input', { 'aria-label': 'Who phoned', placeholder: 'e.g. Priya, lab scientist' });
  const readBack = h('input', { type: 'checkbox' });
  const told = h('input', { 'aria-label': 'Doctor told', placeholder: d.relay ? 'e.g. Dr Whyte (GP), by phone at 2.10pm' : 'e.g. Dr Li, in person' });
  const toldField = field('Which doctor you told, and how', told);
  const showTold = () => { toldField.hidden = d.canReview || critical.value !== 'yes'; };
  critical.addEventListener('change', showTold);
  showTold();
  dialog('Result phoned by the lab', h('div', { class: 'stack' },
    o.waiting.length ? field('Which test', order) : null, testField, field('Result', value), field('Units', units), field('Normal range', range),
    field('Did the lab say it is critical', critical), field('Who phoned', from),
    h('label', { class: 'check' }, readBack, ' I read it back and they confirmed it'), toldField,
  ), 'Save', async () => {
    await post(`/api/work/patients/${personId}/results`, {
      orderId: order.value, test: test.value, value: value.value, units: units.value, range: range.value, critical: critical.value, from: from.value,
      readBack: readBack.checked ? 'yes' : 'no', toldDoctor: told.value,
    });
    toast('Saved.');
    reload();
  });
}

function ackDialog(r, relay, reload) {
  const plan = h('textarea', { 'aria-label': 'Plan', placeholder: 'e.g. Repeat potassium now; ECG; insulin-dextrose if still above 6.5' });
  const doctor = h('input', { 'aria-label': 'Doctor who gave the plan', placeholder: 'e.g. Dr Whyte (GP), by phone' });
  dialog(`Critical result: ${r.test} ${r.value} ${r.units ?? ''}`, h('div', { class: 'stack' },
    relay ? field('Doctor who gave the plan', doctor) : null, field('Plan', plan)), 'Acknowledge', async () => {
    await post(`/api/work/results/${r.id}/acknowledge`, { plan: plan.value, doctor: doctor.value });
    toast('Acknowledged.');
    reload();
  });
}

function correctDialog(r, reload) {
  const value = h('input', { 'aria-label': 'Corrected result' });
  const reason = h('input', { 'aria-label': 'What was wrong', placeholder: 'e.g. Haemolysed sample; repeat was normal' });
  const from = h('input', { 'aria-label': 'Who at the lab told you', placeholder: 'e.g. Priya, lab scientist' });
  const critical = yesNo('Is the corrected result critical');
  critical.value = 'no';
  dialog(`Correct ${r.test} (${r.value} ${r.units ?? ''})`, h('div', { class: 'stack' },
    field('Corrected result', value), field('What was wrong', reason), field('Who at the lab told you', from), field('Is the corrected result critical', critical),
    h('p', { class: 'small muted' }, 'The original stays in the record, marked as corrected.')), 'Save', async () => {
    await post(`/api/work/results/${r.id}/correct`, { value: value.value, reason: reason.value, from: from.value, critical: critical.value });
    toast('Corrected.');
    reload();
  });
}

function orderCard(x, reload) {
  const tone = x.overdue ? 'warn' : x.state === 'RESULTED' ? 'ok' : '';
  return h('div', { class: 'tile stack test-order' },
    h('div', { class: 'spread' }, h('b', {}, `${x.label}${x.priority === 'URGENT' ? ' · Urgent' : ''}`), h('span', { class: `tag ${tone}` }, x.overdue ? 'Sample overdue' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Why: '), x.reason),
    h('div', { class: 'small muted' }, [
      `Ordered by ${x.orderedBy} ${fmtDateTime(x.orderedAt)}`,
      x.state === 'ORDERED' ? `take by ${fmtDateTime(x.takeBy)}` : null,
      x.collectedBy ? `taken by ${x.collectedBy} ${fmtDateTime(x.collectedAt)}` : null,
      x.sentAt ? `sent ${fmtDateTime(x.sentAt)}` : null,
      x.cancelNote ? `cancelled: ${x.cancelNote}` : null,
    ].filter(Boolean).join(' · ')),
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'collect' ? ' primary' : ''}`, onclick: () => orderActDialog(x, a, reload) }, ORDER_LABEL[a]))) : null,
  );
}

function resultRow(r, d, reload) {
  const flagged = r.critical ? 'flag-C' : r.flag ? `flag-${r.flag}` : '';
  const btn = (label, fn, primary) => h('button', { class: `btn small${primary ? ' primary' : ''}`, onclick: fn }, label);
  return h('tr', { class: r.state === 'CORRECTED' ? 'corrected' : r.needsAck ? 'critical-row' : '' },
    h('td', {}, h('b', {}, r.test), r.correctsId ? h('div', { class: 'small muted' }, 'Corrected result') : null),
    h('td', { class: flagged }, `${r.value} ${r.units ?? ''}${r.critical ? ' CRITICAL' : r.flag ? ` ${r.flag}` : ''}`),
    h('td', {}, r.referenceRange),
    h('td', {}, fmtDateTime(r.performedAt), r.receivedBy ? h('div', { class: 'small muted' }, `${r.source}; taken by ${r.receivedBy}${r.readBack ? ', read back' : ''}`) : null),
    h('td', {}, r.state === 'CORRECTED' ? h('span', { class: 'tag' }, 'Corrected') : r.needsAck ? h('span', { class: 'tag warn' }, 'Not acknowledged') : stateTag(r.state),
      r.toldDoctor && r.needsAck ? h('div', { class: 'small muted' }, `Told ${r.toldDoctor}`) : null,
      r.ackPlan ? h('div', { class: 'small' }, `${r.ackBy}: ${r.ackPlan}`) : r.reviewedBy ? h('div', { class: 'small muted' }, r.reviewedBy) : null,
      r.correctedReason ? h('div', { class: 'small muted' }, r.correctedReason) : null),
    h('td', {}, h('div', { class: 'row' },
      r.actions.includes('acknowledge') ? btn(d.relay ? "Record the doctor's plan" : 'Acknowledge', () => ackDialog(r, d.relay, reload), true) : null,
      r.actions.includes('review') ? btn('Mark reviewed', async () => { try { await post(`/api/work/results/${r.id}/review`); toast('Marked reviewed.'); reload(); } catch (err) { showError(err); } }) : null,
      r.actions.includes('correct') ? btn('Lab corrected it', () => correctDialog(r, reload)) : null)),
  );
}

export function resultsPanel(personId, d, reload) {
  const open = d.orders.filter((o) => !['RESULTED', 'CANCELLED'].includes(o.state));
  const done = d.orders.filter((o) => ['RESULTED', 'CANCELLED'].includes(o.state));
  return h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Tests ordered'), h('div', { class: 'row' },
      d.canOrder ? h('button', { class: 'btn small', onclick: () => orderDialog(personId, d.options, reload) }, 'Order a test') : null,
      d.canReceive ? h('button', { class: 'btn small', onclick: () => phonedDialog(personId, d, reload) }, 'Result phoned by the lab') : null)),
    open.length ? open.map((x) => orderCard(x, reload)) : h('div', { class: 'empty' }, 'No tests waiting.'),
    done.length ? h('details', {}, h('summary', { class: 'small' }, `Recently finished (${done.length})`), h('div', { class: 'stack' }, done.map((x) => orderCard(x, reload)))) : null,
    h('h3', {}, 'Results'),
    d.results.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Test', 'Result', 'Range', 'Taken', 'State', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, d.results.map((r) => resultRow(r, d, reload))))) : h('div', { class: 'empty' }, 'No results yet.'),
  );
}
