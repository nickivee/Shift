import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Symptoms: recorded with how bad → assessed → something done → looked at again → gone, controlled or a problem.
const TONE = { RECORDED: 'warn', ASSESSED: 'muted', INTERVENTION: 'warn', REASSESSED: 'muted', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', {},
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { await onSubmit(); dlg.close(); dlg.remove(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; }
    } },
      h('h2', {}, title), body, error,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label, el) => h('label', { class: 'field' }, label, el);
const select = (entries, label, blank = 'Choose…') => h('select', { 'aria-label': label }, blank === null ? null : h('option', { value: '' }, blank), entries.map(([k, v]) => h('option', { value: k }, v)));

// A 0 to 10 scale as eleven buttons, so it works by touch and says what each end means.
function scale(name) {
  let value = '';
  const el = h('fieldset', { class: 'score-scale' }, h('legend', {}, 'How bad, from 0 (none) to 10 (worst imaginable)'),
    h('div', { class: 'score-row' }, Array.from({ length: 11 }, (_, n) => h('label', { class: `score-choice score-${n >= 7 ? 'high' : n >= 4 ? 'mid' : 'low'}` },
      h('input', { type: 'radio', name, value: String(n), 'aria-label': `${n} out of 10`, onchange: () => { value = String(n); } }), String(n)))));
  return { el, get value() { return value; } };
}

function recordDialog(personId, o, reload) {
  const kind = select(Object.entries(o.kinds), 'Symptom');
  const name = h('input', { type: 'text', 'aria-label': 'Name', placeholder: 'e.g. Hiccups' });
  const nameField = field('What it is', name);
  nameField.hidden = true;
  kind.addEventListener('change', () => { nameField.hidden = kind.value !== 'OTHER'; });
  const site = h('input', { type: 'text', 'aria-label': 'Where', placeholder: 'e.g. Right side of chest' });
  const s = scale('rec-score');
  const rated = select(Object.entries(o.whoRated), 'Rated by', null);
  const pattern = select(Object.entries(o.patterns), 'Pattern', 'Not sure');
  const context = h('input', { type: 'text', 'aria-label': 'Brought on by', placeholder: 'e.g. Deep breaths and coughing' });
  const associated = h('input', { type: 'text', 'aria-label': 'Anything else with it', placeholder: 'e.g. Sweaty, short of breath' });
  const onset = h('input', { type: 'datetime-local', 'aria-label': 'Started' });
  dialog('Record a symptom', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Symptom', kind), nameField),
    field('Where (if it has a place)', site),
    s.el, field('Who rated it', rated),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Pattern', pattern), h('label', { class: 'field' }, 'When it started', onset)),
    field('What brings it on', context), field('Anything else with it', associated),
  ), 'Record', async () => {
    await post(`/api/work/patients/${personId}/symptoms`, {
      kind: kind.value, name: name.value, site: site.value, score: s.value, rated: rated.value, pattern: pattern.value,
      context: context.value, associated: associated.value, onset: onset.value ? new Date(onset.value).toISOString() : '',
    });
    toast('Recorded.');
    reload();
  });
}

function assessDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'Assessment', placeholder: 'e.g. Pleuritic pain from her pneumonia; no new signs' });
  dialog(`Assess: ${x.label}`, field('Your assessment', note), 'Save', async () => {
    await post(`/api/work/symptoms/${x.id}/assess`, { note: note.value });
    reload();
  });
}

function interventionDialog(x, o, reload) {
  const note = h('textarea', { 'aria-label': 'What was done', placeholder: 'e.g. Paracetamol 1 g as charted; repositioned on her left side' });
  const mins = h('input', { type: 'number', 'aria-label': 'Look again in (minutes)', min: 5, max: 1440, value: String(o.reassessMins) });
  dialog('What was done for it', h('div', { class: 'stack' }, field('What was done', note), field('Look again in (minutes)', mins)), 'Save', async () => {
    await post(`/api/work/symptoms/${x.id}/intervention`, { note: note.value, mins: mins.value });
    reload();
  });
}

function reassessDialog(x, o, reload) {
  const s = scale('re-score');
  const rated = select(Object.entries(o.whoRated), 'Rated by', null);
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Settled, sleeping' });
  dialog(`Look again: ${x.label}`, h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, `Last rating ${x.latest}/10.`), s.el, field('Who rated it', rated), field('Note', note),
  ), 'Save', async () => {
    await post(`/api/work/symptoms/${x.id}/reassess`, { score: s.value, rated: rated.value, note: note.value });
    reload();
  });
}

function closeDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcomes).filter(([k]) => k !== 'PROBLEM'), 'Outcome');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog('Close: how did it end?', h('div', { class: 'stack' }, field('Outcome', outcome), field('Note', note)), 'Close it', async () => {
    await post(`/api/work/symptoms/${x.id}/close`, { outcome: outcome.value, note: note.value });
    reload();
  });
}

function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = action === 'problem'
    ? ['Follow as a problem', 'Why it needs following as a problem', 'e.g. Breathless on minimal exertion for a week; needs working up', 'Add to problem list']
    : ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, field(label, note), button, async () => {
    await post(`/api/work/symptoms/${x.id}/${action}`, { note: note.value });
    if (action === 'problem') toast('Added to their problem list as a concern.');
    reload();
  });
}

const LABELS = { assess: 'Assess', intervention: 'Something done', reassess: 'Look again', close: 'Close', problem: 'Follow as a problem', error: 'Entered in error' };

const ratings = (x) => h('div', { class: 'score-trail' }, x.scores.map((s, i) => [
  i ? h('span', { class: 'muted' }, '→') : null,
  h('span', { class: `score-pill score-${s.score >= 7 ? 'high' : s.score >= 4 ? 'mid' : 'low'}`, title: `${s.by}, ${fmtDateTime(s.at)}${s.rated === 'OBSERVED' ? ' (staff estimate)' : ''}` }, String(s.score)),
]));

function symptomCard(x, d, reload) {
  const handler = (a) => () => (a === 'assess' ? assessDialog(x, reload) : a === 'intervention' ? interventionDialog(x, d.options, reload)
    : a === 'reassess' ? reassessDialog(x, d.options, reload) : a === 'close' ? closeDialog(x, d.options, reload) : noteDialog(x, a, reload));
  const primary = x.state === 'RECORDED' ? (x.can.includes('assess') ? 'assess' : 'intervention') : x.state === 'INTERVENTION' ? 'reassess' : 'intervention';
  return h('div', { class: `tile stack symptom symptom-${x.state.toLowerCase()}${x.severe ? ' symptom-severe' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, x.label, x.site ? h('span', { class: 'small muted' }, ` · ${x.site}`) : null),
      h('span', { class: `tag ${x.reassessOverdue ? 'danger' : TONE[x.state]}` }, x.state === 'CLOSED' ? x.outcomeLabel : x.reassessOverdue ? 'Look again now' : x.stateLabel)),
    ratings(x),
    h('div', { class: 'small muted' }, [
      `Recorded by ${x.recordedBy} ${fmtDateTime(x.recordedAt)}`, x.onset ? `started ${fmtDateTime(x.onset)}` : null, x.patternLabel,
      x.context ? `brought on by ${x.context}` : null, x.associated ? `with ${x.associated}` : null,
    ].filter(Boolean).join(' · ')),
    x.assessment ? h('div', {}, h('b', {}, 'Assessment: '), x.assessment, h('span', { class: 'small muted' }, ` (${x.assessedBy})`)) : null,
    x.state === 'INTERVENTION' ? h('div', { class: x.reassessOverdue ? 'notice small' : 'small' }, `Look again by ${fmtDateTime(x.reassessDue)}.`) : null,
    x.outcomeNote ? h('div', { class: 'small muted' }, x.outcomeNote) : null,
    x.can.length ? h('div', { class: 'row' }, x.can.map((a) => h('button', { class: `btn small${a === primary ? ' primary' : ''}`, onclick: handler(a) }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Symptoms view in the Live Workstation.
export function symptomsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canRecord ? h('div', {}, h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d.options, reload) }, 'Record a symptom')) : null,
    d.open.length ? d.open.map((x) => symptomCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No symptoms being followed.'),
    h('p', { class: 'small muted' }, 'A .pain entry adds to the pain being followed here.'),
    d.closed.length ? h('details', {}, h('summary', {}, `Closed (${d.closed.length})`), h('div', { class: 'stack' }, d.closed.map((x) => symptomCard(x, d, reload)))) : null,
  );
}

function row(x) {
  return h('div', { class: `tile stack symptom-${x.state.toLowerCase()}${x.severe ? ' symptom-severe' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/symptoms`) }, h('b', {}, x.patient)),
        x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null),
      h('span', { class: `tag ${x.reassessOverdue ? 'danger' : TONE[x.state]}` }, x.reassessOverdue ? 'Look again now' : x.stateLabel)),
    h('div', { class: 'row' }, h('b', {}, `${x.label}${x.site ? ` (${x.site})` : ''}`), ratings(x)),
    x.state === 'INTERVENTION' ? h('div', { class: 'small muted' }, `Look again by ${fmtDateTime(x.reassessDue)}`) : null,
  );
}

// Home → Symptoms.
export async function symptomsView() {
  const d = await get('/api/work/symptoms');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Symptoms', () => go('/work/home')),
    h('div', { class: 'banner' }, `Symptoms being followed for people in your service (${d.followed}): who needs looking at again, who is rating 7 or more, and who is not yet assessed.`),
    section('Look again', d.reassess, 'No one is waiting to be looked at again.'),
    section('Rated 7 or more', d.severe, 'None.'),
    section('Not yet assessed', d.notAssessed, 'None.'),
  );
}
