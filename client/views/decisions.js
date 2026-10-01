import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Decisions made with the patient: the question and why now → options with benefits and risks →
// what they want → decided, why, whether they agree, when to look again → still right, or think again.
const LABEL = { option: 'Add an option', view: 'What they want', decide: 'Decide', review: 'Look at it again', close: 'Close' };

function raiseDialog(personId, reload) {
  const question = h('input', { 'aria-label': 'What needs deciding', placeholder: 'e.g. Whether to have a gastroscopy for the bleeding' });
  const background = h('textarea', { 'aria-label': 'Why now, and what we know', placeholder: 'e.g. Black stools, Hb 62; on enoxaparin; frail, lives alone' });
  dialog('A decision to make with them', h('div', { class: 'stack' }, field('What needs deciding', question), field('Why now, and what we know', background)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/decisions`, { question: question.value, background: background.value });
    toast('Saved. Now add the options.');
    reload();
  });
}

function optionDialog(x, reload) {
  const option = h('input', { 'aria-label': 'Option', placeholder: x.options.length ? 'e.g. Wait and watch, with blood if needed' : 'e.g. Gastroscopy today' });
  const benefits = h('textarea', { 'aria-label': 'Benefits', placeholder: 'e.g. Finds and stops the bleeding' });
  const risks = h('textarea', { 'aria-label': 'Risks', placeholder: 'e.g. Sedation; small risk of a tear' });
  dialog(`Option: ${x.question}`, h('div', { class: 'stack' }, field('Option', option), field('Benefits', benefits), field('Risks', risks),
    h('p', { class: 'small muted' }, 'Write them as you explained them. Doing nothing, or waiting, can be an option too.')), 'Add', async () => {
    await post(`/api/work/decisions/${x.id}/option`, { option: option.value, benefits: benefits.value, risks: risks.value });
    toast('Added.');
    reload();
  });
}

function viewDialog(x, o, reload) {
  const tookPart = select(Object.entries(o.tookPart), 'Could they take part', 'Choose…');
  if (x.tookPart) tookPart.value = x.tookPart;
  const view = h('textarea', { 'aria-label': 'What they want', placeholder: 'e.g. "I don\'t want a camera down if I can help it, but I don\'t want to bleed either"' });
  view.value = x.theirView ?? '';
  const note = h('input', { 'aria-label': 'Why not fully', placeholder: 'e.g. Too drowsy this morning; son Rawiri helped' });
  note.value = x.tookPartNote ?? '';
  const noteField = field('Why not fully', note);
  const others = h('input', { 'aria-label': 'Who else was involved', placeholder: 'Optional, e.g. Son Rawiri (enduring power of attorney), by phone' });
  others.value = x.others ?? '';
  const show = () => { noteField.hidden = !tookPart.value || tookPart.value === 'YES'; };
  tookPart.addEventListener('change', show);
  show();
  dialog(`What they want: ${x.question}`, h('div', { class: 'stack' }, field('Could they take part', tookPart), noteField, field('What they want', view), field('Who else was involved', others)), 'Save', async () => {
    await post(`/api/work/decisions/${x.id}/view`, { tookPart: tookPart.value, theirView: view.value, tookPartNote: note.value, others: others.value });
    toast('Saved.');
    reload();
  });
}

function decideDialog(x, o, reload) {
  const chosen = select(x.options.map((p) => [p.id, p.option]), 'Decided on', 'Choose…');
  const reason = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Bleeding has not settled after two units; he agrees now the risks are explained' });
  const agreed = select(Object.entries(o.agreed), 'Do they agree', 'Choose…');
  const reviewOn = h('input', { type: 'date', 'aria-label': 'Look at it again on' });
  const warn = h('p', { class: 'small warn-text', hidden: true }, 'Write how their view was weighed and what happens next. If they are refusing treatment, record it under Consent and capacity too.');
  agreed.addEventListener('change', () => { warn.hidden = agreed.value !== 'NOT_AGREED'; });
  dialog(`Decide: ${x.question}`, h('div', { class: 'stack' }, field('Decided on', chosen), field('Why', reason), field('Do they agree', agreed), warn,
    field('Look at it again on', reviewOn), h('p', { class: 'small muted' }, 'Leave the date empty if it does not need looking at again.')), 'Decide', async () => {
    await post(`/api/work/decisions/${x.id}/decide`, { chosen: chosen.value, reason: reason.value, agreed: agreed.value, reviewOn: reviewOn.value });
    toast('Decided.');
    reload();
  }, { wide: true });
}

function reviewDialog(x, reload) {
  const still = select([['yes', 'Yes, it still stands'], ['no', 'No, think again']], 'Does it still stand', 'Choose…');
  const note = h('textarea', { 'aria-label': 'What has changed, or why it stands', placeholder: 'e.g. Bleeding stopped after scope; plan still right' });
  const reviewOn = h('input', { type: 'date', 'aria-label': 'Look at it again on' });
  const dateField = field('Look at it again on', reviewOn);
  const show = () => { dateField.hidden = still.value !== 'yes'; };
  still.addEventListener('change', show);
  show();
  dialog(`Look again: ${x.question}`, h('div', { class: 'stack' }, field('Does it still stand', still), field('What has changed, or why it stands', note), dateField), 'Save', async () => {
    await post(`/api/work/decisions/${x.id}/review`, { still: still.value, note: note.value, reviewOn: reviewOn.value });
    toast('Saved.');
    reload();
  });
}

function closeDialog(x, reload) {
  const note = h('input', { 'aria-label': 'Why', placeholder: 'e.g. Done; or no longer needed, went home' });
  dialog(`Close: ${x.question}`, h('div', { class: 'stack' }, field('Why', note)), 'Close decision', async () => {
    await post(`/api/work/decisions/${x.id}/close`, { note: note.value });
    toast('Closed.');
    reload();
  });
}

function card(x, o, reload) {
  const tone = x.reviewDue || x.agreed === 'NOT_AGREED' ? 'warn' : x.state === 'DECIDED' ? 'ok' : '';
  const run = (a) => (a === 'option' ? optionDialog(x, reload) : a === 'view' ? viewDialog(x, o, reload) : a === 'decide' ? decideDialog(x, o, reload)
    : a === 'review' ? reviewDialog(x, reload) : closeDialog(x, reload));
  return h('div', { class: 'tile stack decision' },
    h('div', { class: 'spread' }, h('b', {}, x.question), h('span', { class: `tag ${tone}` }, x.reviewDue ? 'Due to look at again' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Why now: '), x.background),
    x.chosen ? h('div', { class: 'decision-chosen' }, h('b', {}, `Decided: ${x.chosen}`),
      h('div', { class: 'small' }, x.reason),
      h('div', { class: `small${x.agreed === 'NOT_AGREED' ? ' warn-text' : ' muted'}` }, `${x.agreedLabel} · ${x.decidedBy}, ${fmtDateTime(x.decidedAt)}${x.reviewOn ? ` · look again ${fmtDate(x.reviewOn)}` : ''}`)) : null,
    x.options.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Option', 'Benefits', 'Risks'].map((c) => h('th', {}, c)))),
      h('tbody', {}, x.options.map((p) => h('tr', { class: p.id === x.chosenId ? 'chosen' : '' }, h('td', {}, h('b', {}, p.option)), h('td', {}, p.benefits), h('td', {}, p.risks)))))) : null,
    x.tookPart ? h('div', { class: 'small' }, h('b', {}, 'What they want: '), x.theirView ?? 'They could not say.',
      h('div', { class: 'muted' }, [x.tookPartLabel, x.tookPartNote, x.others ? `Also involved: ${x.others}` : null].filter(Boolean).join(' · '))) : null,
    x.tookPart === 'NO' ? h('div', { class: 'small muted' }, 'Who may decide for someone who cannot take part is not set in SHIFT yet (RR-CAP-001).') : null,
    x.state === 'OPEN' && x.missing.length && x.acts.includes('decide') ? h('div', { class: 'small muted' }, `Before deciding, add ${x.missing.join(' and ')}.`) : null,
    x.closedNote ? h('div', { class: 'small muted' }, `Closed: ${x.closedNote}`) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', {
      class: `btn small${a === 'decide' || a === 'review' ? ' primary' : ''}`, disabled: a === 'decide' && x.missing.length > 0, onclick: () => run(a),
    }, a === 'view' && x.tookPart ? 'Change what they want' : LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// Doctors' Review and Medical Assessment; nurses' Care Plan and Medical Assessment.
export function decisionsPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Decisions with them'),
      s.canRaise ? h('button', { class: 'btn small', onclick: () => raiseDialog(personId, reload) }, 'A decision to make') : null),
    s.current.length ? s.current.map((x) => card(x, s.options, reload)) : h('div', { class: 'empty' }, 'No decisions being made.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Closed (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}
