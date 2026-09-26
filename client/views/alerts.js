import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Alert: trigger → generated → visible to its recipient → acknowledged → action → resolved
// or expired. Alerts generated from the record close themselves when the record changes;
// alerts staff raise stay until someone resolves them or their review date passes.
const STEPS = ['GENERATED', 'VISIBLE', 'ACKNOWLEDGED', 'ACTIONED', 'RESOLVED'];
const LABEL = { GENERATED: 'New', VISIBLE: 'Seen', ACKNOWLEDGED: 'Acknowledged', ACTIONED: 'Action taken', RESOLVED: 'Resolved', EXPIRED: 'Expired' };
const TONE = { GENERATED: 'danger', VISIBLE: 'danger', ACKNOWLEDGED: 'warn', ACTIONED: 'warn', RESOLVED: 'ok', EXPIRED: 'muted' };
const SOURCE = {
  RESULT_ABNORMAL: 'From results: the laboratory flagged this result and no one has reviewed it.',
  WOUND_REVIEW_OVERDUE: 'From wound care: the review date has passed.',
  CAREPLAN_REVIEW_OVERDUE: 'From the care plan: the review date has passed.',
  MONITORING_OVERDUE: 'From the monitoring plan: nothing has been recorded since it was due. Recording it closes this alert.',
  RESTRICTION_REVIEW_OVERDUE: 'From restrictions: the review date has passed. Reviewing it closes this alert.',
  SWALLOW_CONCERN: 'From meals: coughing or choking was recorded since the diet was last reviewed. Reviewing the diet closes this alert.',
  LEAVE_OVERDUE: 'From leave: they were due back and are not recorded as back. Recording their return closes this alert.',
  EQUIPMENT_SERVICE_OVERDUE: 'From equipment: it is in use on a patient past its planned service date. Swapping it closes this alert.',
};
const OPEN = ['GENERATED', 'VISIBLE', 'ACKNOWLEDGED', 'ACTIONED'];
const WHERE = { LEAVE_OVERDUE: 'absence', RESULT_ABNORMAL: 'results', WOUND_REVIEW_OVERDUE: 'wounds', CAREPLAN_REVIEW_OVERDUE: 'careplan', MONITORING_OVERDUE: 'monitoring', RESTRICTION_REVIEW_OVERDUE: 'restrictions', SWALLOW_CONCERN: 'diet', EQUIPMENT_SERVICE_OVERDUE: 'equipment' };

function steps(a) {
  if (a.state === 'EXPIRED') return null;
  const at = STEPS.indexOf(a.state);
  return h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i < at || a.state === 'RESOLVED' ? 'done' : i === at ? 'now' : '' }, LABEL[s])));
}

async function doAction(a, action, reload) {
  let body = {};
  if (action === 'action') {
    const note = await ask({ title: 'Record the action taken', message: a.rule === 'RAISED' ? 'Colleagues see what was done.' : 'The alert closes by itself once the record changes.', label: 'What was done', confirm: 'Save', multiline: true, minLength: 3 });
    if (!note) return;
    body = { note };
  }
  if (action === 'resolve') {
    const note = await ask({ title: 'Resolve this alert', message: 'It comes off the record banner for everyone.', label: 'Why it no longer applies', confirm: 'Resolve', multiline: true, minLength: 3 });
    if (!note) return;
    body = { note };
  }
  try {
    await post(`/api/work/alerts/${a.id}/${action}`, body);
    toast({ acknowledge: 'Acknowledged.', action: 'Action recorded.', resolve: 'Resolved.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { acknowledge: ['Acknowledge', true], action: ['Record action', false], resolve: ['Resolve', false] };

export function alertCard(a, reload, { showPatient = true } = {}) {
  const raised = a.rule === 'RAISED';
  return h('div', { class: `tile stack${OPEN.includes(a.state) && raised ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${a.personId}/${WHERE[a.rule] ?? 'alerts'}`) }, h('b', {}, a.patient)) : null,
        h('div', { class: showPatient ? 'muted' : 'small muted' }, [showPatient ? a.location : null, raised ? `${a.categoryLabel}, raised by ${a.raisedBy} (${a.service})` : a.service].filter(Boolean).join(' · ')),
      ),
      h('span', { class: `tag ${TONE[a.state] ?? ''}` }, LABEL[a.state]),
    ),
    h('div', {}, h('b', {}, a.title)),
    a.detail ? h('div', {}, a.detail) : null,
    raised ? null : h('div', { class: 'small muted' }, SOURCE[a.rule]),
    steps(a),
    a.actionNote ? h('div', { class: 'small' }, h('b', {}, `Action (${a.actionedBy}, ${fmtDateTime(a.actionedAt)}): `), a.actionNote) : null,
    a.resolution ? h('div', { class: 'small' }, h('b', {}, `${LABEL[a.state]}${a.resolvedBy ? ` (${a.resolvedBy})` : ''}: `), a.resolution) : null,
    h('div', { class: 'small muted' }, [
      `${raised ? 'Raised' : 'Generated'} ${fmtDateTime(a.generatedAt)}`,
      a.seenBy && !raised ? `first seen by ${a.seenBy}` : null,
      a.acknowledgedBy ? `acknowledged by ${a.acknowledgedBy}` : null,
      a.expiresOn && OPEN.includes(a.state) ? `review by ${fmtDate(a.expiresOn)}` : null,
    ].filter(Boolean).join(' · ')),
    a.actions.length ? h('div', { class: 'row' }, a.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(a, x, reload) }, ACTION[x][0]))) : null,
  );
}

// The patient's Alerts view inside the Live Workstation.
export function alertsPanel(personId, d, reload) {
  const form = () => {
    const category = h('select', {}, Object.entries(d.categories).map(([k, v]) => h('option', { value: k }, v)));
    const title = h('input', { type: 'text', placeholder: 'A few words everyone will see on the record' });
    const detail = h('textarea', { placeholder: 'What colleagues need to know or do' });
    const until = h('input', { type: 'date' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/alerts`, { category: category.value, title: title.value, detail: detail.value, expiresOn: until.value });
        toast('Alert raised. It shows on the record for everyone who opens it.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Raise an alert'),
      h('label', { class: 'field' }, 'Kind', category),
      h('label', { class: 'field' }, 'Alert', title),
      h('label', { class: 'field' }, 'Details', detail),
      h('label', { class: 'field' }, 'Review by (optional)', until),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Raise alert')),
    );
  };
  return h('div', { class: 'stack' },
    d.alerts.length ? d.alerts.map((a) => alertCard(a, reload, { showPatient: false })) : h('div', { class: 'empty' }, 'No alerts for this patient.'),
    d.canRaise ? form() : null,
  );
}

// Home → Alerts.
export async function alertsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/alerts');
    const fresh = rows.filter((a) => a.state === 'VISIBLE' || a.state === 'GENERATED');
    const going = rows.filter((a) => a.state === 'ACKNOWLEDGED' || a.state === 'ACTIONED');
    const closed = rows.filter((a) => !OPEN.includes(a.state));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((a) => alertCard(a, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Alerts', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Alerts come from what is recorded, such as a result the laboratory flagged or a review date that has passed. SHIFT sets no clinical thresholds of its own.'),
      section('Needs acknowledging', fresh, 'Nothing new.'),
      going.length ? section('Acknowledged', going, '') : null,
      closed.length ? section('Closed today', closed, '') : null,
    );
  };
  await load();
  return root;
}
