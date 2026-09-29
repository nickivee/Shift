import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, confirmDialog, pageTitle, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Referral: asking another service to take the person on. Drafted, authorised and sent by
// the referring service; received, triaged, accepted, declined or redirected, booked and
// seen by the receiving service, which may accept responsibility and records the outcome;
// the referring service reads the outcome and closes it.
const STEPS = ['DRAFT', 'AUTHORISED', 'SENT', 'RECEIVED', 'TRIAGED', 'ACCEPTED', 'SCHEDULED', 'SEEN', 'OUTCOME_RECORDED', 'CLOSED'];
const LABEL = {
  DRAFT: 'Draft', AUTHORISED: 'Authorised', SENT: 'Sent', RECEIVED: 'Received', TRIAGED: 'Triaged', ACCEPTED: 'Accepted', SCHEDULED: 'Booked',
  SEEN: 'Seen', RESPONSIBILITY_ACCEPTED: 'On caseload', OUTCOME_RECORDED: 'Outcome', CLOSED: 'Closed', DECLINED: 'Declined', REDIRECTED: 'Redirected', CANCELLED: 'Cancelled',
};
const TONE = { DECLINED: 'danger', CANCELLED: 'muted', REDIRECTED: 'muted', CLOSED: 'ok', OUTCOME_RECORDED: 'warn', DRAFT: 'warn' };
const PRIORITY = { URGENT: 'Urgent', SEMI_URGENT: 'Semi-urgent', ROUTINE: 'Routine' };

function steps(r) {
  if (['DECLINED', 'REDIRECTED', 'CANCELLED'].includes(r.state)) return null;
  // Booking is shown only where it applies: before it, or when the patient was booked.
  const list = STEPS.filter((s) => s !== 'SCHEDULED' || r.scheduledFor || ['DRAFT', 'AUTHORISED', 'SENT', 'RECEIVED', 'TRIAGED', 'ACCEPTED'].includes(r.state));
  const at = list.indexOf(r.state === 'RESPONSIBILITY_ACCEPTED' ? 'OUTCOME_RECORDED' : r.state);
  return h('ol', { class: 'steps' }, list.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, LABEL[s])));
}

const priorityPicker = (value = 'ROUTINE') => {
  const sel = h('select', {}, Object.entries(PRIORITY).map(([k, v]) => h('option', { value: k }, v)));
  sel.value = value;
  return sel;
};

const PROMPT = {
  decline: { title: 'Decline this referral', message: 'The referring team will see your reason.', label: 'Reason, and what they could do instead', confirm: 'Decline', minLength: 5 },
  seen: { title: 'Patient seen or contacted', message: 'Record how and where.', label: 'Seen', confirm: 'Save', minLength: 3 },
  outcome: { title: 'Record the outcome', message: 'The referring team reads this before closing the referral.', label: 'Outcome', confirm: 'Send outcome', minLength: 5 },
  cancel: { title: 'Cancel this referral', message: 'The receiving service will see your reason.', label: 'Reason', confirm: 'Cancel referral', minLength: 5 },
};
const DONE = {
  authorise: 'Authorised. Send it when ready.', send: 'Referral sent.', receive: 'Opened.', triage: 'Triaged.', accept: 'Accepted.', decline: 'Declined.',
  redirect: 'Redirected.', schedule: 'Booked.', seen: 'Recorded as seen.', responsibility: 'On your caseload.', outcome: 'Outcome sent.', close: 'Referral closed.', cancel: 'Referral cancelled.',
};

async function doAction(r, action, reload) {
  const send = async (body = {}) => {
    await post(`/api/work/referrals/${r.id}/${action}`, body);
    toast(DONE[action]);
    reload();
  };
  try {
    if (action === 'triage') {
      const priority = priorityPicker(r.priority);
      const note = h('textarea', { placeholder: 'Optional' });
      return dialog('Triage this referral', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `${r.fromService} asked for ${PRIORITY[r.priority].toLowerCase()}. Your service sets the priority.`),
        h('label', { class: 'field' }, 'Priority', priority),
        h('label', { class: 'field' }, 'Triage note', note),
      ), 'Save triage', () => send({ priority: priority.value, note: note.value }));
    }
    if (action === 'redirect') {
      const to = h('select', {}, r.redirectTargets.map((t) => h('option', { value: t.id }, t.label)));
      const note = h('textarea', {});
      return dialog('Redirect this referral', h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `It goes to the other service as sent. ${r.fromService} is told and stays the referrer.`),
        h('label', { class: 'field' }, 'Redirect to', to),
        h('label', { class: 'field' }, 'Why', note),
      ), 'Redirect', () => send({ to: to.value, note: note.value }));
    }
    if (action === 'schedule') {
      const when = h('input', { type: 'datetime-local' });
      if (r.scheduledFor) when.value = r.scheduledFor;
      return dialog(r.scheduledFor ? 'Change the booking' : 'Book the patient in', h('label', { class: 'field' }, 'When', when), 'Book', () => send({ when: when.value }));
    }
    if (PROMPT[action]) {
      const note = await ask({ ...PROMPT[action], multiline: true });
      if (!note) return;
      return await send({ note });
    }
    if (action === 'accept' && !(await confirmDialog('Accept this referral', `Your service will see ${r.patient}. ${r.fromService} stays responsible until you accept responsibility.`, 'Accept'))) return;
    if (action === 'responsibility' && !(await confirmDialog('Accept responsibility', `${r.patient} joins your caseload and your service keeps access to the record.`, 'Accept responsibility'))) return;
    if (action === 'close' && !(await confirmDialog('Close this referral', 'You have read the outcome.', 'Close'))) return;
    await send();
  } catch (err) { showError(err); }
}

const ACTION = {
  authorise: ['Authorise', true], send: ['Send', true], receive: ['Open', true], triage: ['Triage', true], accept: ['Accept', true],
  redirect: ['Redirect', false], decline: ['Decline', false], schedule: ['Book', false], seen: ['Mark seen', true],
  responsibility: ['Accept responsibility', true], outcome: ['Record outcome', true], close: ['Read and close', true], cancel: ['Cancel', false],
};

export function referralCard(r, reload, { showPatient = true } = {}) {
  const priority = r.triagePriority ?? r.priority;
  const actions = r.actions.map((a) => (a === 'schedule' && r.state === 'SCHEDULED' ? { a, label: 'Change booking' } : { a, label: ACTION[a][0] }));
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${r.personId}/referrals`) }, h('b', {}, r.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, [r.location, `${r.fromService} → ${r.toService}`].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        priority !== 'ROUTINE' ? h('span', { class: 'tag warn' }, PRIORITY[priority]) : null,
        h('span', { class: `tag ${TONE[r.state] ?? ''}` }, LABEL[r.state] ?? titleCase(r.state)),
      ),
    ),
    r.redirectedFrom ? h('div', { class: 'small muted' }, `Redirected from ${r.redirectedFrom}`) : null,
    r.sealed ? h('div', { class: 'muted' }, 'Open it to read the referral.') : [
      h('div', {}, h('b', {}, 'Reason: '), r.reason),
      h('div', {}, h('b', {}, 'Asking for: '), r.request),
      r.evidence.length ? h('details', {}, h('summary', {}, `Attached from the record (${r.evidence.length})`),
        h('ul', { class: 'stack small' }, r.evidence.map((e) => h('li', {}, h('b', {}, `${titleCase(e.category)}, ${fmtDateTime(e.at)}${e.amended ? ' (amended)' : ''}: `), e.text)))) : null,
    ],
    steps(r),
    r.triageNote ? h('div', { class: 'small' }, h('b', {}, `Triage (${r.triagedBy}): `), r.triageNote) : null,
    r.scheduledFor && ['SCHEDULED', 'ACCEPTED'].includes(r.state) ? h('div', {}, h('b', {}, 'Booked: '), fmtDateTime(r.scheduledFor)) : null,
    r.decisionNote ? h('div', { class: 'small' }, h('b', {}, `${r.state === 'DECLINED' ? 'Declined' : r.state === 'REDIRECTED' ? `Redirected to ${r.redirectedTo}` : 'Accepted'} (${r.decidedBy}): `), r.decisionNote) : null,
    r.seenNote ? h('div', { class: 'small' }, h('b', {}, `Seen (${r.seenBy}, ${fmtDateTime(r.seenAt)}): `), r.seenNote) : null,
    r.responsibilityBy ? h('div', { class: 'small' }, `${r.toService} accepted responsibility (${r.responsibilityBy}).`) : null,
    r.outcome ? h('div', { class: 'summary' }, h('b', {}, `Outcome (${r.outcomeBy}, ${fmtDateTime(r.outcomeAt)}): `), r.outcome) : null,
    h('div', { class: 'small muted' }, [
      `Written by ${r.draftedBy} ${fmtDateTime(r.draftedAt)}`,
      r.authorisedBy ? `authorised by ${r.authorisedBy}` : 'not yet authorised',
      r.patientAware ? 'patient aware' : 'patient not yet told',
      r.receivedBy ? `opened by ${r.receivedBy}` : null,
      r.closedBy ? `closed by ${r.closedBy}` : null,
    ].filter(Boolean).join(' · ')),
    actions.length ? h('div', { class: 'row' }, actions.map(({ a, label }) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => doAction(r, a, reload) }, label))) : null,
  );
}

// The patient's Referrals view inside the Live Workstation.
export function referralsPanel(personId, d, reload) {
  const form = () => {
    const to = h('select', {}, d.targets.map((t) => h('option', { value: t.id }, t.label)));
    const reason = h('textarea', { placeholder: 'Clinical reason and relevant background' });
    const request = h('textarea', { placeholder: 'What you are asking the service to do' });
    const priority = priorityPicker();
    const aware = h('input', { type: 'checkbox' });
    const picks = d.events.map((e) => ({ e, box: h('input', { type: 'checkbox', value: e.lineageId }) }));
    const submit = async (send) => {
      try {
        await post(`/api/work/patients/${personId}/referrals`, {
          to: to.value, reason: reason.value, request: request.value, priority: priority.value, patientAware: aware.checked, send,
          evidence: picks.filter((p) => p.box.checked).map((p) => p.e.lineageId),
        });
        toast(send ? 'Referral sent.' : 'Draft saved. It needs authorising before it can be sent.');
        reload();
      } catch (err) { showError(err); }
    };
    return h('form', { class: 'tile stack', onsubmit: (e) => { e.preventDefault(); submit(d.canAuthorise); } },
      h('h3', {}, 'Refer to another service'),
      h('label', { class: 'field' }, 'Refer to', to),
      h('label', { class: 'field' }, 'Reason', reason),
      h('label', { class: 'field' }, 'Asking for', request),
      h('label', { class: 'field' }, 'Priority', priority),
      h('label', { class: 'check' }, aware, 'Patient or whānau know about this referral'),
      picks.length ? h('details', {}, h('summary', {}, 'Attach entries from the record'),
        h('p', { class: 'small muted' }, 'Entries go as references to the record, not copies, so the service always sees the current version.'),
        h('div', { class: 'stack small' }, picks.map(({ e, box }) => h('label', { class: 'check' }, box, `${titleCase(e.category)}, ${fmtDateTime(e.at)}: ${e.text.slice(0, 90)}`)))) : null,
      h('div', { class: 'row' },
        d.canAuthorise ? h('button', { class: 'btn primary', type: 'submit' }, 'Authorise and send') : null,
        h('button', { class: `btn${d.canAuthorise ? '' : ' primary'}`, type: 'button', onclick: () => submit(false) }, d.canAuthorise ? 'Save as draft' : 'Save draft for authorising'),
      ),
    );
  };
  return h('div', { class: 'stack' },
    d.canRequest ? form() : null,
    d.referrals.length ? d.referrals.map((r) => referralCard(r, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No referrals for this patient.'),
  );
}

// Home → Referrals.
export async function referralsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/referrals');
    const open = (r) => !['CLOSED', 'DECLINED', 'REDIRECTED', 'CANCELLED'].includes(r.state);
    const toUs = rows.filter((r) => open(r) && r.incoming);
    const ours = rows.filter((r) => open(r) && !r.incoming);
    const closed = rows.filter((r) => !open(r));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((r) => referralCard(r, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Referrals', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Asking another service to take a patient on. The referring team stays responsible until the receiving service accepts responsibility.'),
      rows.some((r) => r.incoming) ? section('Sent to us', toUs, 'No referrals waiting.') : null,
      ours.length || !rows.some((r) => r.incoming) ? section('Our referrals', ours, 'No open referrals from your service.') : null,
      closed.length ? section('Finished today', closed, '') : null,
    );
  };
  await load();
  return root;
}
