import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Immediate danger check at the front door: is anyone in immediate danger? SHIFT decides nothing.
function checkDialog(personId, o, reload) {
  const danger = select([['NO', 'No, no one is in immediate danger'], ['YES', 'Yes, someone is in danger']], 'Is anyone in immediate danger', null);
  const kind = select(Object.entries(o.kind), 'What', 'Choose…');
  const what = h('textarea', { 'aria-label': 'What the danger is', placeholder: 'e.g. Brother is shouting and threatening staff in the waiting room' });
  const done = h('textarea', { 'aria-label': 'Done straight away', placeholder: 'e.g. Moved patient to a cubicle; called security' });
  const told = h('input', { 'aria-label': 'Who was told', placeholder: 'e.g. Charge nurse and security' });
  const more = h('div', { class: 'stack', hidden: true }, field('What', kind), field('What the danger is', what), field('What was done straight away', done), field('Who was told', told));
  danger.addEventListener('change', () => { more.hidden = danger.value !== 'YES'; });
  dialog('Immediate danger check', h('div', { class: 'stack' }, field('Is anyone in immediate danger', danger), more), 'Save', async () => {
    await post(`/api/work/patients/${personId}/danger`, { danger: danger.value, kind: kind.value, what: what.value, done: done.value, told: told.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function safeDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'How it was made safe', placeholder: 'e.g. Brother left with security; patient settled in a cubicle' });
  dialog('Made safe', h('div', { class: 'stack' }, field('How it was made safe', note)), 'Save', async () => {
    await post(`/api/work/danger/${x.id}/safe`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function card(x, reload) {
  return h('div', { class: `tile stack danger-check${x.state === 'DANGER' ? ' open' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, x.state === 'CLEAR' ? 'No one in immediate danger' : x.kindLabel), h('span', { class: `tag ${x.state === 'DANGER' ? 'danger' : x.state === 'MADE_SAFE' ? 'ok' : ''}` }, x.stateLabel)),
    x.what ? h('div', { class: 'small' }, x.what) : null,
    x.done ? h('div', { class: 'small' }, h('b', {}, 'Straight away: '), x.done, h('b', {}, ' Told: '), x.told) : null,
    h('div', { class: 'small muted' }, `${x.checkedBy}, ${fmtDateTime(x.checkedAt)}`),
    x.safeNote ? h('div', { class: 'small' }, h('b', {}, `Made safe (${x.safeBy}, ${fmtDateTime(x.safeAt)}): `), x.safeNote) : null,
    x.canSafe ? h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: () => safeDialog(x, reload) }, 'Made safe')) : null,
  );
}

// ED nurses' Triage and ED doctors' Medical Assessment.
export function dangerPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Immediate danger check'),
      s.canRecord && !s.current.length ? h('button', { class: 'btn small', onclick: () => checkDialog(personId, s.options, reload) }, 'Record the check') : null),
    s.current.length ? s.current.map((x) => card(x, reload)) : null,
    !s.current.length && !s.past.length ? h('div', { class: 'small muted' }, 'Not asked yet.') : null,
    s.past.length ? h('details', { open: !s.current.length }, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, reload)))) : null,
  );
}
