import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Residential care stay: place offered → accepted → moved in → level of care from a needs
// assessment → reassessment → hospital stays with the room held → left our care. SHIFT records the
// level it was given and where it came from; it does not decide it (RR-ARC-001).
const RESEARCH = 'SHIFT records the level a needs assessment gave. The levels, funding and how long a room is held in hospital are still being researched (RR-ARC-001).';
const LABEL = { accept: 'Place accepted', movein: 'Moved in', decline: 'Not taken', hospital: 'Went to hospital', back: 'Back from hospital', reassess: 'Ask for reassessment', level: 'New level', end: 'Leaving our care' };
const today = () => new Date().toISOString().slice(0, 10);

function levelFields(o, current) {
  const level = select(Object.entries(o.levels), 'Level of care');
  if (current) level.value = current.level;
  const source = select(Object.entries(o.sources), 'Assessed by');
  if (current?.levelSource) source.value = current.levelSource;
  const on = h('input', { type: 'date', 'aria-label': 'Assessed on', max: today(), value: current?.levelOn ?? '' });
  const warn = h('p', { class: 'small warn-text' });
  const show = () => {
    const known = level.value && level.value !== 'NOT_KNOWN';
    source.parentElement && (source.parentElement.hidden = !known);
    on.parentElement && (on.parentElement.hidden = !known);
    warn.textContent = known && !o.provided.includes(level.value) ? `We do not provide ${o.levels[level.value].toLowerCase()}. Plan a move with them and their whānau.` : '';
  };
  level.addEventListener('change', show);
  const el = h('div', { class: 'stack' }, field('Level of care', level), field('Assessed by', source), field('Assessed on', on), warn);
  queueMicrotask(show);
  return { el, body: () => ({ level: level.value, source: source.value, levelOn: on.value }) };
}

function startDialog(personId, s, reload) {
  const o = s.options;
  const kind = select(Object.entries(o.kinds), 'Kind of stay');
  const here = select([['no', 'Offered, not moved in yet'], ['yes', 'Already living here']], 'Where things are', null);
  const room = h('input', { 'aria-label': 'Room', placeholder: 'e.g. Room 12' });
  const lv = levelFields(o);
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Who the place was offered to and how, e.g. "Phoned her daughter Anne; room 12 from Monday"' });
  dialog('Rest home place', h('div', { class: 'stack' },
    field('Kind of stay', kind), field('Where things are', here), field('Room', room), lv.el, field('Note', note),
    h('p', { class: 'small muted' }, RESEARCH),
  ), 'Save', async () => {
    await post(`/api/work/patients/${personId}/residency`, { kind: kind.value, here: here.value, room: room.value, note: note.value, ...lv.body() });
    toast('Saved.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/residency/${x.id}/${action}`, { note: note.value, ...body });
  const saved = () => { toast('Saved.'); reload(); };
  const simple = (title, label, placeholder, button = 'Save') => {
    note.placeholder = placeholder;
    return dialog(title, h('div', { class: 'stack' }, field(label, note)), button, async () => { await send({}); saved(); });
  };
  if (action === 'accept') return simple('Place accepted', 'Who accepted and when they move in', 'e.g. Anne accepted by phone; moving in Monday');
  if (action === 'decline') return simple('Place not taken', 'Who said no, and why if they said', 'e.g. Family chose a rest home closer to home');
  if (action === 'reassess') return simple('Ask for a reassessment', 'What has changed', 'e.g. Now needs two staff and the hoist for all transfers', 'Ask');
  if (action === 'back') return simple('Back from hospital', 'What changed while they were away', 'e.g. New walking frame; antibiotics for 5 more days. Care plan checked.');
  if (action === 'movein') {
    note.placeholder = 'Optional';
    const room = h('input', { 'aria-label': 'Room', value: x.room ?? '' });
    return dialog('Moved in', h('div', { class: 'stack' }, field('Room', room), field('Note', note)), 'Save', async () => { await send({ room: room.value }); saved(); });
  }
  if (action === 'level') {
    note.placeholder = 'Optional, e.g. "Letter from the needs assessment service"';
    const lv = levelFields(o, x);
    return dialog('New level of care', h('div', { class: 'stack' }, lv.el, field('Note', note), h('p', { class: 'small muted' }, RESEARCH)), 'Save', async () => { await send(lv.body()); saved(); });
  }
  if (action === 'hospital') {
    note.placeholder = 'e.g. Fall, hip pain, ambulance to ED';
    const where = h('input', { 'aria-label': 'Which hospital', placeholder: 'e.g. Waikato Hospital' });
    return dialog('Went to hospital', h('div', { class: 'stack' }, field('Which hospital', where), field('Why', note), h('p', { class: 'small muted' }, 'Their room is held while they are away.')),
      'Save', async () => { await send({ where: where.value }); saved(); });
  }
  note.placeholder = 'Where they went and who was told';
  const reason = select(Object.entries(o.end).filter(([k]) => k !== 'DIED'), 'Why they are leaving');
  return dialog('Leaving our care', h('div', { class: 'stack' }, field('Why they are leaving', reason), field('Note', note),
    h('p', { class: 'small muted' }, 'If they have died, record it on the End of life screen instead. Their stay ends with it.')),
  'Save', async () => { await send({ reason: reason.value }); saved(); });
}

function stayCard(x, o, reload) {
  const open = !['DECLINED', 'ENDED'].includes(x.state);
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' }, h('b', {}, `${x.kindLabel} place${x.room ? ` · ${x.room}` : ''}`),
      h('span', { class: `tag ${x.state === 'IN_HOSPITAL' ? 'warn' : x.state === 'LIVING_HERE' ? 'ok' : ''}` }, x.stateLabel)),
    h('div', {}, h('b', {}, 'Level of care: '), x.levelLabel,
      x.sourceLabel ? h('span', { class: 'small muted' }, ` (${x.sourceLabel}, ${fmtDate(x.levelOn)})`) : null),
    x.notProvided && open ? h('div', { class: 'small warn-text' }, `We do not provide ${x.levelLabel.toLowerCase()}. Plan a move with them and their whānau.`) : null,
    x.reassessAt ? h('div', { class: 'small warn-text' }, `Reassessment asked for ${fmtDate(x.reassessAt)}: ${x.reassessWhy}`) : null,
    x.state === 'IN_HOSPITAL' ? h('div', { class: 'small' }, h('b', {}, `In ${x.hospitalWhere} since ${fmtDateTime(x.hospitalAt)}`),
      ` (${x.daysAway === 0 ? 'today' : x.daysAway === 1 ? '1 day' : `${x.daysAway} days`}). ${x.hospitalWhy}`) : null,
    x.movedInAt ? h('div', { class: 'small muted' }, `Moved in ${fmtDate(x.movedInAt)}`) : null,
    x.endLabel ? h('div', { class: 'small' }, h('b', {}, `${x.endLabel} (${x.endedBy} ${fmtDate(x.endedAt)}): `), x.endNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'back' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// At the top of the person's Care level and time away view, above leave and outings.
export function residencyPanel(personId, s, reload) {
  if (!s || (!s.stay && !s.past.length && !s.canStart)) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Rest home place and care level'),
      s.canStart ? h('button', { class: 'btn small', onclick: () => startDialog(personId, s, reload) }, 'Record a place') : null),
    s.stay ? stayCard(s.stay, s.options, reload) : h('div', { class: 'empty' }, 'No rest home place recorded.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => stayCard(x, s.options, reload)))) : null,
  );
}
