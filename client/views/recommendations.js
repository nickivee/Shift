import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Recommendations: assessment → recommendation → sent to a role → accepted, changed or declined → what needs doing → implemented or not → reviewed.
const TONE = {
  RECOMMENDED: 'muted', COMMUNICATED: 'warn', ACCEPTED: 'ok', MODIFIED: 'ok', DECLINED: 'danger', IMPLEMENTED: 'ok', NOT_IMPLEMENTED: 'danger',
  REVIEWED: 'muted', WITHDRAWN: 'muted', ENTERED_IN_ERROR: 'muted',
};

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const send = (x, action, body) => post(`/api/work/recommendations/${x.id}/${action}`, body);

function makeDialog(personId, o, reload) {
  const basis = h('textarea', { 'aria-label': 'Assessment', placeholder: 'e.g. Unsteady when turning; walks safely with a frame' });
  const what = h('input', { type: 'text', 'aria-label': 'Recommendation', placeholder: 'e.g. Walk with her frame and one person beside her' });
  const to = select(o.recipients.map((r) => [r.id, r.label]), 'For');
  const by = h('input', { type: 'date', 'aria-label': 'Put in place by', min: today() });
  const channel = select(Object.entries(o.channels), 'Send', 'Not yet (save it for now)');
  channel.value = 'SHIFT';
  dialog('Make a recommendation', h('div', { class: 'stack' },
    field('What your assessment found', basis), field('What you recommend', what), field('For', to), field('Put in place by (optional)', by), field('Send it', channel),
  ), 'Save', async () => {
    await post(`/api/work/patients/${personId}/recommendations`, { basis: basis.value, what: what.value, to: to.value, implementBy: by.value, channel: channel.value });
    toast(channel.value ? 'Recommendation sent.' : 'Recommendation saved.');
    reload();
  });
}

function sendDialog(x, o, reload) {
  const channel = select(Object.entries(o.channels), 'How');
  const note = h('input', { type: 'text', 'aria-label': 'Note', placeholder: 'Optional, e.g. Told Grace at the bedside' });
  dialog(`Send: ${x.what}`, h('div', { class: 'stack' }, field('How you told them', channel), field('Note', note)), 'Send', async () => {
    await send(x, 'send', { channel: channel.value, note: note.value });
    reload();
  });
}

function respondDialog(x, action, reload) {
  const modifying = action === 'modify';
  const what = h('input', { type: 'text', 'aria-label': 'Change it to', value: x.what });
  const requirement = h('input', { type: 'text', 'aria-label': 'What needs doing', placeholder: 'e.g. Add to her care plan; walk her to the toilet at night' });
  const by = h('input', { type: 'date', 'aria-label': 'Done by', min: today(), value: x.implementBy ?? '' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: modifying ? 'Why you changed it' : 'Optional' });
  dialog(modifying ? 'Accept with changes' : `Accept: ${x.what}`, h('div', { class: 'stack' },
    modifying ? field('Change it to', what) : null,
    field('What needs doing to put it in place', requirement), field('Done by (optional)', by), field(modifying ? 'Why you changed it' : 'Note', note),
  ), modifying ? 'Accept with changes' : 'Accept', async () => {
    await send(x, action, { what: what.value, requirement: requirement.value, implementBy: by.value, note: note.value });
    reload();
  });
}

function notDoneDialog(x, o, reload) {
  const reason = select(Object.entries(o.notDone), 'Why');
  const note = h('textarea', { 'aria-label': 'What happened instead', placeholder: 'e.g. Declined to sit out; tired after physio. Will offer again tomorrow' });
  dialog('Not implemented', h('div', { class: 'stack' }, field('Why', reason), field('What happened instead', note)), 'Save', async () => {
    await send(x, 'not-implemented', { reason: reason.value, note: note.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  decline: ['Decline', 'Why you are declining it', 'e.g. She walks safely alone in the day; supervision at night only', 'Decline'],
  implemented: ['Implemented', 'Note', 'Optional, e.g. In her care plan; sat out for lunch', 'Save'],
  review: ['Review', 'What you found', 'e.g. Walking safely with the frame; no falls', 'Save'],
  withdraw: ['Withdraw', 'Why', 'e.g. No longer needed; going home today', 'Withdraw'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.what}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = {
  send: 'Send', accept: 'Accept', modify: 'Accept with changes', decline: 'Decline', implemented: 'Implemented', 'not-implemented': 'Not implemented',
  review: 'Review', withdraw: 'Withdraw', error: 'Entered in error',
};
const PRIMARY = ['send', 'accept', 'implemented', 'review'];

function recommendationCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'send' ? sendDialog(x, o, reload) : ['accept', 'modify'].includes(a) ? respondDialog(x, a, reload)
    : a === 'not-implemented' ? notDoneDialog(x, o, reload) : noteDialog(x, a, reload));
  return h('div', { class: `tile stack recommendation recommendation-${x.state.toLowerCase()}${x.overdue ? ' recommendation-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/recommendations`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.modifiedWhat ?? x.what),
      h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? 'Overdue' : x.stateLabel)),
    x.modifiedWhat ? h('div', { class: 'small muted' }, `Originally: ${x.what}`) : null,
    h('div', { class: 'small' }, h('b', {}, 'Assessment: '), x.basis),
    h('div', { class: 'small muted' }, [
      `From ${x.madeBy}, ${x.fromRole}, ${x.fromService}`, `for the ${x.toRole}, ${x.toService}`,
      x.channelLabel ? `${x.channelLabel.toLowerCase()} ${fmtDateTime(x.communicatedAt)}` : 'not sent yet',
    ].join(' · ')),
    x.requirement ? h('div', { class: 'small' }, h('b', {}, 'To do: '), `${x.requirement}${x.implementBy ? ` · by ${x.implementBy}` : ''} (${x.respondedBy})`) : null,
    x.state === 'DECLINED' ? h('div', { class: 'small' }, h('b', {}, `Declined by ${x.respondedBy}: `), x.response) : null,
    x.implementedBy ? h('div', { class: 'small' }, h('b', {}, `${x.state === 'NOT_IMPLEMENTED' || x.notDoneLabel ? 'Not implemented' : 'Implemented'} (${x.implementedBy}, ${fmtDateTime(x.implementedAt)}): `),
      [x.notDoneLabel, x.implementationNote].filter(Boolean).join('. ') || 'Done.') : null,
    x.reviewNote ? h('div', { class: 'small muted' }, `${x.state === 'REVIEWED' ? 'Reviewed' : x.stateLabel} by ${x.reviewedBy} ${fmtDateTime(x.reviewedAt)}: ${x.reviewNote}`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Recommendations view in the Live Workstation.
export function recommendationsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canMake ? h('div', {}, h('button', { class: 'btn primary', onclick: () => makeDialog(personId, d.options, reload) }, 'Make a recommendation')) : null,
    d.open.length ? d.open.map((x) => recommendationCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No open recommendations.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Reviewed or withdrawn (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => recommendationCard(x, d, reload)))) : null,
  );
}

// Home → Recommendations.
export async function recommendationsView() {
  const d = await get('/api/work/recommendations');
  const reload = () => go('/work/recommendations');
  const view = { options: { channels: {}, notDone: {} } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => recommendationCard({ ...x, actions: [] }, view, reload, true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Recommendations', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Recommendations for your role to respond to, ones your team has accepted and still has to put in place, and your own ready to review. Open the person to act.'),
    section('To respond to', d.toRespond, 'Nothing waiting for you.'),
    section('To put in place', d.toImplement, 'Nothing to put in place.'),
    section('To review', d.toReview, 'Nothing to review.'),
    section('Sent and waiting', d.waiting, 'None waiting.'),
  );
}
