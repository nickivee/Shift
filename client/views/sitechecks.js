import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Site checks: procedure planned → intended site and side → checked against a document → with the
// person → site marked → team time-out → any mismatch stops it until resolved → verified → done.
const TONE = { PLANNED: 'warn', DISCREPANCY: 'danger', VERIFIED: 'ok', DONE: 'muted', CANCELLED: 'muted', ENTERED_IN_ERROR: 'muted' };
const KINDS = ['SOURCE', 'PATIENT', 'MARK', 'TEAM'];
const SHORT = { MATCH: 'Matches', MISMATCH: 'Does not match', UNABLE: 'Person cannot confirm', NOT_REQUIRED: 'Not required' };

const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const send = (x, action, body) => post(`/api/work/sitechecks/${x.id}/${action}`, body);
const choice = (name, value, label, onchange) => h('label', { class: 'trend-choice' }, h('input', { type: 'radio', name, value, onchange }), label);

function siteFields(o, x = null) {
  const site = h('input', { type: 'text', 'aria-label': 'Site', placeholder: 'e.g. Knee, Pleural space, Big toe', value: x?.site ?? '' });
  const side = select(Object.entries(o.sides), 'Side');
  const detail = h('input', { type: 'text', 'aria-label': 'More detail', placeholder: 'Optional, e.g. 5th intercostal space, mid-axillary line', value: x?.detail ?? '' });
  if (x) side.value = x.side;
  return { body: () => ({ site: site.value, side: side.value, detail: detail.value }), fields: [field('Site', site), field('Side', side), field('More detail', detail)] };
}

function planDialog(personId, d, reload) {
  const procedure = h('input', { type: 'text', 'aria-label': 'Procedure', placeholder: 'e.g. Knee aspiration' });
  const when = h('input', { type: 'datetime-local', 'aria-label': 'Planned for', value: local(new Date(Date.now() + 2 * 3_600_000)) });
  const s = siteFields(d.options);
  dialog('Plan a procedure site check', h('div', { class: 'stack' }, field('Procedure', procedure), field('Planned for', when), ...s.fields), 'Plan', async () => {
    await post(`/api/work/patients/${personId}/sitechecks`, { procedure: procedure.value, plannedFor: when.value ? new Date(when.value).toISOString() : '', ...s.body() });
    toast('Site check planned. Check it against a document, with the person, mark it and do a team time-out.');
    reload();
  });
}

function checkDialog(x, o, reload, kind0 = '') {
  let kind = kind0;
  const outcome = select([], 'What it found');
  const source = select(Object.entries(o.sources), 'Document');
  const sourceField = field('Document', source);
  const stated = h('input', { type: 'text', 'aria-label': 'What it says instead', placeholder: 'e.g. Left knee' });
  const statedField = field('What it says instead', stated);
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  const sync = () => {
    const keep = outcome.value;
    outcome.replaceChildren(h('option', { value: '' }, 'Choose…'), ...(o.outcomesFor[kind] ?? []).map((k) => h('option', { value: k }, o.outcomes[k])));
    if ((o.outcomesFor[kind] ?? []).includes(keep)) outcome.value = keep;
    sourceField.hidden = kind !== 'SOURCE';
    statedField.hidden = outcome.value !== 'MISMATCH';
    note.placeholder = outcome.value === 'UNABLE' ? 'Why, and who else you checked with, e.g. Drowsy; confirmed with daughter Mere'
      : outcome.value === 'NOT_REQUIRED' ? 'Why no mark is needed, e.g. Midline, no side' : 'Optional';
  };
  outcome.addEventListener('change', sync);
  const kinds = h('fieldset', { class: 'row' }, h('legend', {}, 'Check'), KINDS.map((k) => choice('kind', k, o.kinds[k], () => { kind = k; sync(); })));
  if (kind) kinds.querySelector(`input[value="${kind}"]`).checked = true;
  sync();
  dialog(`Check: ${x.procedure}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, 'Planned: '), x.where),
    kinds, field('What it found', outcome), sourceField, statedField, field('Note', note)), 'Save check', async () => {
    await send(x, 'check', { kind, outcome: outcome.value, source: kind === 'SOURCE' ? source.value : '', stated: stated.value, note: note.value });
    if (outcome.value === 'MISMATCH') toast('Stop. The site does not match. The person doing the procedure must resolve it.');
    reload();
  });
}

function resolveDialog(x, o, reload) {
  let keep = '';
  const s = siteFields(o, x);
  const change = h('div', { class: 'stack', hidden: true }, h('div', { class: 'small muted' }, 'The correct site. Every check must then be done again.'), ...s.fields);
  const note = h('textarea', { 'aria-label': 'How you resolved it', placeholder: 'e.g. Rechecked the CT with radiology: the effusion is on the right' });
  dialog(`Resolve: ${x.procedure}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, 'Planned: '), x.where),
    x.mismatches.map((m) => h('div', { class: 'small notice' }, `${m.kindLabel}${m.sourceLabel ? ` (${m.sourceLabel.toLowerCase()})` : ''} says: ${m.stated}`)),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Which is right?'),
      choice('keep', 'KEEP', 'The planned site is right', () => { keep = 'KEEP'; change.hidden = true; }),
      choice('keep', 'CHANGE', 'Change the planned site', () => { keep = 'CHANGE'; change.hidden = false; })),
    change, field('How you resolved it', note)), 'Resolve', async () => {
    if (!keep) throw new Error('Choose which is right.');
    await send(x, 'resolve', { keep, note: note.value, ...(keep === 'CHANGE' ? s.body() : {}) });
    reload();
  });
}

function doneDialog(x, reload) {
  let matched = '';
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When it was done', value: local(new Date()) });
  const ref = h('input', { type: 'text', 'aria-label': 'Where it is recorded', placeholder: 'e.g. Procedure note 1030' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Done: ${x.procedure}`, h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, 'Verified: '), x.where),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Done on the verified site and side?'),
      choice('matched', 'YES', 'Yes', () => { matched = 'YES'; note.placeholder = 'Optional'; }),
      choice('matched', 'NO', 'No', () => { matched = 'NO'; note.placeholder = 'Where it was done and what happened. Report an incident too.'; })),
    field('When it was done', when), field('Where it is recorded', ref), field('Note', note)), 'Save', async () => {
    await send(x, 'done', { matched, when: when.value ? new Date(when.value).toISOString() : '', ref: ref.value, note: note.value });
    if (matched === 'NO') toast('Recorded as done on a different site. Please report an incident.');
    reload();
  });
}

function noteDialog(x, action, title, label, placeholder, submit, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.procedure}`, field(label, note), submit, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

function verifyDialog(x, reload) {
  dialog(`Verify: ${x.procedure}`, h('div', { class: 'stack' },
    h('div', {}, h('b', {}, x.where)),
    h('ul', { class: 'small' }, x.checks.map((c) => h('li', {}, `${c.kindLabel}: ${c.outcomeLabel.toLowerCase()}${c.sourceLabel ? ` (${c.sourceLabel.toLowerCase()})` : ''}`)))),
  'Site verified', async () => {
    await send(x, 'verify', {});
    reload();
  });
}

const LABELS = { check: 'Record a check', verify: 'Site verified', resolve: 'Resolve', done: 'Procedure done', concern: 'Raise a concern', cancel: 'Cancel', error: 'Entered in error' };
const PRIMARY = ['verify', 'resolve', 'done'];

function stepText(s) {
  return [s.sourceLabel, s.outcomeLabel, s.stated ? `says ${s.stated}` : null, s.note].filter(Boolean).join(' · ');
}

function checkRow(x, k, o) {
  const got = x.checks.filter((c) => c.kind === k);
  const last = got[got.length - 1];
  const tone = !last ? 'todo' : last.outcome === 'MISMATCH' ? 'bad' : 'ok';
  return h('li', { class: `site-check site-${tone}` },
    h('b', {}, o.kinds[k]), ' ',
    last ? h('span', {}, `${SHORT[last.outcome] ?? last.outcomeLabel}${last.sourceLabel ? ` (${last.sourceLabel.toLowerCase()})` : ''}${last.stated ? `: says ${last.stated}` : ''} · ${last.by}`)
      : h('span', { class: 'muted' }, 'Not done yet'));
}

function siteCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'check' ? checkDialog(x, o, reload) : a === 'verify' ? verifyDialog(x, reload) : a === 'resolve' ? resolveDialog(x, o, reload)
    : a === 'done' ? doneDialog(x, reload)
    : a === 'concern' ? noteDialog(x, 'concern', 'Concern', 'What worries you', 'e.g. He says it is the other knee that hurts', 'Stop and raise concern', reload)
    : a === 'cancel' ? noteDialog(x, 'cancel', 'Cancel', 'Why', 'e.g. Effusion too small to tap', 'Cancel it', reload)
    : noteDialog(x, 'error', 'Entered in error', 'Why', 'e.g. Planned for the wrong person', 'Mark as error', reload));
  const flag = x.state === 'DONE' && x.doneMismatch ? ['Done on a different site', 'danger'] : [x.stateLabel, TONE[x.state]];
  const tone = x.state === 'DISCREPANCY' || x.doneMismatch ? 'alert' : x.state === 'VERIFIED' ? 'active' : x.state === 'PLANNED' ? 'waiting' : 'ended';
  const open = ['PLANNED', 'DISCREPANCY', 'VERIFIED'].includes(x.state);
  return h('div', { class: `tile stack site site-card-${tone}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/sitechecks`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.procedure), h('span', { class: `tag ${flag[1]}` }, flag[0])),
    h('div', { class: 'site-where' }, x.where),
    h('div', { class: 'small' }, `Planned for ${fmtDateTime(x.plannedFor)} by ${x.plannedBy}`),
    x.state === 'DISCREPANCY' ? h('div', { class: 'small notice' }, h('b', {}, 'Stop. '),
      x.mismatches.length ? x.mismatches.map((m) => `${m.kindLabel}${m.sourceLabel ? ` (${m.sourceLabel.toLowerCase()})` : ''} says ${m.stated}`).join('; ') : 'A concern was raised after it was verified',
      '. Do not go ahead until the person doing the procedure resolves it.') : null,
    open ? h('ul', { class: 'site-checks' }, KINDS.map((k) => checkRow(x, k, o))) : null,
    x.state === 'PLANNED' && x.todo.length ? h('div', { class: 'small muted' }, `Still needed: ${x.todo.join('; ')}`) : null,
    x.verifiedBy ? h('div', { class: 'small' }, `Verified by ${x.verifiedBy} · ${fmtDateTime(x.verifiedAt)}`) : null,
    x.state === 'DONE' ? h('div', { class: 'small' }, h('b', {}, `Done (${x.doneBy}, ${fmtDateTime(x.doneAt)}): `), `${x.doneRef}${x.doneNote ? `. ${x.doneNote}` : ''}`) : null,
    x.endedNote && x.state !== 'DONE' ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy}): `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: `det-step${s.superseded ? ' muted' : ''}` },
        h('div', { class: 'spread' }, h('b', {}, `${s.kindLabel}${s.superseded ? ' (replaced)' : ''}`), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, stepText(s)))))),
  );
}

// The person's Site checks view in the Live Workstation.
export function sitechecksPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canPlan ? h('div', {}, h('button', { class: 'btn primary', onclick: () => planDialog(personId, d, reload) }, 'Plan a site check')) : null,
    d.open.length ? d.open.map((x) => siteCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No procedures being checked now.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Earlier procedures (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => siteCard(x, d, reload)))) : null,
  );
}

// Home → Site checks.
export async function sitechecksView() {
  const d = await get('/api/work/sitechecks');
  const view = { options: { kinds: { SOURCE: 'Checked against a document', PATIENT: 'Checked with the person', MARK: 'Site marked', TEAM: 'Team time-out' } } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => siteCard({ ...x, actions: [] }, view, () => go('/work/sitechecks'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Site checks', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Procedures in your service whose site and side are being checked: mismatches to resolve first, then checks still to do, then sites verified and ready. Open the person to act.'),
    section('Site does not match', d.discrepancies, 'No mismatches.'),
    section('Being checked', d.checking, 'Nothing being checked.'),
    section('Verified and ready', d.verified, 'Nothing verified and waiting.'),
  );
}
