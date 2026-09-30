import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Complaints: received → acknowledged and looked into → responded to → closed, with "not
// satisfied" sending it back. Kept apart from the clinical record: nothing shows on the record's
// header, and their care must not change because they complained. Timeframes are RR-COMPLAINT-001.
const PRIVATE = 'Complaints are kept apart from their clinical record. Only nurses and doctors who handle complaints can read them. Their care must not change because they complained.';
const RESEARCH = 'The timeframes for acknowledging and replying are still being researched (RR-COMPLAINT-001). Tell them when they will hear back, and keep to it.';
const LABEL = { acknowledge: 'Acknowledge', note: 'Add what you found', update: 'Tell them how it is going', respond: 'Respond', notSatisfied: 'Not satisfied', close: 'Close' };
const days = (n) => `In ${n} days`;

function receiveDialog(personId, s, reload) {
  const o = s.options;
  const from = select(Object.entries(o.from), 'Who is complaining');
  const name = h('input', { 'aria-label': 'Their name', placeholder: 'e.g. Anne (daughter)' });
  const contact = h('input', { 'aria-label': 'How to reach them', placeholder: 'Phone or email' });
  const how = select(Object.entries(o.how), 'How it came in');
  const about = select(Object.entries(o.about), 'Mostly about');
  const words = h('textarea', { 'aria-label': 'The complaint', placeholder: 'What they said, in their words where you can' });
  const wants = h('input', { 'aria-label': 'What they want to happen', placeholder: 'e.g. An apology and the bell answered faster at night' });
  dialog('Take in a complaint', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Everyone has the right to complain. Thank them, write it down in their words, and tell them the nurse in charge will be in touch.'),
    field('Who is complaining', from), field('Their name', name), field('How to reach them', contact), field('How it came in', how),
    field('Mostly about', about), field('The complaint', words), field('What they want to happen', wants),
    h('p', { class: 'small muted' }, PRIVATE),
  ), 'Save complaint', async () => {
    await post(`/api/work/patients/${personId}/complaints`, { fromKind: from.value, fromName: name.value, contact: contact.value, how: how.value, about: about.value, words: words.value, wants: wants.value });
    toast(s.canManage ? 'Saved.' : 'Saved. The nurse in charge has been asked to acknowledge it.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/complaints/${x.id}/${action}`, { note: note.value, ...body });
  const saved = () => { toast('Saved.'); reload(); };
  const reply = () => select(o.replyDays.map((n) => [String(n), days(n)]), 'They will hear back', null);
  if (action === 'acknowledge') {
    note.placeholder = 'Optional, e.g. "Phoned Anne; she would like a meeting"';
    const how = select(Object.entries(o.ackHow), 'How you acknowledged it');
    const advocacy = select([['yes', 'Yes'], ['no', 'Not yet']], 'Told about the free advocacy service', null);
    const due = reply();
    return dialog('Acknowledge the complaint', h('div', { class: 'stack' },
      field('How you acknowledged it', how), field('Told about the free advocacy service', advocacy), field('They will hear back', due), field('Note', note),
      h('p', { class: 'small muted' }, 'You become the person handling it. ' + RESEARCH),
    ), 'Acknowledge', async () => { await send({ ackHow: how.value, advocacy: advocacy.value, replyDays: Number(due.value) }); saved(); });
  }
  if (action === 'note') {
    note.placeholder = 'e.g. Spoke with the night staff; the call bell log shows 25 minutes';
    return dialog('Add what you found', h('div', { class: 'stack' }, field('What you did or found', note)), 'Save', async () => { await send({}); saved(); });
  }
  if (action === 'update' || action === 'notSatisfied') {
    note.placeholder = action === 'update' ? 'What you told them and why it is taking longer' : 'What they are still unhappy about';
    const due = reply();
    return dialog(action === 'update' ? 'Tell them how it is going' : 'Not satisfied', h('div', { class: 'stack' },
      field(action === 'update' ? 'What you told them' : 'What they are unhappy about', note), field('They will hear back', due)),
    'Save', async () => { await send({ replyDays: Number(due.value) }); saved(); });
  }
  if (action === 'respond') {
    const response = h('textarea', { 'aria-label': 'Your response', placeholder: 'What you found, any apology, and what will change' });
    return dialog('Respond', h('div', { class: 'stack' }, field('Your response', response)), 'Save response', async () => { await send({ response: response.value }); saved(); });
  }
  note.placeholder = 'What was agreed with them';
  const outcome = select(Object.entries(o.outcome).filter(([k]) => x.state === 'RESPONDED' || ['WITHDRAWN', 'ERROR'].includes(k)), 'How it ended');
  const change = h('textarea', { 'aria-label': 'What we are changing', placeholder: 'Optional, e.g. Night call bells checked at each handover' });
  return dialog('Close the complaint', h('div', { class: 'stack' }, field('How it ended', outcome), field('What was agreed', note), field('What we are changing', change)),
    'Close complaint', async () => { await send({ outcome: outcome.value, change: change.value }); saved(); });
}

export function complaintCard(x, o, reload, showPatient) {
  if (!x.full) {
    return h('div', { class: 'tile stack complaint' },
      h('div', { class: 'spread' }, h('b', {}, `Complaint: ${x.aboutLabel}`), h('span', { class: 'tag' }, x.stateLabel)),
      h('div', { class: 'small' }, x.words),
      h('div', { class: 'small muted' }, `You took this in ${fmtDateTime(x.receivedAt)}. The nurse in charge handles it from here.`));
  }
  const tone = x.overdue || x.state === 'RECEIVED' ? 'warn' : x.state === 'CLOSED' ? '' : 'paua';
  return h('div', { class: 'tile stack complaint' },
    h('div', { class: 'spread' }, h('b', {}, `${showPatient ? `${x.patient}: ` : ''}${x.aboutLabel}`),
      h('span', { class: `tag ${tone}` }, x.overdue ? 'Reply date passed' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `${x.fromName ?? x.fromLabel}, ${x.howLabel.toLowerCase()}: `), x.words),
    x.wants ? h('div', { class: 'small' }, h('b', {}, 'What they want: '), x.wants) : null,
    x.contact ? h('div', { class: 'small' }, h('b', {}, 'Contact: '), x.contact) : null,
    x.state === 'RECEIVED' ? h('div', { class: 'small warn-text' }, x.waitingDays ? `Not acknowledged yet, ${x.waitingDays} day${x.waitingDays === 1 ? '' : 's'} after it came in.` : 'Not acknowledged yet.') : null,
    x.handler ? h('div', { class: 'small muted' }, `Handled by ${x.handler}${x.replyBy && x.state !== 'CLOSED' ? ` · reply by ${fmtDate(x.replyBy)}` : ''}${x.advocacy === 0 ? ' · not yet told about advocacy' : ''}`) : null,
    h('div', { class: 'small muted' }, `Taken in by ${x.receivedBy} ${fmtDateTime(x.receivedAt)}`),
    x.change ? h('div', { class: 'small' }, h('b', {}, 'What we are changing: '), x.change) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'acknowledge' || a === 'respond' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `What happened (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// Inside the person's Incidents, complaints and safeguarding view, between incidents and safeguarding.
export function complaintsPanel(personId, s, reload) {
  if (!s || (!s.canRecord && !s.complaints.length)) return null;
  const open = s.complaints.filter((x) => x.state !== 'CLOSED');
  const closed = s.complaints.filter((x) => x.state === 'CLOSED');
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Complaints'),
      s.canRecord ? h('button', { class: 'btn small', onclick: () => receiveDialog(personId, s, reload) }, 'Take in a complaint') : null),
    s.canManage ? h('p', { class: 'small muted' }, PRIVATE) : null,
    open.length ? open.map((x) => complaintCard(x, s.options, reload)) : h('div', { class: 'empty' }, s.canManage ? 'No open complaints.' : 'No open complaints that you took in.'),
    closed.length ? h('details', {}, h('summary', { class: 'small' }, `Closed (${closed.length})`), h('div', { class: 'stack' }, closed.map((x) => complaintCard(x, s.options, reload)))) : null,
  );
}
