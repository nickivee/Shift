import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime, fmtDate } from '../lib/ui.js';
import { go } from '../app.js';
import { formDialog as dialog, select } from '../lib/forms.js';

// The coroner's side of a death: the record held → requests for information decided and sent →
// findings and the service's response → closed.
const TONE = { HELD: 'danger', FINDINGS: 'warn', CLOSED: 'muted' };
const REQ_TONE = { RECEIVED: 'danger', ADVICE: 'warn', DECIDED: 'warn', SENT: 'ok' };
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');
const act = (c, action, body, done, reload) => post(`/api/work/coronial/${c.id}/${action}`, body).then(() => { toast(done); reload(); });

function requestDialog(c, reload) {
  const from = h('input', { type: 'text', 'aria-label': 'From', placeholder: 'e.g. Coronial investigator Jo Ruru, Coronial Services Wellington' });
  const ref = h('input', { type: 'text', 'aria-label': 'Their reference', placeholder: 'e.g. CSU-2026-04418' });
  const asked = h('textarea', { 'aria-label': 'What they asked for', placeholder: 'Word for word where you can' });
  const due = h('input', { type: 'date', 'aria-label': 'Needed by', value: inDays(14) });
  dialog('Request from the coroner', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'From', from),
    h('label', { class: 'field' }, 'Their reference', ref),
    h('label', { class: 'field' }, 'What they asked for', asked),
    h('label', { class: 'field' }, 'Needed by', due),
    h('p', { class: 'small muted' }, 'A doctor or the nurse in charge decides what is released before anything is sent.'),
  ), 'Record', () => act(c, 'request', { from: from.value, ref: ref.value, asked: asked.value, dueDate: due.value }, 'Recorded. It is waiting for a decision.', reload), { wide: true });
}

function decideDialog(c, q, o, reload) {
  const decision = select(Object.entries(o.decision), 'What will be released');
  const basis = h('textarea', { 'aria-label': 'Why', placeholder: 'What the release is based on; for part, what is withheld and why' });
  dialog('Decide what to release', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${q.fromName}: ${q.asked}`),
    h('label', { class: 'field' }, 'What will be released', decision),
    h('label', { class: 'field' }, 'Why', basis),
    h('p', { class: 'small muted' }, 'What the coroner may require and what must be released is still being researched for New Zealand (RR-CORONER-001). SHIFT records your decision; it does not make it.'),
  ), 'Record decision', () => act(c, 'decide', { requestId: q.id, decision: decision.value, basis: basis.value }, 'Decision recorded.', reload), { wide: true });
}

function sendDialog(c, q, o, reload) {
  const how = select(Object.entries(o.sentHow), 'How it was sent');
  const what = h('textarea', { 'aria-label': 'What was sent', placeholder: 'e.g. Clinical notes 3 to 9 Sept, observation charts, incident report 2026-311' });
  dialog('Sent to the coroner', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${q.decisionLabel}. ${q.basis}`),
    h('label', { class: 'field' }, 'How it was sent', how),
    h('label', { class: 'field' }, 'What was sent', what),
  ), 'Record', () => act(c, 'send', { requestId: q.id, how: how.value, what: what.value }, 'Recorded as sent.', reload));
}

function findingsDialog(c, reload) {
  const findings = h('textarea', { 'aria-label': 'Findings', placeholder: 'Date, reference and a summary of the findings' });
  const recs = h('textarea', { 'aria-label': 'Recommendations for this service', placeholder: 'Leave empty if there are none for this service' });
  dialog('Coroner\'s findings', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Findings', findings),
    h('label', { class: 'field' }, 'Recommendations for this service', recs),
    h('p', { class: 'small muted' }, 'Recording the findings ends the hold on the record.'),
  ), 'Record', () => act(c, 'findings', { findings: findings.value, recommendations: recs.value }, 'Findings recorded. The record is no longer held.', reload), { wide: true });
}

function respondDialog(c, reload) {
  const response = h('textarea', { 'aria-label': 'Response', placeholder: c.recommendations ? 'What the service has done or will do about each recommendation, who is responsible and by when' : 'Who reviewed the findings and what, if anything, the service will do' });
  dialog('Service response', h('div', { class: 'stack' },
    c.recommendations ? h('p', { class: 'muted' }, `Recommendations: ${c.recommendations}`) : null,
    h('label', { class: 'field' }, 'Response', response),
  ), 'Record', () => act(c, 'respond', { response: response.value }, 'Response recorded.', reload), { wide: true });
}

function closeDialog(c, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog('Close the coroner\'s case', h('label', { class: 'field' }, 'Note', note), 'Close', () => act(c, 'close', { note: note.value }, 'Closed.', reload));
}

function requestRow(c, q, o, reload) {
  return h('div', { class: `tile stack coroner-request${q.overdue ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, q.fromName), h('span', { class: `tag ${q.overdue ? 'danger' : REQ_TONE[q.state]}` }, q.overdue ? `Overdue: ${q.stateLabel.toLowerCase()}` : q.stateLabel)),
    h('div', { class: 'small muted' }, `Received ${fmtDateTime(q.receivedAt)}${q.ref ? ` · ${q.ref}` : ''}${q.dueDate ? ` · needed by ${fmtDate(q.dueDate)}` : ''}`),
    h('div', {}, q.asked),
    q.decidedAt ? h('div', { class: 'small' }, h('b', {}, `${q.decisionLabel}: `), `${q.basis} (${q.decidedBy}, ${fmtDateTime(q.decidedAt)})`) : null,
    q.sentAt ? h('div', { class: 'small' }, h('b', {}, 'Sent: '), `${q.sentWhat}. ${q.sentHowLabel}, ${q.sentBy}, ${fmtDateTime(q.sentAt)}`) : null,
    q.can.length ? h('div', { class: 'row' },
      q.can.includes('decide') ? h('button', { class: 'btn small primary', onclick: () => decideDialog(c, q, o, reload) }, 'Decide what to release') : null,
      q.can.includes('send') ? h('button', { class: 'btn small primary', onclick: () => sendDialog(c, q, o, reload) }, 'Record as sent') : null) : null,
  );
}

export function coronialPanel(c, o, reload, withName = false) {
  if (!c) return null;
  const changes = c.sinceHold.added + c.sinceHold.changed;
  return h('div', { class: 'tile stack coroner-case' },
    h('div', { class: 'spread' },
      withName ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${c.personId}/death`) }, h('b', {}, c.patient)) : h('h3', {}, 'Coroner'),
      h('span', { class: `tag ${TONE[c.state]}` }, c.stateLabel)),
    h('div', { class: 'small muted' }, `Died ${fmtDateTime(c.diedAt)} · reported to the coroner${c.coronerRef ? ` (${c.coronerRef})` : ''} · held since ${fmtDateTime(c.heldAt)} by ${c.heldBy}`),
    c.state === 'HELD' ? h('div', { class: 'notice small' }, changes
      ? `Since the hold: ${c.sinceHold.added} entr${c.sinceHold.added === 1 ? 'y' : 'ies'} added and ${c.sinceHold.changed} changed. Earlier versions are kept and nothing is removed.`
      : 'Nothing has been added or changed since the hold. Earlier versions are always kept and nothing is removed.') : null,
    h('div', { class: 'small muted' }, `Requests for information (${c.requests.length})`),
    c.requests.length ? c.requests.map((q) => requestRow(c, q, o, reload)) : h('p', { class: 'small muted' }, 'None yet.'),
    c.findingsAt ? h('div', { class: 'small' }, h('b', {}, 'Findings: '), `${c.findings}${c.recommendations ? ` Recommendations: ${c.recommendations}` : ''} (${c.findingsBy}, ${fmtDateTime(c.findingsAt)})`) : null,
    c.respondedAt ? h('div', { class: 'small' }, h('b', {}, 'Response: '), `${c.response} (${c.respondedBy}, ${fmtDateTime(c.respondedAt)})`) : null,
    c.can.length ? h('div', { class: 'row' },
      c.can.includes('request') ? h('button', { class: 'btn small', onclick: () => requestDialog(c, reload) }, 'Request from the coroner') : null,
      c.can.includes('findings') ? h('button', { class: 'btn small', onclick: () => findingsDialog(c, reload) }, 'Findings received') : null,
      c.can.includes('respond') ? h('button', { class: 'btn small primary', onclick: () => respondDialog(c, reload) }, 'Record the service response') : null,
      c.can.includes('close') ? h('button', { class: 'btn small', onclick: () => closeDialog(c, reload) }, 'Close') : null) : null,
    h('details', {}, h('summary', {}, `Step by step (${c.steps.length})`),
      h('ol', { class: 'det-steps' }, c.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kind.charAt(0) + s.kind.slice(1).toLowerCase()), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}
