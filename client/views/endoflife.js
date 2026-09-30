import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Palliative and end-of-life care: recognised → talked about → wishes in their words → reviewed →
// last days recognised and whānau told → comfort checked → death → whānau followed up.
// Resuscitation and treatment limits, anticipatory prescribing and assisted dying are not in
// SHIFT (RR-EOL-001).
const RESEARCH = 'Resuscitation and treatment-limit decisions, just-in-case medicines and the End of Life Choice Act are not recorded here (RR-EOL-001). Wishes recorded here are not an advance directive.';
const LABEL = { comfort: 'Comfort check', review: 'Review', change: 'Change wishes', lastdays: 'Last days of life', stable: 'No longer in last days', end: 'End plan', bereavement: 'Whānau follow-up' };
const hours = (n) => (n < 48 ? `In ${n} hours` : `In ${n / 24} days`);

function wishFields(o, x = {}) {
  const placeCare = select(Object.entries(o.places), 'Where they want to be cared for'); if (x.placeCare) placeCare.value = x.placeCare;
  const placeDeath = select(Object.entries(o.places), 'Where they want to be when they die'); if (x.placeDeath) placeDeath.value = x.placeDeath;
  const wishes = h('textarea', { 'aria-label': 'What matters to them', placeholder: 'In their words: music, karakia, prayers, who they want with them, what they do not want' }); wishes.value = x.wishes ?? '';
  const call = h('input', { 'aria-label': 'Who to call and when', placeholder: 'e.g. Daughter Mele, any time day or night' }); call.value = x.call ?? '';
  return {
    els: [field('Where they want to be cared for', placeCare), field('Where they want to be when they die', placeDeath), field('What matters to them', wishes), field('Who to call and when', call)],
    value: () => ({ placeCare: placeCare.value, placeDeath: placeDeath.value, wishes: wishes.value, call: call.value }),
  };
}
const reviewSelect = (o) => select(o.reviewHours.map((n) => [String(n), hours(n)]), 'Look at it again', null);

function startDialog(personId, e, reload) {
  const o = e.options;
  const basis = h('textarea', { 'aria-label': 'Why palliative care now', placeholder: 'e.g. Heart failure, more breathless at rest, eating less' });
  const agreed = h('input', { 'aria-label': 'Who agreed', placeholder: 'e.g. Dr Anna Whyte (GP) at her review' });
  const discussed = h('textarea', { 'aria-label': 'What was talked about', placeholder: 'What was talked about with them and their whānau, and who was there' });
  const anticipatory = h('input', { 'aria-label': 'Just-in-case medicines', placeholder: 'Optional: where they are charted, e.g. "On the paper chart"' });
  const w = wishFields(o);
  const review = reviewSelect(o);
  dialog('Start palliative care', h('div', { class: 'stack' },
    field('Why palliative care now', basis), field('Who agreed', agreed), field('What was talked about', discussed), ...w.els,
    field('Just-in-case medicines', anticipatory), field('Look at it again', review), h('p', { class: 'small muted' }, RESEARCH),
  ), 'Start plan', async () => {
    await post(`/api/work/patients/${personId}/end-of-life`, { basis: basis.value, agreedWith: agreed.value, discussed: discussed.value, anticipatory: anticipatory.value, reviewHours: Number(review.value), ...w.value() });
    toast('Palliative care plan started.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/end-of-life/${x.id}/${action}`, { note: note.value, ...body });
  const done = () => { toast('Saved.'); reload(); };
  if (action === 'comfort') {
    note.placeholder = 'e.g. Mouth care, turned to her left side, settled, no signs of pain';
    return dialog('Comfort check', h('div', { class: 'stack' }, field('What you checked and did', note)), 'Save', async () => { await send({}); done(); });
  }
  if (action === 'review') {
    note.placeholder = 'e.g. Settled; eating a little; wishes unchanged';
    const review = reviewSelect(o);
    return dialog('Review the plan', h('div', { class: 'stack' }, field('What you found', note), field('Look at it again', review)), 'Save review', async () => { await send({ reviewHours: Number(review.value) }); done(); });
  }
  if (action === 'change') {
    note.placeholder = 'e.g. She told her daughter she wants to stay here';
    const w = wishFields(o, x);
    return dialog('Change wishes', h('div', { class: 'stack' }, ...w.els, field('Who said so and why', note)), 'Save change', async () => { await send(w.value()); done(); });
  }
  if (action === 'lastdays') {
    note.placeholder = 'e.g. Not eating or drinking, sleeping most of the day; Dr Whyte agrees';
    const told = h('input', { 'aria-label': 'Whānau told', placeholder: 'e.g. Daughter phoned at 09:00, coming in' });
    return dialog('Last days of life', h('div', { class: 'stack' }, field('What you saw and who agreed', note), field('Whānau told', told)), 'Save', async () => { await send({ whanauTold: told.value }); done(); });
  }
  if (action === 'stable') {
    note.placeholder = 'e.g. Eating and talking again after two days';
    return dialog('No longer in the last days', h('div', { class: 'stack' }, field('What changed', note)), 'Save', async () => { await send({}); done(); });
  }
  if (action === 'bereavement') {
    note.placeholder = 'e.g. Phoned her daughter; offered the hospice bereavement service';
    return dialog('Whānau follow-up', h('div', { class: 'stack' }, field('Who you spoke with and what was offered', note)), 'Save', async () => { await send({}); done(); });
  }
  note.placeholder = 'What the decision was based on';
  const reason = select(Object.entries(o.end).filter(([k]) => k !== 'DIED'), 'Why it is ending');
  return dialog('End the plan', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'If they have died, use "They have died" below instead. The plan ends with it.'),
    field('Why it is ending', reason), field('Note', note)), 'End plan', async () => { await send({ reason: reason.value }); done(); });
}

function planCard(x, o, reload) {
  return h('div', { class: `tile stack eol eol-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('b', {}, x.stateLabel),
      h('span', { class: `tag ${x.overdue ? 'danger' : x.state === 'LAST_DAYS' ? 'warn' : ''}` }, x.overdue ? 'Review overdue' : x.state === 'ENDED' ? x.endLabel : `Review by ${fmtDateTime(x.reviewDue)}`)),
    h('div', { class: 'small' }, h('b', {}, 'Why: '), x.basis, ` Agreed with ${x.agreedWith}.`),
    h('div', { class: 'small' }, h('b', {}, 'Talked about: '), x.discussed),
    h('div', { class: 'small' }, h('b', {}, 'Cared for: '), x.placeCareLabel, h('b', {}, ' · When they die: '), x.placeDeathLabel),
    x.wishes ? h('div', { class: 'small' }, h('b', {}, 'What matters: '), x.wishes) : null,
    x.call ? h('div', { class: 'small' }, h('b', {}, 'Who to call: '), x.call) : null,
    x.anticipatory ? h('div', { class: 'small muted' }, `Just-in-case medicines: ${x.anticipatory}`) : null,
    x.lastDaysNote ? h('div', { class: 'small' }, h('b', {}, `Last days recognised (${x.lastDaysBy} ${fmtDateTime(x.lastDaysAt)}): `), x.lastDaysNote) : null,
    x.endNote ? h('div', { class: 'small' }, h('b', {}, `${x.endLabel} (${x.endedBy} ${fmtDateTime(x.endedAt)}): `), x.endNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'comfort' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    x.log.length ? h('details', {}, h('summary', { class: 'small' }, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))) : null,
  );
}

// Inside the person's End of life view, above their death record.
export function endOfLifePanel(personId, e, reload) {
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Palliative care'),
      e.canStart && !e.plan ? h('button', { class: 'btn small', onclick: () => startDialog(personId, e, reload) }, 'Start palliative care') : null),
    e.plan ? planCard(e.plan, e.options, reload) : h('div', { class: 'empty' }, 'No palliative care plan.'),
    e.ended.length ? h('details', {}, h('summary', { class: 'small' }, `Ended (${e.ended.length})`), h('div', { class: 'stack' }, e.ended.map((x) => planCard(x, e.options, reload)))) : null,
  );
}
