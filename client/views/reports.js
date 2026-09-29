import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// In their own words: what the person (or someone for them) said → who, how and when → read by a
// clinician where needed → used in their care → updated or corrected by them, earlier words kept.
const STATE_TONE = { 'To review': 'danger', Recorded: '', Reviewed: 'ok', Replaced: 'muted' };
const CHANGE = { UPDATE: 'Things changed', CORRECTION: 'They corrected it' };

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

const localNow = () => {
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// What they said, how, when, and whether a clinician should read it. Shared by recording and changing.
function saidFields(options, topic, reviewDefault) {
  const f = {
    words: h('textarea', { placeholder: 'Their words, as they said them' }),
    rating: h('input', { type: 'number', min: 0, max: 10, step: 1, placeholder: '0 to 10' }),
    aboutWhen: h('input', { type: 'text', placeholder: 'e.g. last night, since Tuesday (optional)' }),
    how: select(options.how, 'IN_PERSON'),
    reportedAt: h('input', { type: 'datetime-local', value: localNow() }),
    needsReview: h('input', { type: 'checkbox', checked: reviewDefault }),
  };
  const ratingField = h('label', { class: 'field' }, 'How bad, 0 (none) to 10 (worst)', f.rating);
  const sync = (t) => { ratingField.hidden = !options.rated.includes(t); };
  sync(topic);
  const body = h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What they said', f.words),
    ratingField,
    h('label', { class: 'field' }, 'About when', f.aboutWhen),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How', f.how), h('label', { class: 'field grow' }, 'When they said it', f.reportedAt)),
    h('label', { class: 'check' }, f.needsReview, ' A nurse, doctor or physio should read this'),
    h('p', { class: 'small muted' }, 'A score of 7 or more always goes to them.'),
  );
  const values = () => ({
    words: f.words.value, rating: f.rating.value, aboutWhen: f.aboutWhen.value, how: f.how.value,
    reportedAt: f.reportedAt.value ? new Date(f.reportedAt.value).toISOString() : '', needsReview: f.needsReview.checked,
  });
  return { body, values, sync };
}

function reviewDialog(r, reload) {
  const outcome = select({ INCORPORATED: 'It changed their care', NOTED: 'Read; no change needed' }, 'INCORPORATED');
  const note = h('textarea', { placeholder: 'What it changed, e.g. "Night-time pain relief added to the chart"' });
  dialog(`Review: ${r.topicLabel}`, h('div', { class: 'stack' },
    h('blockquote', { class: 'said' }, `“${r.words}”`),
    h('label', { class: 'field' }, 'Outcome', outcome),
    h('label', { class: 'field' }, 'Note', note),
  ), 'Save review', async () => {
    await post(`/api/work/reports/${r.id}/review`, { outcome: outcome.value, note: note.value });
    toast('Reviewed.');
    reload();
  });
}

function changeDialog(r, action, options, reload) {
  const f = saidFields(options, r.topic, r.needsReview);
  dialog(action === 'update' ? `${r.topicLabel}: things changed` : `${r.topicLabel}: they corrected it`, h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, action === 'update' ? 'What they say now. What they said before is kept.' : 'What they say is right. What was recorded before is kept, marked as corrected.'),
    f.body,
  ), 'Save', async () => {
    await post(`/api/work/reports/${r.id}/${action}`, f.values());
    toast('Saved. The earlier words are kept.');
    reload();
  });
}

const ACTION = { review: ['Review', true], update: ['Things changed', false], correct: ['They corrected it', false] };

export function reportCard(r, options, reload, showPatient) {
  const scored = r.rating !== null && r.rating !== undefined;
  return h('div', { class: `tile stack report${r.needsReview && r.state === 'RECORDED' ? ' report-review' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${r.personId}/reported`) }, h('b', {}, r.patient)) : null,
        h('div', {}, h('b', {}, r.topicLabel), scored ? h('span', { class: `tag ${r.rating >= 7 ? 'danger' : 'warn'}` }, ` ${r.rating}/10`) : null),
        showPatient && r.location ? h('div', { class: 'small muted' }, r.location) : null),
      h('span', { class: `tag ${STATE_TONE[r.stateLabel] ?? ''}` }, r.stateLabel),
    ),
    h('blockquote', { class: 'said' }, `“${r.words}”`),
    h('div', { class: 'small muted' }, [
      r.source === 'PATIENT' ? 'Said by them' : `${r.sourceLabel}${r.sourceName ? ` (${r.sourceName})` : ''}`,
      r.howLabel, fmtDateTime(r.reportedAt), r.aboutWhen ? `about ${r.aboutWhen}` : null,
    ].filter(Boolean).join(' · ')),
    r.changeKind ? h('div', { class: 'small' }, h('span', { class: 'tag' }, CHANGE[r.changeKind])) : null,
    r.reviewedBy ? h('div', { class: 'small' }, h('b', {}, r.reviewOutcome === 'INCORPORATED' ? `Changed their care (${r.reviewedBy}): ` : `Read by ${r.reviewedBy}`), r.reviewNote ?? '') : null,
    h('div', { class: 'small muted' }, `Recorded by ${r.recordedBy} (${r.service}) ${fmtDateTime(r.recordedAt)}`),
    r.earlier?.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier versions (${r.earlier.length})`),
      h('div', { class: 'stack' }, r.earlier.map((e) => reportCard(e, options, reload, false)))) : null,
    r.actions.length ? h('div', { class: 'row' }, r.actions.map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => (a === 'review' ? reviewDialog(r, reload) : changeDialog(r, a, options, reload)) }, ACTION[a][0]))) : null,
  );
}

function recordForm(personId, d, reload) {
  const topic = select({ '': 'Choose…', ...d.options.topics }, '');
  const source = select(d.options.sources, 'PATIENT');
  const sourceName = h('input', { type: 'text', placeholder: 'Who, and how they are related, e.g. Karen, daughter' });
  const nameField = h('label', { class: 'field' }, 'Who told you', sourceName);
  const f = saidFields(d.options, '', !d.canReview);
  topic.addEventListener('change', () => f.sync(topic.value));
  const syncSource = () => { nameField.hidden = source.value === 'PATIENT'; };
  source.addEventListener('change', syncSource);
  syncSource();
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/reports`, { topic: topic.value, source: source.value, sourceName: sourceName.value, ...f.values() });
      toast('Recorded in their words.');
      reload();
    } catch (err) { showError(err); }
  } },
    h('h3', {}, 'Record what they told you'),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'About', topic), h('label', { class: 'field grow' }, 'From', source)),
    nameField, f.body,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Record')),
  );
}

// The person's "In their words" view in the Live Workstation.
export function reportsPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'What they told us, kept in their words. When they say something has changed or was wrong, record it here; what they said before is kept.'),
    d.canRecord ? h('details', {}, h('summary', {}, 'Record what they told you'), recordForm(personId, d, reload)) : null,
    d.reports.length ? d.reports.map((r) => reportCard(r, d.options, reload, false))
      : h('div', { class: 'empty' }, `Nothing recorded in this ${subject}'s own words yet.`),
  );
}

// Home → In their own words.
export async function reportsView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/reports');
    mount(root,
      workHeader(),
      pageTitle('In their own words', () => go('/work/home')),
      h('div', { class: 'banner' }, 'What people in this service have told staff that a clinician should read. Highest scores first.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `To review (${d.toReview.length})`),
        d.toReview.length ? d.toReview.map((r) => reportCard(r, d.options, load, true)) : h('div', { class: 'card empty' }, 'Nothing waiting to be read.')),
      d.reviewed.length ? h('details', {}, h('summary', {}, `Reviewed in the last 3 days (${d.reviewed.length})`),
        h('div', { class: 'stack' }, d.reviewed.map((r) => reportCard(r, d.options, load, true)))) : null,
    );
  };
  await load();
  return root;
}
