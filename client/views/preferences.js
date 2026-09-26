import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Patient preferences: expressed, in their words → who said it and when it applies → read by
// the people caring for them → followed where possible, and said so when it could not be →
// changed or withdrawn, never overwritten.
const NOT_A_DIRECTIVE = 'A preference is not consent and not an advance directive. How advance directives are recorded is still being researched (RR-ADVDIR-001).';
const TONE = { MET: 'ok', PARTLY: 'warn', NOT_MET: 'danger' };

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
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
      ),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value) s.value = value;
  return s;
};

// The fields that say what a preference is, shared by recording one and changing one.
function fields(options, p = {}) {
  const f = {
    category: select(options.categories, p.category ?? 'ROUTINE'),
    statement: h('textarea', { placeholder: 'In their words, e.g. "I like a shower at night, not in the morning"' }),
    source: select({ '': 'Choose…', ...options.sources }, p.source ?? ''),
    sourceName: h('input', { type: 'text', value: p.sourceName ?? '', placeholder: 'Who told you, or which document' }),
    context: h('input', { type: 'text', value: p.context ?? '', placeholder: 'When or where it applies (optional)' }),
    relevance: select(options.relevance, p.relevance ?? 'ALWAYS'),
    reviewDate: h('input', { type: 'date', value: p.reviewDate ?? '' }),
  };
  f.statement.value = p.statement ?? '';
  const who = h('label', { class: 'field' }, 'Who', f.sourceName);
  const directive = h('p', { class: 'small notice' }, NOT_A_DIRECTIVE);
  const sync = () => {
    who.hidden = !['WHANAU', 'SUPPORT_PERSON', 'DOCUMENT'].includes(f.source.value);
    directive.hidden = f.category.value !== 'TREATMENT';
  };
  f.source.addEventListener('change', sync);
  f.category.addEventListener('change', sync);
  sync();
  const body = h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'About', f.category), directive,
    h('label', { class: 'field' }, 'Preference', f.statement),
    h('label', { class: 'field' }, 'Expressed by', f.source), who,
    h('label', { class: 'field' }, 'When it applies', f.context),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How long', f.relevance), h('label', { class: 'field grow' }, 'Review by (optional)', f.reviewDate)),
  );
  return { body, values: () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) };
}

function outcomeDialog(p, options, reload) {
  const outcome = select(options.outcomes, 'MET');
  const note = h('textarea', { placeholder: 'Why it could not be fully followed, and what they were told' });
  const noteField = h('label', { class: 'field' }, 'Why', note);
  const sync = () => { noteField.hidden = outcome.value === 'MET'; };
  outcome.addEventListener('change', sync);
  sync();
  dialog('Was it followed?', h('div', { class: 'stack' }, h('p', {}, p.statement), h('label', { class: 'field' }, 'Outcome', outcome), noteField), 'Save', async () => {
    await post(`/api/work/preferences/${p.id}/outcome`, { outcome: outcome.value, note: note.value });
    toast('Recorded.');
    reload();
  });
}

function changeDialog(p, options, reload) {
  const f = fields(options, p);
  const note = h('input', { type: 'text', placeholder: 'What changed and who said so' });
  dialog('Change this preference', h('div', { class: 'stack' }, f.body, h('label', { class: 'field' }, 'Why it changed', note)), 'Save change', async () => {
    await post(`/api/work/preferences/${p.id}/change`, { ...f.values(), note: note.value });
    toast('Preference changed. The earlier one is kept.');
    reload();
  });
}

async function doAction(p, action, options, reload) {
  if (action === 'outcome') return outcomeDialog(p, options, reload);
  if (action === 'change') return changeDialog(p, options, reload);
  let note = '';
  if (action === 'withdraw') {
    note = await ask({ title: 'No longer their preference', message: p.statement, label: 'Why, and who said so', confirm: 'Withdraw', multiline: true, minLength: 3 });
    if (!note) return;
  }
  try {
    await post(`/api/work/preferences/${p.id}/${action}`, { note });
    toast(action === 'read' ? 'Marked as read.' : 'Preference withdrawn.');
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { read: ['I have read this', true], outcome: ['Was it followed?', false], change: ['Change', false], withdraw: ['Withdraw', false] };

export function preferenceCard(p, options, reload, { showPatient = true } = {}) {
  const closed = p.state !== 'ACTIVE';
  return h('div', { class: `tile stack preference${closed ? ' muted' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${p.personId}/preferences`) }, h('b', {}, p.patient)) : null,
        h('div', { class: 'small muted' }, p.categoryLabel),
      ),
      h('div', { class: 'row' },
        closed ? h('span', { class: 'tag muted' }, p.state === 'WITHDRAWN' ? 'Withdrawn' : 'Changed') : h('span', { class: 'tag' }, p.relevanceLabel),
        p.reviewDue ? h('span', { class: 'tag warn' }, 'Review due') : null,
        !closed && !p.read ? h('span', { class: 'tag danger' }, 'New to you') : null),
    ),
    h('blockquote', { class: 'pref-quote' }, p.statement),
    p.context ? h('div', { class: 'small' }, h('b', {}, 'When: '), p.context) : null,
    h('div', { class: 'small' }, h('b', {}, 'From: '), p.sourceLabel, p.sourceName ? ` (${p.sourceName})` : ''),
    p.outcomes.length ? h('ul', { class: 'small stack' }, p.outcomes.map((o) => h('li', {},
      h('span', { class: `tag ${TONE[o.outcome] ?? ''}` }, o.outcomeLabel), ` ${o.by}, ${fmtDateTime(o.at)}`, o.note ? `: ${o.note}` : ''))) : null,
    p.closeReason ? h('div', { class: 'small' }, h('b', {}, `${p.state === 'WITHDRAWN' ? 'Withdrawn' : 'Changed'} (${p.closedBy}): `), p.closeReason) : null,
    h('div', { class: 'small muted' }, [
      `Recorded by ${p.recordedBy}, ${p.service}, ${fmtDateTime(p.recordedAt)}`,
      p.reviewDate ? `review by ${fmtDate(p.reviewDate)}` : null,
      p.acks.length ? `read by ${p.acks.map((a) => a.by).join(', ')}` : null,
    ].filter(Boolean).join(' · ')),
    p.actions.length ? h('div', { class: 'row' }, p.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(p, x, options, reload) }, ACTION[x][0]))) : null,
  );
}

function recordForm(personId, d, reload) {
  const f = fields(d.options);
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/preferences`, f.values());
      toast('Preference recorded.');
      reload();
    } catch (err) { showError(err); }
  } }, h('h3', {}, 'Record a preference'), f.body, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Record')));
}

// The person's Preferences view inside the Live Workstation.
export function preferencesPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.preferences.length ? d.preferences.map((p) => preferenceCard(p, d.options, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, `No preferences recorded for this ${subject} yet. Ask them what matters to them.`),
    d.canRecord ? recordForm(personId, d, reload) : null,
    d.past.length ? h('details', {}, h('summary', {}, `Changed or withdrawn (${d.past.length})`),
      h('div', { class: 'stack' }, d.past.map((p) => preferenceCard(p, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Preferences.
export async function preferencesView() {
  const root = h('div');
  const load = async () => {
    const { preferences, options } = await get('/api/work/preferences');
    const fresh = preferences.filter((p) => !p.read || p.reviewDue);
    const rest = preferences.filter((p) => !fresh.includes(p));
    mount(root,
      workHeader(),
      pageTitle('Preferences', () => go('/work/home')),
      h('div', { class: 'banner' }, 'What matters to the people you are caring for, in their words. New ones you have not read come first.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `New to you or due for review (${fresh.length})`),
        fresh.length ? fresh.map((p) => preferenceCard(p, options, load)) : h('div', { class: 'card empty' }, 'You are up to date.')),
      rest.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Everyone else'), rest.map((p) => preferenceCard(p, options, load))) : null,
    );
  };
  await load();
  return root;
}
