import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { state, go } from '../app.js';
import { workHeader } from './entry.js';
import { dialog, field, select } from './identity.js';

// Break-glass access: no ordinary access → clinical need → the pathway that fits → reason →
// agreement or a senior's approval → time-limited access → everything done listed → review.
const TONE = { REQUESTED: 'warn', ACTIVE: 'danger', DECLINED: '', WITHDRAWN: '', ENDED: 'warn', REVIEWED: 'ok' };
const OUTCOME_TONE = { APPROPRIATE: 'ok', FOLLOW_UP: 'warn', INAPPROPRIATE: 'danger' };

// Ask for access to a record from search.
export async function breakGlassDialog(r, done) {
  const o = await get('/api/work/breakglass/options');
  const radios = h('div', { class: 'stack', role: 'radiogroup', 'aria-label': 'Why do you need access' });
  const reason = h('textarea', { 'aria-label': 'What you need the record for', placeholder: 'e.g. Unconscious in ED, need allergies and medicines' });
  const consent = select(Object.entries(o.consent), 'Did the person agree');
  const approver = select(o.approvers.map((a) => [a.id, a.name]), 'Senior who approves');
  const consentRow = field('Did the person agree?', consent);
  const approverRow = o.approvers.length ? field('Senior clinician who approves', approver) : h('p', { class: 'small notice' }, `No one in ${state.me.context.service} can approve this today. If care cannot wait, choose Emergency.`);
  let kind = '';
  const show = () => { consentRow.hidden = kind !== 'PRESENT'; approverRow.hidden = kind !== 'APPROVAL'; };
  for (const [k, v] of Object.entries(o.kinds)) {
    radios.append(h('label', { class: 'check' }, h('input', { type: 'radio', name: 'bg-kind', value: k, onchange: () => { kind = k; show(); } }), `${v.label} (open ${v.minutes >= 60 ? `${v.minutes / 60} h` : `${v.minutes} min`})`));
  }
  show();
  dialog(`Break-glass access: ${r.name}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, `${r.name} has no care relationship with ${state.me.context.service}. Break-glass access is for care that needs this record. It closes on its own, everything you open is listed, and a senior clinician in your service reviews it.`),
    field('Why do you need access?', radios),
    field('What do you need the record for?', reason),
    consentRow, approverRow,
    h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: run(async () => {
      const res = await post(`/api/work/patients/${r.id}/exceptional-access`, { kind, reason: reason.value, consent: consent.value, approverId: approver.value });
      close();
      if (res.state === 'ACTIVE') { toast('Access open. Everything you do is recorded.'); go(`/work/patient/${r.id}`); } else { toast(`Asked ${res.approver} to approve.`); done?.(); }
    }) }, 'Open or ask for access'))));
}

// End an open access early, from the record's banner.
export async function endBreakGlass(id) {
  try {
    await post(`/api/work/breakglass/${id}/end`, {});
    toast('Access ended. A senior clinician will review it.');
    go('/work/search');
  } catch (err) { toast(err?.message ?? 'Something went wrong.', 'error'); }
}

function decideDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: action === 'approve' ? 'Optional, e.g. Only what you need for the transfer' : 'e.g. Ask the GP for the letter instead' });
  dialog(`${action === 'approve' ? 'Approve' : 'Do not approve'}: ${x.worker} for ${x.patient}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, h('b', {}, `${x.kindLabel}. `), x.reason),
    field(action === 'approve' ? 'Note (optional)' : 'Why not', note),
    h('div', { class: 'row' }, h('button', { class: `btn ${action === 'approve' ? 'primary' : 'danger'}`, onclick: run(async () => {
      await post(`/api/work/breakglass/${x.id}/${action}`, { note: note.value });
      close();
      toast(action === 'approve' ? 'Approved. Access is open.' : 'Not approved.');
      reload();
    }) }, action === 'approve' ? 'Approve' : 'Do not approve'))));
}

function reviewDialog(x, outcomes, reload) {
  const outcome = select(Object.entries(outcomes), 'Outcome');
  const note = h('textarea', { 'aria-label': 'Review note', placeholder: 'e.g. Discussed with them; they will use a referral next time' });
  const warn = h('p', { class: 'small notice', hidden: true }, 'Report it as a privacy incident as well.');
  outcome.addEventListener('change', () => { warn.hidden = outcome.value !== 'INAPPROPRIATE'; });
  dialog(`Review: ${x.worker} for ${x.patient}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, h('b', {}, `${x.kindLabel}. `), x.reason),
    field('Outcome', outcome), field('Note (needed unless the use was appropriate)', note), warn,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
      await post(`/api/work/breakglass/${x.id}/review`, { outcome: outcome.value, note: note.value });
      close();
      toast('Review recorded.');
      reload();
    }) }, 'Record review'))));
}

function accessCard(x, d, reload) {
  const handler = (a) => () => {
    if (a === 'approve' || a === 'decline') return decideDialog(x, a, reload);
    if (a === 'review') return reviewDialog(x, d.outcomes, reload);
    return post(`/api/work/breakglass/${x.id}/${a}`, {}).then(() => { toast(a === 'end' ? 'Access ended.' : 'Withdrawn.'); reload(); }, (err) => toast(err?.message ?? 'Something went wrong.', 'error'));
  };
  const LABEL = { approve: 'Approve', decline: 'Do not approve', withdraw: 'Withdraw', end: 'End access now', review: 'Review' };
  return h('div', { class: `tile stack bg bg-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, `${x.worker} → ${x.patient}`), h('span', { class: `tag ${x.outcomeLabel ? OUTCOME_TONE[x.reviewOutcome] : TONE[x.state]}` }, x.outcomeLabel ?? x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `${x.kindLabel}. `), x.reason),
    x.consentLabel ? h('div', { class: 'small' }, h('b', {}, 'Agreement: '), x.consentLabel) : null,
    h('div', { class: 'small muted' }, [`Asked ${fmtDateTime(x.requestedAt)}`, x.approver ? `approver ${x.approver}` : null, x.state === 'ACTIVE' ? `open until ${fmtDateTime(x.expiresAt)}` : null, x.endedAt ? `ended ${fmtDateTime(x.endedAt)}` : null, x.service].filter(Boolean).join(' · ')),
    x.state !== 'REQUESTED' && (x.state === 'ENDED' || x.state === 'REVIEWED') ? h('div', { class: 'stack' },
      h('b', { class: 'small' }, `What was done under this access (${x.activity.length})`),
      x.activity.length ? h('ul', { class: 'small bg-activity' }, x.activity.map((a) => h('li', {}, `${fmtDateTime(a.at)} · ${a.label}`)))
        : h('div', { class: 'small muted' }, 'Nothing was opened.')) : null,
    x.reviewNote ? h('div', { class: 'small' }, h('b', {}, `Review (${x.reviewedBy}): `), x.reviewNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'approve' || a === 'review' ? ' primary' : a === 'end' ? ' danger' : ''}`, onclick: handler(a) }, LABEL[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// Home → Break-glass access.
export async function breakGlassView() {
  const d = await get('/api/work/breakglass');
  const reload = () => go('/work/breakglass');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => accessCard(x, d, reload)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Break-glass access', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Access to a record outside your care, when care needs it. Emergencies open at once; other needs wait for a senior to approve. Access closes on its own, and a senior in the service reviews everything that was opened.'),
    h('div', { class: 'stack' },
      h('div', {}, h('button', { class: 'btn', onclick: () => go('/work/search') }, 'Find a record')),
      d.toApprove.length || d.canApprove ? section('To approve', d.toApprove, 'No requests waiting for you.') : null,
      d.canApprove ? section('To review', d.toReview, 'No access waiting for review.') : null,
      section('Yours in the last 14 days', d.mine, 'You have not used break-glass access in the last 14 days.'),
      d.canApprove ? section('Reviewed in the last 14 days', d.reviewed, 'Nothing reviewed in the last 14 days.') : null),
  );
}
