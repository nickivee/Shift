import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Isolation precautions: concern → precautions chosen → in place, and where → reviewed by a set time →
// changed → stopped with a reason. Outbreaks: declared → cases and contacts → what the service did →
// closed. Which precautions an infection needs is the organisation's policy (RR-IPC-001).
const TONE = { REQUIRED: 'danger', IN_PLACE: 'warn', CEASED: 'muted' };
const PTONE = { CASE: 'danger', WATCHING: 'warn', RECOVERED: 'ok', CLEARED: 'ok', BECAME_CASE: 'danger' };
const POLICY = 'Which precautions an infection needs, and when they can stop, is your infection prevention policy. What New Zealand requires is still being researched (RR-IPC-001).';
const hours = (n) => (n < 48 ? `In ${n} hours` : `In ${n / 24} days`);

function typeBoxes(types, chosen = []) {
  const boxes = Object.entries(types).map(([k, v]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: chosen.includes(k), 'aria-label': v }), h('span', {}, v)));
  return { el: h('fieldset', { class: 'row' }, h('legend', {}, 'Precautions'), boxes), value: () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value) };
}
const roomSelect = (rooms, value) => { const s = select(Object.entries(rooms), 'Where they need to be'); if (value) s.value = value; return s; };
const reviewSelect = (o) => select(o.reviewHours.map((n) => [String(n), hours(n)]), 'Review', null);

function startDialog(personId, d, reload) {
  const o = d.options;
  const concern = h('textarea', { 'aria-label': 'The concern', placeholder: 'e.g. Diarrhoea and vomiting since last night' });
  const types = typeBoxes(o.types);
  const room = roomSelect(o.rooms);
  const review = reviewSelect(o);
  const infection = select(d.infections.map((i) => [i.id, i.suspicion]), 'Linked infection', 'None');
  const outbreak = select(d.outbreaks.map((x) => [x.id, x.what]), 'Part of an outbreak', 'No');
  dialog('Start isolation precautions', h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, POLICY),
    field('What is the concern?', concern), types.el, field('Where they need to be', room), field('Look at them again', review),
    d.infections.length ? field('Linked infection', infection) : null,
    d.outbreaks.length ? field('Part of an outbreak', outbreak) : null,
  ), 'Start precautions', async () => {
    await post(`/api/work/patients/${personId}/precautions`, { concern: concern.value, types: types.value(), room: room.value, reviewHours: Number(review.value), infectionId: infection.value, outbreakId: outbreak.value });
    toast('Precautions started. Say when they are in place.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/precautions/${x.id}/${action}`, { note: note.value, ...body });
  if (action === 'place') {
    note.placeholder = 'e.g. Side room 2, sign on door, gowns and gloves at the door';
    return dialog('Precautions in place', h('div', { class: 'stack' }, field('Where they are and what is in place', note)), 'Save', async () => { await send({}); toast('In place.'); reload(); });
  }
  if (action === 'review') {
    note.placeholder = 'e.g. Still loose stools; flu swab pending';
    const review = reviewSelect(o);
    return dialog('Review precautions', h('div', { class: 'stack' }, field('What you found', note), field('Look again', review)), 'Save review', async () => {
      await send({ reviewHours: Number(review.value) }); toast('Reviewed.'); reload();
    });
  }
  if (action === 'change') {
    note.placeholder = 'e.g. Flu confirmed; droplet precautions added';
    const types = typeBoxes(o.types, x.typeList);
    const room = roomSelect(o.rooms, x.room);
    return dialog('Change precautions', h('div', { class: 'stack' }, types.el, field('Where they need to be', room), field('Why they are changing', note)), 'Save change', async () => {
      await send({ types: types.value(), room: room.value }); toast('Changed.'); reload();
    });
  }
  note.placeholder = 'e.g. 48 hours without symptoms, as the policy says';
  const reason = select(Object.entries(o.cease), 'Why they are stopping');
  return dialog('Stop precautions', h('div', { class: 'stack' }, h('p', { class: 'small muted' }, POLICY), field('Why they are stopping', reason), field('What the decision was based on', note)), 'Stop precautions', async () => {
    await send({ reason: reason.value }); toast('Stopped.'); reload();
  });
}

const LABEL = { place: 'In place', review: 'Review', change: 'Change', stop: 'Stop' };

export function precautionCard(x, o, reload, showPatient = false) {
  return h('div', { class: `tile stack precaution pc-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, showPatient ? h('div', {}, h('b', {}, x.patient), x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
        h('b', {}, `${x.typesLabel} precautions`), h('div', { class: 'small' }, x.roomLabel)),
      h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state] ?? ''}` }, x.overdue ? 'Review overdue' : x.stateLabel)),
    h('div', { class: 'small' }, x.concern),
    x.infectionSuspicion ? h('div', { class: 'small muted' }, `Infection: ${x.infectionSuspicion}`) : null,
    x.outbreak ? h('div', { class: 'small muted' }, `Outbreak: ${x.outbreak}`) : null,
    x.placeNote ? h('div', { class: 'small' }, h('b', {}, 'In place: '), `${x.placeNote} (${x.placedBy} ${fmtDateTime(x.placedAt)})`) : null,
    (() => { const r = x.log.filter((s) => s.kind === 'REVIEWED').at(-1); return r ? h('div', { class: 'small' }, h('b', {}, 'Last review: '), `${r.body} (${r.by} ${fmtDateTime(r.at)})`) : null; })(),
    x.state !== 'CEASED' && x.reviewDue ? h('div', { class: 'small muted' }, `Review by ${fmtDateTime(x.reviewDue)}`) : null,
    x.ceaseNote ? h('div', { class: 'small' }, h('b', {}, `${x.ceaseLabel} (${x.ceasedBy}): `), x.ceaseNote) : null,
    o && x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'place' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// Inside the person's Infections and isolation view.
export function isolationPanel(personId, d, reload) {
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Isolation precautions'),
      d.canManage ? h('button', { class: 'btn small', onclick: () => startDialog(personId, d, reload) }, 'Start precautions') : null),
    d.active.length ? d.active.map((x) => precautionCard(x, d.options, reload)) : h('div', { class: 'card empty' }, 'No isolation precautions.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Stopped (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => precautionCard(x, d.options, reload)))) : null,
  );
}

// Outbreaks ------------------------------------------------------------------------------------

function declareDialog(reload) {
  const what = h('input', { type: 'text', 'aria-label': 'What it is', placeholder: 'e.g. Gastroenteritis (suspected norovirus)' });
  const why = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Three residents vomiting within 24 hours' });
  dialog('Declare an outbreak', h('div', { class: 'stack' }, h('p', { class: 'small muted' }, POLICY), field('What it is', what), field('Why you are declaring it', why)), 'Declare outbreak', async () => {
    await post('/api/work/outbreaks', { what: what.value, note: why.value }); toast('Outbreak declared.'); reload();
  });
}

function addPersonDialog(x, residents, reload) {
  const who = select(residents.map((r) => [r.id, r.name]), 'Who');
  const role = select([['CASE', 'Ill (a case)'], ['CONTACT', 'Exposed (a contact to watch)']], 'Ill or exposed', null);
  const exposure = h('textarea', { 'aria-label': 'How', placeholder: 'e.g. Vomiting since 03:00' });
  const days = h('input', { type: 'number', min: 1, max: 21, 'aria-label': 'Days to watch', placeholder: 'e.g. 2' });
  const daysField = field('Days to watch them', days);
  const sync = () => {
    daysField.hidden = role.value !== 'CONTACT';
    exposure.placeholder = role.value === 'CONTACT' ? 'e.g. Shares a table with William at meals' : 'e.g. Vomiting since 03:00';
  };
  role.addEventListener('change', sync);
  sync();
  dialog(`Add to: ${x.what}`, h('div', { class: 'stack' }, field('Who', who), field('Ill or exposed', role), field('How', exposure), daysField), 'Add', async () => {
    await post(`/api/work/outbreaks/${x.id}/add`, { personId: who.value, role: role.value, exposure: exposure.value, watchDays: Number(days.value) });
    toast('Added.'); reload();
  });
}

function personDialog(x, p, to, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: to === 'BECAME_CASE' ? 'e.g. Vomited at 06:00' : 'e.g. No symptoms for 48 hours' });
  const title = { RECOVERED: 'Recovered', CLEARED: 'No illness', BECAME_CASE: 'Now ill' }[to];
  dialog(`${p.patient}: ${title.toLowerCase()}`, h('div', { class: 'stack' }, field('What it is based on', note)), 'Save', async () => {
    await post(`/api/work/outbreaks/${x.id}/person`, { entryId: p.id, to, note: note.value }); toast('Saved.'); reload();
  });
}

function noteDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: action === 'close' ? 'e.g. No new cases for 72 hours; clean completed' : 'e.g. Dining room closed; meals in rooms' });
  dialog(action === 'close' ? `Close: ${x.what}` : 'What the service has done', h('div', { class: 'stack' }, field(action === 'close' ? 'Why it is over, and what was learned' : 'What was done', note)),
    action === 'close' ? 'Close outbreak' : 'Save', async () => {
      await post(`/api/work/outbreaks/${x.id}/${action}`, { note: note.value }); toast(action === 'close' ? 'Outbreak closed.' : 'Saved.'); reload();
    });
}

function outbreakCard(x, residents, reload) {
  const NEXT = { CASE: [['RECOVERED', 'Recovered']], WATCHING: [['CLEARED', 'No illness'], ['BECAME_CASE', 'Now ill']] };
  return h('div', { class: `tile stack outbreak ob-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, x.what), h('span', { class: `tag ${x.state === 'DECLARED' ? 'danger' : 'ok'}` }, x.stateLabel)),
    h('div', { class: 'small muted' }, [`Declared by ${x.declaredBy} ${fmtDateTime(x.declaredAt)}`, x.closedAt ? `closed by ${x.closedBy} ${fmtDateTime(x.closedAt)}` : null].filter(Boolean).join(' · ')),
    h('div', { class: 'small' }, `${x.cases} ${x.cases === 1 ? 'case' : 'cases'} · ${x.watching} ${x.watching === 1 ? 'contact' : 'contacts'} being watched`),
    x.people.length ? h('ul', { class: 'stack ob-people' }, x.people.map((p) => h('li', { class: 'spread' },
      h('div', {}, h('b', {}, p.patient), p.location ? h('span', { class: 'small muted' }, ` · ${p.location}`) : null,
        h('div', { class: 'small muted' }, [p.exposure, p.watchUntil && p.state === 'WATCHING' ? `watch until ${fmtDateTime(p.watchUntil)}` : null, p.endNote ? `${p.endedBy}: ${p.endNote}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'row' }, h('span', { class: `tag ${p.overdue ? 'danger' : PTONE[p.state] ?? ''}` }, p.overdue ? 'Watch time over' : p.stateLabel),
        x.canManage ? (NEXT[p.state] ?? []).map(([to, label]) => h('button', { class: 'btn small', onclick: () => personDialog(x, p, to, reload) }, label)) : null)))) : null,
    x.closeNote ? h('div', { class: 'small' }, h('b', {}, 'Closed: '), x.closeNote) : null,
    x.canManage ? h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: () => addPersonDialog(x, residents, reload) }, 'Add a case or contact'),
      h('button', { class: 'btn small', onclick: () => noteDialog(x, 'response', reload) }, 'What was done'),
      h('button', { class: 'btn small', onclick: () => noteDialog(x, 'close', reload) }, 'Close')) : null,
    h('details', {}, h('summary', { class: 'small' }, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// Home → Infections: precautions across the service, and outbreaks.
export function isolationSections(d, reload) {
  const open = d.outbreaks.filter((x) => x.state === 'DECLARED');
  const closed = d.outbreaks.filter((x) => x.state !== 'DECLARED');
  return [
    h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Outbreaks (${open.length})`),
      d.canDeclare ? h('div', {}, h('button', { class: 'btn danger', onclick: () => declareDialog(reload) }, 'Declare an outbreak')) : null,
      open.length ? open.map((x) => outbreakCard(x, d.residents, reload)) : h('div', { class: 'card empty' }, 'No outbreak in your service.'),
      closed.length ? h('details', {}, h('summary', {}, `Closed in the last 14 days (${closed.length})`), h('div', { class: 'stack' }, closed.map((x) => outbreakCard(x, d.residents, reload)))) : null),
    h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Isolation precautions (${d.precautions.length})`),
      d.precautions.length ? d.precautions.map((x) => precautionCard(x, null, reload, true)) : h('div', { class: 'card empty' }, 'Nobody in isolation.')),
  ];
}
