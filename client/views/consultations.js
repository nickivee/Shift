import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, confirmDialog, pageTitle, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Consultation: advice from another team. The requesting team stays responsible; the
// consulted team receives, accepts or declines, and advises; the requesting team records
// that it received the advice and what it is doing with it.
const STEPS = ['REQUESTED', 'RECEIVED', 'ACCEPTED', 'ADVISED', 'ADVICE_RECEIVED', 'CLOSED'];
const LABEL = { REQUESTED: 'Requested', RECEIVED: 'Received', ACCEPTED: 'Accepted', ADVISED: 'Advice given', ADVICE_RECEIVED: 'Advice received', CLOSED: 'Closed', DECLINED: 'Declined', WITHDRAWN: 'Withdrawn' };
const TONE = { DECLINED: 'danger', WITHDRAWN: 'muted', CLOSED: 'ok', ADVISED: 'warn' };

function steps(c) {
  if (c.state === 'DECLINED' || c.state === 'WITHDRAWN') return null;
  const at = STEPS.indexOf(c.state);
  return h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, LABEL[s])));
}

const PROMPT = {
  accept: null,
  decline: { title: 'Decline this consultation', message: 'The requesting team will see your reason.', label: 'Reason, and where to ask instead', confirm: 'Decline', minLength: 5 },
  advise: { title: 'Give your advice', message: 'The requesting team stays responsible and decides what to do with it.', label: 'Advice or recommendation', confirm: 'Send advice', minLength: 10 },
  close: { title: 'Close this consultation', message: 'Record what your team is doing with the advice.', label: 'Actions', confirm: 'Close', minLength: 3 },
  withdraw: { title: 'Withdraw this request', message: 'The consulted team will see your reason.', label: 'Reason', confirm: 'Withdraw', minLength: 5 },
};

async function doAction(c, action, reload) {
  let body = {};
  if (PROMPT[action]) {
    const note = await ask({ ...PROMPT[action], multiline: true });
    if (!note) return;
    body = { note };
  } else if (action === 'accept') {
    if (!(await confirmDialog('Accept this consultation', `You will give ${c.fromService} your advice about ${c.patient}. They stay responsible for their care.`, 'Accept'))) return;
  }
  try {
    await post(`/api/work/consultations/${c.id}/${action}`, body);
    toast({ receive: 'Opened.', accept: 'Accepted.', decline: 'Declined.', advise: 'Advice sent.', acknowledge: 'Advice marked as received.', close: 'Consultation closed.', withdraw: 'Request withdrawn.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { receive: ['Open', true], accept: ['Accept', true], decline: ['Decline', false], advise: ['Give advice', true], acknowledge: ['Mark advice received', true], close: ['Close with actions', true], withdraw: ['Withdraw', false] };

export function consultationCard(c, reload, { showPatient = true } = {}) {
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${c.personId}/consults`) }, h('b', {}, c.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, [c.location, `${c.requestedBy}, ${c.fromService} → ${c.toRole}, ${c.toService}`].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        c.urgency === 'URGENT' ? h('span', { class: 'tag warn' }, 'Urgent') : null,
        h('span', { class: `tag ${TONE[c.state] ?? ''}` }, LABEL[c.state] ?? titleCase(c.state)),
      ),
    ),
    h('div', {}, h('b', {}, 'Question: '), c.sealed ? h('span', { class: 'muted' }, 'Open it to read the question.') : c.question),
    steps(c),
    c.advice ? h('div', { class: 'summary' }, h('b', {}, `Advice (${c.advisedBy}, ${fmtDateTime(c.advisedAt)}): `), c.advice) : null,
    c.declineReason ? h('div', { class: 'small' }, h('b', {}, 'Declined: '), c.declineReason) : null,
    c.followUp ? h('div', { class: 'small' }, h('b', {}, `Actions (${c.closedBy}): `), c.followUp) : null,
    h('div', { class: 'small muted' }, [
      `Requested ${fmtDateTime(c.requestedAt)}`,
      c.acceptedBy ? `accepted by ${c.acceptedBy}` : c.receivedBy ? `opened by ${c.receivedBy}` : null,
      c.adviceReceivedBy ? `advice received by ${c.adviceReceivedBy}` : null,
    ].filter(Boolean).join(' · ')),
    c.actions.length ? h('div', { class: 'row' }, c.actions.map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => doAction(c, a, reload) }, ACTION[a][0]))) : null,
  );
}

// The patient's Consultations view inside the Live Workstation.
export function consultationsPanel(personId, d, reload) {
  const form = () => {
    const to = h('select', {}, d.targets.map((t) => h('option', { value: t.id }, t.label)));
    const question = h('textarea', { placeholder: 'The question you want answered' });
    const urgent = h('input', { type: 'checkbox' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/consultations`, { target: to.value, question: question.value, urgency: urgent.checked ? 'URGENT' : 'ROUTINE' });
        toast('Consultation requested. You stay responsible for this patient.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Ask for advice'),
      h('label', { class: 'field' }, 'Ask', to),
      h('label', { class: 'field' }, 'Question', question),
      h('label', { class: 'check' }, urgent, 'Urgent'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Request consultation')),
    );
  };
  return h('div', { class: 'stack' },
    d.canRequest ? form() : null,
    d.consultations.length ? d.consultations.map((c) => consultationCard(c, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No consultations for this patient.'),
  );
}

// Home → Consultations.
export async function consultationsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/consultations');
    const open = (c) => !['CLOSED', 'DECLINED', 'WITHDRAWN'].includes(c.state);
    const toUs = rows.filter((c) => open(c) && c.incoming);
    const ours = rows.filter((c) => open(c) && !c.incoming);
    const closed = rows.filter((c) => !open(c));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((c) => consultationCard(c, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Consultations', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Advice from another team. The team that asks stays responsible for the patient, and records what it does with the advice.'),
      rows.some((c) => c.incoming) ? section('Asked of us', toUs, 'Nothing waiting for your advice.') : null,
      section('We asked', ours, 'No open requests for advice.'),
      closed.length ? section('Closed today', closed, '') : null,
    );
  };
  await load();
  return root;
}
