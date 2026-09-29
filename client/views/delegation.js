import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { dialog, field, select } from '../lib/forms.js';

// Delegation: an activity for one person → a named, competent colleague → what exactly and what to
// report back → how long → they accept → they do it → the delegator checks where needed → done.
const TONE = { OFFERED: 'warn', ACCEPTED: 'paua', TO_REVIEW: 'warn', COMPLETED: 'ok', DECLINED: 'danger', WITHDRAWN: '', EXPIRED: 'danger' };
const LABEL = { accept: 'Accept', decline: 'Decline', progress: 'Record what I did', concern: 'Report back', finish: 'Finished', review: 'Check it', seen: 'Seen the report', withdraw: 'Withdraw' };
const NOTE = {
  decline: ['Why not', 'e.g. Not signed off for this yet', 'Decline'],
  progress: ['What you did', 'e.g. BGL 6.2 before lunch, recorded', 'Save'],
  concern: ['What you noticed', 'e.g. BGL 3.4 and sweaty; given juice', 'Report back'],
  finish: ['How it went', 'e.g. All done, readings recorded', 'Finished'],
  seen: ['What you are doing about it', 'e.g. Reviewed her, meal brought forward', 'Save'],
  withdraw: ['Why', 'e.g. Doing it myself now', 'Withdraw'],
};

async function giveDialog(reload) {
  const [o, patients] = await Promise.all([get('/api/work/delegation/options'), get('/api/work/patients')]);
  const patient = select(patients.map((p) => [p.id, `${p.name}${p.location ? ` · ${p.location}` : ''}`]), 'Who for');
  const activity = select(Object.entries(o.activities).map(([k, a]) => [k, a.label]), 'What');
  const delegate = select([], 'Delegate to', 'Choose what first…');
  const hours = select(o.hours.map((n) => [String(n), `${n} hour${n > 1 ? 's' : ''}`]), 'How long', null);
  hours.value = '4';
  const instructions = h('textarea', { 'aria-label': 'Exactly what to do', placeholder: 'e.g. Check before lunch and tea, record in SHIFT' });
  const reportIf = h('textarea', { 'aria-label': 'Report straight back if' });
  const competent = h('input', { type: 'checkbox', 'aria-label': 'Competent' });
  const unavailable = h('p', { class: 'small muted', hidden: true });
  const review = h('p', { class: 'small', hidden: true }, 'You check the result before this is complete.');
  activity.addEventListener('change', async () => {
    const a = o.activities[activity.value];
    reportIf.value = a?.guide ?? '';
    review.hidden = !a?.review;
    const d = activity.value ? await get(`/api/work/delegation/options?activity=${activity.value}`) : { delegates: [] };
    delegate.replaceChildren(h('option', { value: '' }, d.delegates.length ? 'Choose…' : 'No one on in your service can take this'),
      ...d.delegates.map((x) => h('option', { value: x.id }, `${x.name} (${x.role})`)));
    unavailable.textContent = d.unavailable?.length ? `Not listed: ${d.unavailable.map((u) => `${u.name} (${u.why})`).join(', ')}.` : '';
    unavailable.hidden = !d.unavailable?.length;
  });
  dialog('Delegate care', (run, close) => h('div', { class: 'stack' },
    o.keeps ? h('p', { class: 'small' }, o.keeps) : null,
    field('Who for', patient), field('What', activity), review, field('Delegate to', delegate), unavailable, field('How long', hours),
    field('Exactly what to do', instructions), field('Report straight back if', reportIf),
    h('label', { class: 'check' }, competent, h('span', {}, 'I have checked they are competent to do this')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
      await post('/api/work/delegation', {
        personId: patient.value, activity: activity.value, delegateId: delegate.value, hours: Number(hours.value),
        instructions: instructions.value, reportIf: reportIf.value, competent: competent.checked,
      });
      close();
      toast('Delegated. They need to accept it.');
      reload();
    }) }, 'Delegate'))));
}

function noteDialog(x, action, reload) {
  const [label, placeholder, submit] = NOTE[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${LABEL[action]}: ${x.activityLabel}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, `${x.patient} · ${x.instructions}`),
    field(label, note),
    h('div', { class: 'row' }, h('button', { class: `btn ${action === 'decline' || action === 'withdraw' || action === 'concern' ? 'danger' : 'primary'}`, onclick: run(async () => {
      await post(`/api/work/delegation/${x.id}/${action}`, { note: note.value });
      close();
      toast('Saved.');
      reload();
    }) }, submit))));
}

function reviewDialog(x, outcomes, reload) {
  const outcome = select(Object.entries(outcomes), 'What you found');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Readings fine; will review insulin tomorrow' });
  dialog(`Check: ${x.activityLabel} for ${x.patient}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, `Done by ${x.delegate}.`),
    field('What you found', outcome), field('Note (needed unless it was done as asked)', note),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
      await post(`/api/work/delegation/${x.id}/review`, { outcome: outcome.value, note: note.value });
      close();
      toast('Checked.');
      reload();
    }) }, 'Save check'))));
}

function delegationCard(x, d, reload) {
  const handler = (a) => () => {
    if (a === 'review') return reviewDialog(x, d.outcomes, reload);
    if (a === 'accept') return post(`/api/work/delegation/${x.id}/accept`, {}).then(() => { toast('Accepted.'); reload(); }, (err) => toast(err?.message ?? 'Something went wrong.', 'error'));
    return noteDialog(x, a, reload);
  };
  const concern = x.log.filter((l) => l.kind === 'CONCERN').at(-1);
  return h('div', { class: `tile stack dlg dlg-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, `${x.activityLabel} · ${x.patient}`), h('span', { class: `tag ${TONE[x.state] ?? ''}` }, x.outcomeLabel ?? x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'What to do: '), x.instructions),
    h('div', { class: 'small' }, h('b', {}, 'Report straight back if: '), x.reportIf),
    x.concernAt && concern ? h('div', { class: 'small notice' }, h('b', {}, `Reported back by ${x.delegate}, ${fmtDateTime(x.concernAt)}: `), concern.body) : null,
    h('div', { class: 'small muted' }, [`${x.delegator} → ${x.delegate}`, `until ${fmtDateTime(x.endsAt)}`, x.reviewRequired ? 'checked by the delegator when done' : null, x.competent ? 'competence checked' : null].filter(Boolean).join(' · ')),
    x.state === 'DECLINED' && x.responseNote ? h('div', { class: 'small' }, h('b', {}, `Declined by ${x.delegate}: `), x.responseNote) : null,
    x.reviewNote ? h('div', { class: 'small' }, h('b', {}, 'Check: '), x.reviewNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${['accept', 'review', 'finish'].includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABEL[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// Home → Delegation.
export async function delegationView() {
  const d = await get('/api/work/delegation');
  const reload = () => go('/work/delegation');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => delegationCard(x, d, reload)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Delegation', () => go('/work/home')),
    h('div', { class: 'banner' }, d.canGive
      ? 'Hand one activity for one person to a colleague whose role can do it, once you have checked they are competent. They accept it, do it and report back. You stay responsible for the person, and check the result where it needs it.'
      : 'Care delegated to you. Accept it or say why not, record what you did, and report straight back if anything on the list happens.'),
    h('div', { class: 'stack' },
      d.canGive ? h('div', {}, h('button', { class: 'btn primary', onclick: () => giveDialog(reload) }, 'Delegate care')) : null,
      d.canTake || d.toAccept.length ? section('To accept', d.toAccept, 'Nothing waiting for you to accept.') : null,
      d.canTake || d.doing.length ? section('I am doing', d.doing, 'Nothing delegated to you right now.') : null,
      d.canGive ? section('To check', d.toCheck, 'Nothing to check.') : null,
      d.canGive ? section('I delegated', d.given, 'Nothing delegated by you right now.') : null,
      section('Ended in the last 24 hours', d.ended, 'Nothing ended in the last 24 hours.')),
  );
}
