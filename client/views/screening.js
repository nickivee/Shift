import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Screening: eligible → offered → their decision → screened → result → reviewed → told →
// screen again later, further tests or referral, or no more screening.
const TONE = {
  ELIGIBLE: 'muted', OFFERED: 'warn', ACCEPTED: 'ok', SCREENED: 'warn', RESULTED: 'warn', REVIEWED: 'warn', COMMUNICATED: 'ok',
  DECLINED: 'muted', CLOSED: 'muted', EXITED: 'muted', ENTERED_IN_ERROR: 'muted',
};

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return day(d); };
const localNow = () => { const d = new Date(); return `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const send = (x, action, body) => post(`/api/work/screening/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

function startDialog(personId, o, reload) {
  const kind = select(o.kinds.map((k) => [k.id, k.label]), 'Screen');
  const what = h('input', { type: 'text', 'aria-label': 'What exactly', placeholder: 'Optional, e.g. Bowel screening kit' });
  const test = h('input', { type: 'text', 'aria-label': 'What it involves', placeholder: 'e.g. Retinal photographs' });
  const eligibility = h('textarea', { 'aria-label': 'Why they are eligible', placeholder: 'e.g. Type 2 diabetes; last eye screen over two years ago' });
  const due = h('input', { type: 'date', 'aria-label': 'Due', value: addDays(0) });
  kind.addEventListener('change', () => { const k = o.kinds.find((x) => x.id === kind.value); if (k) test.value = k.test; });
  dialog('Eligible for a screen', h('div', { class: 'stack' }, field('Screen', kind), field('What exactly', what), field('What it involves', test),
    field('Why they are eligible', eligibility), field('Due', due)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/screening`, { kind: kind.value, what: what.value, test: test.value, eligibility: eligibility.value, dueDate: due.value });
    toast('Screening added.');
    reload();
  });
}

function offerDialog(x, o, reload) {
  const channel = select(Object.entries(o.channels), 'How');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed for whānau: who you spoke to. e.g. Explained what the photos involve' });
  dialog(`Offer: ${x.what}`, h('div', { class: 'stack' }, field('How you offered it', channel), field('Note', note)), 'Save', async () => {
    await send(x, 'offer', { channel: channel.value, note: note.value });
    reload();
  });
}

function decideDialog(x, action, reload) {
  let decision = action === 'decline' ? 'DECLINE' : '';
  const note = h('textarea', { 'aria-label': 'What they said', placeholder: 'In their words if you can, e.g. "I\'d rather not know"' });
  const again = h('input', { type: 'date', 'aria-label': 'Offer again on', min: addDays(1) });
  const againField = field('Offer again on (optional)', again);
  againField.hidden = decision !== 'DECLINE';
  const pick = (v) => () => { decision = v; againField.hidden = v !== 'DECLINE'; };
  const choices = action === 'decline' ? null : h('fieldset', { class: 'row' }, h('legend', {}, 'What did they decide?'),
    choice('decision', 'ACCEPT', 'Yes, screen me', pick('ACCEPT')), choice('decision', 'LATER', 'Wants time to decide', pick('LATER')), choice('decision', 'DECLINE', 'No thank you', pick('DECLINE')));
  dialog(`${action === 'decline' ? 'Changed their mind' : 'Their decision'}: ${x.what}`, h('div', { class: 'stack' }, choices, field('What they said', note), againField), 'Save', async () => {
    await send(x, action, { decision, note: note.value, nextDue: decision === 'DECLINE' ? again.value : '' });
    reload();
  });
}

function screenDialog(x, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When', value: localNow() });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Photos taken in both eyes, sent for grading' });
  dialog(`Screened: ${x.what}`, h('div', { class: 'stack' }, field('When', when), field('Note', note)), 'Save', async () => {
    await send(x, 'screen', { when: when.value ? new Date(when.value).toISOString() : '', note: note.value });
    reload();
  });
}

function resultDialog(x, o, reload) {
  let finding = '';
  const result = h('textarea', { 'aria-label': 'Result', placeholder: 'e.g. MoCA 21/30; lost points on recall' });
  dialog(`Result: ${x.what}`, h('div', { class: 'stack' }, field('Result', result),
    h('fieldset', { class: 'row' }, h('legend', {}, 'The screen is'), Object.entries(o.findings).map(([k, v]) => choice('finding', k, v, () => { finding = k; })))),
  'Save', async () => {
    await send(x, 'result', { result: result.value, finding });
    reload();
  });
}

function reviewDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Your review', placeholder: 'e.g. Abnormal; refer to the memory clinic' });
  dialog(`Review: ${x.what}`, h('div', { class: 'stack' }, h('div', { class: 'small' }, h('b', {}, `Result (${x.findingLabel.toLowerCase()}): `), x.result), field('Your review', note)),
    'Save review', async () => {
      await send(x, 'review', { note: note.value });
      reload();
    });
}

function tellDialog(x, o, reload) {
  const channel = select(Object.entries(o.channels), 'How');
  const note = h('textarea', { 'aria-label': 'What you told them', placeholder: 'e.g. Explained the result and the referral; she understood and agreed' });
  dialog(`Tell them: ${x.what}`, h('div', { class: 'stack' }, h('div', { class: 'small' }, h('b', {}, 'Review: '), x.reviewNote),
    field('How you told them', channel), field('What you told them', note)), 'Save', async () => {
    await send(x, 'tell', { channel: channel.value, note: note.value });
    reload();
  });
}

function closeDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcomes), 'What next');
  const next = h('input', { type: 'date', 'aria-label': 'Next screen due', min: addDays(1), value: x.nextDue ?? '' });
  const nextField = field('Next screen due', next);
  const reason = select(Object.entries(o.exitReasons), 'Why');
  const reasonField = field('Why', reason);
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Needed for further tests: which, e.g. Referred to the memory clinic' });
  const sync = () => { nextField.hidden = outcome.value !== 'RECALL'; reasonField.hidden = outcome.value !== 'EXIT'; };
  outcome.addEventListener('change', sync);
  sync();
  dialog(`Close: ${x.what}`, h('div', { class: 'stack' }, field('What next', outcome), nextField, reasonField, field('Note', note)), 'Close', async () => {
    await send(x, 'close', { outcome: outcome.value, nextDue: next.value, reason: reason.value, note: note.value });
    reload();
  });
}

function exitDialog(x, o, reload) {
  const reason = select(Object.entries(o.exitReasons), 'Why');
  const note = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Already under the eye clinic' });
  dialog(`End: ${x.what}`, h('div', { class: 'stack' }, field('Why', reason), field('What happened', note)), 'End screening', async () => {
    await send(x, 'exit', { reason: reason.value, note: note.value });
    reload();
  });
}

function errorDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Set up for the wrong person' });
  dialog(`Entered in error: ${x.what}`, field('Why', note), 'Mark as error', async () => {
    await send(x, 'error', { note: note.value });
    reload();
  });
}

const LABELS = {
  offer: 'Offer', decide: 'Their decision', screen: 'Screened', decline: 'Changed their mind', result: 'Add result', review: 'Review',
  tell: 'Told them', close: 'Close', exit: 'End screening', error: 'Entered in error',
};
const PRIMARY = ['offer', 'decide', 'screen', 'result', 'review', 'tell', 'close'];

function screeningCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'offer' ? offerDialog(x, o, reload) : a === 'decide' || a === 'decline' ? decideDialog(x, a, reload)
    : a === 'screen' ? screenDialog(x, reload) : a === 'result' ? resultDialog(x, o, reload) : a === 'review' ? reviewDialog(x, reload)
    : a === 'tell' ? tellDialog(x, o, reload) : a === 'close' ? closeDialog(x, o, reload) : a === 'exit' ? exitDialog(x, o, reload) : errorDialog(x, reload));
  const flag = x.overdue ? ['Overdue', 'danger'] : x.abnormal ? [`Abnormal · ${x.stateLabel.toLowerCase()}`, 'danger'] : [x.stateLabel, TONE[x.state]];
  const tone = x.overdue || x.abnormal ? 'alert' : ['DECLINED', 'CLOSED', 'EXITED', 'ENTERED_IN_ERROR'].includes(x.state) ? 'ended' : x.state === 'ELIGIBLE' ? 'waiting' : 'active';
  return h('div', { class: `tile stack screen screen-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/screening`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.what), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'small' }, `${x.test} · due ${x.dueDate}`),
    h('div', { class: 'small' }, h('b', {}, 'Eligible: '), x.eligibility),
    x.offeredBy ? h('div', { class: 'small muted' }, `Offered ${fmtDateTime(x.offeredAt)} by ${x.offeredBy} (${x.channelLabel.toLowerCase()})${x.offerNote ? ` · ${x.offerNote}` : ''}`) : null,
    x.decisionNote ? h('div', { class: 'small' }, h('b', {}, x.state === 'DECLINED' ? 'Declined, in their words: ' : 'Their decision: '), x.decisionNote) : null,
    x.screenedBy ? h('div', { class: 'small muted' }, `Screened ${fmtDateTime(x.screenedAt)} by ${x.screenedBy}${x.screenNote ? ` · ${x.screenNote}` : ''}`) : null,
    x.result ? h('div', { class: 'small' }, h('b', {}, `Result (${x.findingLabel.toLowerCase()}, ${x.resultBy}): `), x.result) : null,
    x.reviewNote ? h('div', { class: 'small' }, h('b', {}, `Reviewed (${x.reviewedBy}): `), x.reviewNote) : null,
    x.toldNote ? h('div', { class: 'small' }, h('b', {}, `Told ${x.toldLabel.toLowerCase()} (${x.toldBy}): `), x.toldNote) : null,
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `${x.outcomeLabel}${x.exitLabel ? `: ${x.exitLabel.toLowerCase()}` : ''} (${x.closedBy}): `), x.outcomeNote ?? '') : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.exitLabel ?? x.stateLabel} (${x.endedBy}, ${fmtDateTime(x.endedAt)}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Screening view in the Live Workstation.
export function screeningPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canStart ? h('div', {}, h('button', { class: 'btn primary', onclick: () => startDialog(personId, d.options, reload) }, 'Eligible for a screen')) : null,
    d.open.length ? d.open.map((x) => screeningCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No screening.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Closed, declined or ended (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => screeningCard(x, d, reload)))) : null,
  );
}

// Home → Screening.
export async function screeningView() {
  const d = await get('/api/work/screening');
  const view = { options: {} };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => screeningCard({ ...x, actions: [] }, view, () => go('/work/screening'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Screening', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Screening in your service: results to review, people to tell and close, screens to offer in the next 30 days, and screens under way. Open the person to act.'),
    section('Results to review', d.toReview, 'No results to review.'),
    section('To tell or close', d.toTell, 'Nobody waiting to be told.'),
    section('To offer', d.toOffer, 'Nothing to offer in the next 30 days.'),
    section('Under way', d.inProgress, 'Nothing under way.'),
  );
}
