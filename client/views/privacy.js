import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';
import { retentionSections } from './retention.js';

// Privacy requests: someone asks to see, correct or know about health information → who is asking
// is checked → decided with reasons → the answer is sent. SHIFT sets no time limit or grounds.
const TONE = { RECEIVED: 'danger', CHECKED: 'warn', DECIDED: 'warn', CLOSED: 'ok', WITHDRAWN: 'muted' };
const today = () => new Date().toISOString().slice(0, 10);

function logDialog(o, reload) {
  const nhi = h('input', { type: 'text', 'aria-label': 'NHI', placeholder: 'e.g. ZZZ0001', autocapitalize: 'characters' });
  const kind = select(Object.entries(o.kind), 'What they want');
  const who = select(Object.entries(o.who), 'Who is asking');
  const requester = h('input', { type: 'text', 'aria-label': 'Their name', placeholder: 'e.g. Mere Ngata, daughter' });
  const asked = h('textarea', { 'aria-label': 'What they asked for', placeholder: 'e.g. A copy of all notes from her stay in July' });
  const received = h('input', { type: 'date', 'aria-label': 'Received', value: today(), max: today() });
  const due = h('input', { type: 'date', 'aria-label': 'Answer due' });
  dialog('Log a request', h('div', { class: 'stack' },
    field('NHI of the person it is about', nhi), field('What they want', kind), field('Who is asking', who),
    field('Their name and connection (if not the person)', requester), field('What they asked for', asked),
    h('div', { class: 'row' }, field('Received', received), field('Answer due (optional)', due)),
    h('div', { class: 'small muted' }, 'SHIFT does not set the time limit. Enter the date your organisation is working to.')),
  'Save', async () => {
    await post('/api/work/privacy', { nhi: nhi.value, kind: kind.value, who: who.value, requester: requester.value, asked: asked.value, receivedOn: received.value, dueOn: due.value });
    toast('Logged.');
    reload();
  }, { wide: true });
}

function checkDialog(x, reload) {
  const identity = h('textarea', { 'aria-label': 'How you confirmed who is asking', placeholder: 'e.g. Photo ID seen at reception' });
  const authority = h('textarea', { 'aria-label': 'What shows they may ask', placeholder: 'e.g. Signed authority from the person, 2 October' });
  dialog('Check who is asking', h('div', { class: 'stack' }, field('How you confirmed who is asking', identity),
    x.who === 'SELF' ? null : field('What shows they may ask for this on the person\'s behalf', authority)), 'Save', async () => {
    await post(`/api/work/privacy/${x.id}/check`, { identity: identity.value, authority: authority.value });
    toast('Saved.');
    reload();
  });
}

function decideDialog(x, reload) {
  const decision = select(x.decisions, 'Decision');
  const note = h('textarea', { 'aria-label': 'What is being done and why', placeholder: x.kind === 'CORRECTION' ? 'e.g. Date of birth was wrong; corrected after checking with the person' : 'e.g. Sending everything except a note that names another patient, which is withheld' });
  const statement = h('textarea', { 'aria-label': 'Statement', placeholder: 'e.g. "I did not refuse the dressing; I asked for it later."' });
  const statementField = field('Their statement, to keep with the record', statement);
  const sync = () => { statementField.hidden = decision.value !== 'NOT_CORRECTED'; };
  decision.addEventListener('change', sync); sync();
  dialog('Decide', h('div', { class: 'stack' }, field('Decision', decision), field('What is being done, and why', note), statementField), 'Save', async () => {
    await post(`/api/work/privacy/${x.id}/decide`, { decision: decision.value, note: note.value, statement: statement.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function noteDialog(x, action, title, label, placeholder, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), 'Save', async () => {
    await post(`/api/work/privacy/${x.id}/${action}`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function card(x, reload) {
  const line = (label, v) => (v ? h('div', { class: 'small' }, h('b', {}, `${label} `), v) : null);
  return h('div', { class: `tile stack privacy ${x.overdue ? 'overdue' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, `${x.person} · ${x.kindLabel}`), h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? 'Answer overdue' : x.stateLabel)),
    h('div', { class: 'small muted' }, [`NHI ${x.nhi ?? 'none'}`, `${x.whoLabel}${x.requester ? `: ${x.requester}` : ''}`, `received ${fmtDate(x.receivedOn)}`, x.dueOn ? `due ${fmtDate(x.dueOn)}` : 'no due date set'].join(' · ')),
    h('div', { class: 'small' }, x.asked),
    line('Checked:', x.identityCheck ? `${x.identityCheck}${x.authorityCheck ? ` / ${x.authorityCheck}` : ''} (${x.checkedBy}, ${fmtDateTime(x.checkedAt)})` : null),
    line(`${x.decisionLabel ?? ''}:`, x.decision ? `${x.decisionNote} (${x.decidedBy}, ${fmtDateTime(x.decidedAt)})` : null),
    line('Statement kept with the record:', x.statement),
    line('Sent:', x.sentNote ? `${x.sentNote} (${x.closedBy}, ${fmtDateTime(x.closedAt)})` : null),
    line('Withdrawn:', x.withdrawnNote),
    x.actions.length ? h('div', { class: 'row' },
      x.actions.includes('check') ? h('button', { class: 'btn small primary', onclick: () => checkDialog(x, reload) }, 'Check who is asking') : null,
      x.actions.includes('decide') ? h('button', { class: 'btn small primary', onclick: () => decideDialog(x, reload) }, 'Decide') : null,
      x.actions.includes('send') ? h('button', { class: 'btn small primary', onclick: () => noteDialog(x, 'send', 'Answer sent', 'What was sent and how', 'e.g. Copy posted to the person, signed for', reload) }, 'Answer sent') : null,
      x.actions.includes('withdraw') ? h('button', { class: 'btn small', onclick: () => noteDialog(x, 'withdraw', 'Withdraw this request', 'Why', 'e.g. Person no longer wants it', reload) }, 'Withdraw') : null) : null,
  );
}

// Home → Privacy requests (privacy officer).
export async function privacyView() {
  const root = h('div');
  const load = async () => {
    const [d, r] = await Promise.all([get('/api/work/privacy'), get('/api/work/retention')]);
    const section = (title, rows, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${rows.length})`),
      rows.length ? rows.map((x) => card(x, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Privacy requests', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Requests to see, correct or know about someone\'s health information. You see the request and who it is about, not their clinical record.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => logDialog(d.options, load) }, 'Log a request')),
      section('To check', d.toCheck, 'Nothing waiting to be checked.'),
      section('To decide', d.toDecide, 'Nothing waiting for a decision.'),
      section('To send', d.toSend, 'Nothing waiting to be sent.'),
      section('Closed in the last fortnight', d.closed, 'Nothing closed recently.'),
      h('h2', { class: 'section-title' }, 'Records retention and legal holds'),
      ...retentionSections(r, load),
    );
  };
  await load();
  return root;
}
