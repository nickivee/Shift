import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Escalation: raised → received → acknowledged → response → reassessed (resolved or
// escalated further). SHIFT shows how long it has been open; it sets no targets itself.
const STEPS = ['RAISED', 'RECEIVED', 'ACKNOWLEDGED', 'RESPONDED'];
const STEP_LABEL = { RAISED: 'Raised', RECEIVED: 'Received', ACKNOWLEDGED: 'Acknowledged', RESPONDED: 'Responded', RESOLVED: 'Resolved', ESCALATED: 'Escalated further' };
const URGENCY_TONE = { IMMEDIATE: 'danger', URGENT: 'warn', ROUTINE: '' };

const since = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function steps(x) {
  if (x.state === 'RESOLVED' || x.state === 'ESCALATED') return null;
  const at = STEPS.indexOf(x.state);
  return h('ol', { class: 'steps' }, [...STEPS, 'Reassessed'].map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, STEP_LABEL[s] ?? s)));
}

function escalateForm(recipients, urgencies, onSubmit, submitLabel, concerns) {
  const to = h('select', {}, recipients.map((r) => h('option', { value: r.roleKey }, r.label)));
  const urgency = h('select', {}, urgencies.map((u) => h('option', { value: u }, titleCase(u))));
  const concern = concerns ? h('select', {}, concerns.map((c) => h('option', { value: c }, c))) : null;
  const trigger = h('textarea', { placeholder: 'What has changed, and why you are worried' });
  urgency.value = 'URGENT';
  return h('form', { class: 'tile stack', onsubmit: (e) => { e.preventDefault(); onSubmit({ roleKey: to.value, urgency: urgency.value, concern: concern?.value, trigger: trigger.value }); } },
    h('label', { class: 'field' }, 'To', to),
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, 'How urgent', urgency),
      concern ? h('label', { class: 'field grow' }, 'Concern', concern) : null,
    ),
    h('label', { class: 'field' }, 'What has changed', trigger),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, submitLabel)),
  );
}

function escalateFurther(x, recipients, urgencies, reload) {
  const dlg = h('dialog', {},
    h('h2', {}, 'Escalate further'),
    h('p', { class: 'muted' }, `This closes the current escalation and raises a new one, linked to it.`),
    escalateForm(recipients, urgencies, async (b) => {
      try {
        await post(`/api/work/escalations/${x.id}/escalate`, b);
        dlg.close(); dlg.remove();
        toast('Escalated further.');
        reload();
      } catch (err) { showError(err); }
    }, 'Escalate', null),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function doAction(x, action, reload, ctx) {
  let body = {};
  if (action === 'escalate') {
    const d = await get(`/api/work/patients/${x.personId}/views/escalations`);
    return escalateFurther(x, d.recipients, d.urgencies, reload);
  }
  if (action === 'respond' || action === 'resolve') {
    const note = await ask(action === 'respond'
      ? { title: 'Record your response', message: 'What you did, found or advised. The person who raised it reassesses afterwards.', label: 'Response', multiline: true, minLength: 5, confirm: 'Record response' }
      : { title: 'Reassess and resolve', message: 'Your reassessment of the person now. Resolving closes this escalation.', label: 'Reassessment', multiline: true, minLength: 5, confirm: 'Resolve' });
    if (!note) return;
    body = { note };
  }
  try {
    await post(`/api/work/escalations/${x.id}/${action}`, body);
    toast({ receive: 'Opened.', acknowledge: 'Acknowledged. The person who raised it can see you have it.', respond: 'Response recorded.', resolve: 'Resolved.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { receive: ['Open', true], acknowledge: ['Acknowledge', true], respond: ['Record response', true], resolve: ['Reassess and resolve', false], escalate: ['Escalate further', false] };

export function escalationCard(x, reload, { showPatient = true } = {}) {
  const open = !['RESOLVED', 'ESCALATED'].includes(x.state);
  return h('div', { class: `tile stack esc esc-${x.urgency.toLowerCase()}${open ? '' : ' closed'}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/escalations`) }, h('b', {}, x.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, [x.location, `${x.raisedBy} → ${x.recipient}, ${x.service}`].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        h('span', { class: `tag ${URGENCY_TONE[x.urgency]}` }, titleCase(x.urgency)),
        x.level > 1 ? h('span', { class: 'tag danger' }, `Level ${x.level}`) : null,
        h('span', { class: `tag${open ? '' : ' muted'}` }, open ? `${STEP_LABEL[x.state]} · ${since(x.raisedAt)}` : STEP_LABEL[x.state]),
      ),
    ),
    h('div', {}, h('b', {}, `${x.concern}: `), x.sealed ? h('span', { class: 'muted' }, 'Open it to read the concern.') : x.trigger),
    steps(x),
    x.response ? h('div', { class: 'small' }, h('b', {}, `Response (${x.respondedBy}): `), x.response) : null,
    x.reassessment ? h('div', { class: 'small' }, h('b', {}, `Reassessment (${x.reassessedBy}): `), x.reassessment) : null,
    h('div', { class: 'small muted' }, [
      `Raised ${fmtDateTime(x.raisedAt)}`,
      x.receivedBy ? `opened by ${x.receivedBy}` : null,
      x.acknowledgedBy ? `acknowledged by ${x.acknowledgedBy}` : null,
    ].filter(Boolean).join(' · ')),
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => doAction(x, a, reload) }, ACTION[a][0]))) : null,
  );
}

// The patient's Escalation view inside the Live Workstation.
export function escalationsPanel(personId, d, reload) {
  const form = () => h('div', { class: 'stack' },
    h('h3', {}, 'Escalate a concern'),
    escalateForm(d.recipients, d.urgencies, async (b) => {
      try {
        await post(`/api/work/patients/${personId}/escalations`, b);
        toast('Escalation raised. You will see when it is opened and acknowledged.');
        reload();
      } catch (err) { showError(err); }
    }, 'Escalate', d.concerns),
  );
  return h('div', { class: 'stack' },
    d.canRaise ? form() : null,
    d.note ? h('div', { class: 'notice' }, d.note) : null,
    d.escalations.length ? d.escalations.map((x) => escalationCard(x, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No escalations for this person.'),
  );
}

// Home → Escalations.
export async function escalationsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/escalations');
    const open = (x) => !['RESOLVED', 'ESCALATED'].includes(x.state);
    const toMe = rows.filter((x) => open(x) && ['receive', 'acknowledge', 'respond'].some((a) => x.actions.includes(a)));
    const ours = rows.filter((x) => open(x) && !toMe.includes(x));
    const closed = rows.filter((x) => !open(x));
    mount(root,
      workHeader(),
      pageTitle('Escalations', () => go('/work/home')),
      h('div', { class: 'banner' }, 'When someone is worried. Opening, acknowledging and responding are separate, and the person who raised it reassesses before it is closed. SHIFT shows time open; it does not set response targets.'),
      toMe.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Waiting for you'), toMe.map((x) => escalationCard(x, load))) : null,
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Open'),
        ours.length ? ours.map((x) => escalationCard(x, load)) : h('div', { class: 'card empty' }, toMe.length ? 'Nothing else open.' : 'No open escalations.')),
      closed.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Closed today'), closed.map((x) => escalationCard(x, load))) : null,
    );
  };
  await load();
  return root;
}
