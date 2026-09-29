import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { state, go } from '../app.js';
import { workHeader } from './entry.js';
import { dialog, field, select } from '../lib/forms.js';

// Downtime: what is down → the paper process to use → back up → each paper record entered at the
// time it happened, marked as from paper → everyone in the service checked → closed.
const TONE = { DECLARED: 'danger', RESTORED: 'warn', CLOSED: 'ok', CANCELLED: '' };
const ago = (n) => (n === 0 ? 'Just now' : n < 60 ? `${n} minutes ago` : `${n / 60} hour${n > 60 ? 's' : ''} ago`);

function declareDialog(d, reload) {
  const boxes = Object.entries(d.functions).map(([k, v]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, 'aria-label': v }), h('span', {}, v)));
  const reason = h('textarea', { 'aria-label': 'What has happened', placeholder: 'e.g. Screens frozen on every computer since 02:10' });
  const started = select(d.startedAgo.map((n) => [String(n), ago(n)]), 'When it started', null);
  dialog(`Declare downtime: ${state.me.context.service}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Everyone in the service will see what is down and the paper process to use until you say it is back up.'),
    h('fieldset', { class: 'stack' }, h('legend', {}, 'What is down?'), boxes),
    field('What has happened?', reason), field('When did it start?', started),
    h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: run(async () => {
      await post('/api/work/downtime', { functions: boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value), reason: reason.value, startedAgo: Number(started.value) });
      close();
      toast('Downtime declared. Use the paper process.');
      reload();
    }) }, 'Declare downtime'))));
}

function noteDialog(x, action, reload) {
  const [title, label, placeholder, submit] = {
    restore: ['SHIFT is back up', 'Note (optional)', 'e.g. Network fixed at 04:40; checked on every computer', 'Back up'],
    cancel: ['Cancel this downtime', 'Why', 'e.g. Declared in error; only one computer was frozen', 'Cancel downtime'],
    close: ['Close this downtime', 'What worked and what to change', 'e.g. Packs were complete; the results sheet ran out', 'Close'],
  }[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, (run, close) => h('div', { class: 'stack' },
    action === 'restore' ? h('p', { class: 'small' }, 'SHIFT will list everyone who was in the service while it was down, so their paper records can be entered and checked off.') : null,
    field(label, note),
    h('div', { class: 'row' }, h('button', { class: `btn ${action === 'cancel' ? 'danger' : 'primary'}`, onclick: run(async () => {
      await post(`/api/work/downtime/${x.id}/${action}`, { note: note.value });
      close();
      toast(action === 'restore' ? 'Back up. Now enter the paper records.' : action === 'close' ? 'Downtime closed.' : 'Cancelled.');
      reload();
    }) }, submit))));
}

function checkDialog(x, c, outcomes, reload) {
  const outcome = select(Object.entries(outcomes), 'What you found');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Checked the downtime pack; no sheets for them' });
  dialog(`Check: ${c.patient}`, (run, close) => h('div', { class: 'stack' },
    h('p', { class: 'small' }, c.entries ? `${c.entries} ${c.entries === 1 ? 'entry' : 'entries'} entered from paper so far.` : 'Nothing entered from paper yet.'),
    field('What you found', outcome), field('Note (needed if there was nothing on paper)', note),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
      await post(`/api/work/downtime/${x.id}/check`, { checkId: c.id, outcome: outcome.value, note: note.value });
      close();
      toast('Checked.');
      reload();
    }) }, 'Save check'))));
}

// Open the person's record ready to enter what was written on paper.
function enterFromPaper(x, c) {
  state.backEntry = { downtimeId: x.id, personId: c.personId, startedAt: x.startedAt, restoredAt: x.restoredAt };
  go(`/work/patient/${c.personId}`);
}

function downtimeCard(x, d, reload) {
  const LABEL = { restore: 'Back up', cancel: 'Cancel', close: 'Close' };
  return h('div', { class: `tile stack downtime dt-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, x.functions.map((f) => f.label).join(', ')), h('span', { class: `tag ${TONE[x.state] ?? ''}` }, x.stateLabel)),
    h('div', { class: 'small' }, x.reason),
    h('div', { class: 'small muted' }, [`Down from ${fmtDateTime(x.startedAt)}`, x.restoredAt ? `back up ${fmtDateTime(x.restoredAt)}` : null, `declared by ${x.declaredBy}`].filter(Boolean).join(' · ')),
    x.state === 'DECLARED' ? h('div', { class: 'stack' }, x.functions.map((f) => h('div', { class: 'small notice' }, h('b', {}, `${f.label}: `), f.process))) : null,
    x.state === 'DECLARED' ? h('p', { class: 'small muted' }, 'These are your organisation\'s processes. What New Zealand requires is still being researched (RR-DOWNTIME-001).') : null,
    x.checks.length ? h('div', { class: 'stack' },
      h('b', { class: 'small' }, `People to check for paper records (${x.checks.length - x.open} of ${x.checks.length} done)`),
      h('ul', { class: 'stack dt-people' }, x.checks.map((c) => h('li', { class: 'spread' },
        h('div', {}, h('b', {}, c.patient), h('div', { class: 'small muted' },
          c.state === 'CHECKED' ? `${c.outcomeLabel}${c.entries ? ` (${c.entries})` : ''} · ${c.checkedBy} ${fmtDateTime(c.checkedAt)}${c.note ? ` · ${c.note}` : ''}`
            : c.entries ? `${c.entries} entered from paper, not yet checked` : 'Not yet checked')),
        c.state === 'TO_CHECK' ? h('div', { class: 'row' },
          x.canEnter ? h('button', { class: 'btn small', onclick: () => enterFromPaper(x, c) }, 'Enter from paper') : null,
          x.canCheck ? h('button', { class: 'btn small primary', onclick: () => checkDialog(x, c, d.outcomes, reload) }, 'Checked') : null) : null)))) : null,
    x.closeNote ? h('div', { class: 'small' }, h('b', {}, `${x.state === 'CANCELLED' ? 'Cancelled' : 'Closed'} by ${x.closedBy}: `), x.closeNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'close' || a === 'restore' ? ' primary' : ''}`, onclick: () => noteDialog(x, a, reload) }, LABEL[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by ?? 'SHIFT'} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// Home → Downtime.
export async function downtimeView() {
  const d = await get('/api/work/downtime');
  const reload = () => go('/work/downtime');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => downtimeCard(x, d, reload)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Downtime', () => go('/work/home')),
    h('div', { class: 'banner' }, 'When SHIFT or part of it is down, care goes on paper using the process shown here. Once it is back, each paper record is entered at the time the care happened, marked as coming from paper, and everyone who was in the service is checked before the downtime is closed.'),
    h('div', { class: 'stack' },
      d.canManage && !d.current.length ? h('div', {}, h('button', { class: 'btn danger', onclick: () => declareDialog(d, reload) }, 'Declare downtime')) : null,
      section('Down now', d.current, 'Nothing is down in your service.'),
      section('Back up: paper records to enter', d.reconciling, 'No paper records waiting to be entered.'),
      section('Ended in the last 14 days', d.ended, 'No downtime in the last 14 days.')),
  );
}
