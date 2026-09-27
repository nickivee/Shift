import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Usual state: what is usual for them → what is different now → what is being done → how it ended.
const TONE = { NOTICED: 'danger', ACTING: 'warn', CLOSED: 'muted' };

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
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

const rangeInputs = (m, low, high) => [
  h('input', { type: 'number', step: 'any', min: m.min, max: m.max, placeholder: 'From', value: low ?? '', 'aria-label': 'From' }),
  h('input', { type: 'number', step: 'any', min: m.min, max: m.max, placeholder: 'To', value: high ?? '', 'aria-label': 'To' }),
];

function usualDialog(personId, d, area, reload) {
  const u = area.usual;
  const statement = h('textarea', { placeholder: d.options.domains.find((x) => x.domain === area.domain || x.id === area.domain)?.hint ?? '' });
  statement.value = u?.statement ?? '';
  const [low, high] = area.measure ? rangeInputs(area.measure, u?.low, u?.high) : [null, null];
  const source = select({ '': 'Choose…', ...d.options.sources }, u?.source ?? '');
  const sourceName = h('input', { type: 'text', placeholder: 'Who, or which record and its date', value: u?.sourceName ?? '' });
  dialog(`Usual ${area.label.toLowerCase()}`, h('div', { class: 'stack' },
    area.measure ? h('div', { class: 'stack' },
      h('div', { class: 'row usual-range' }, h('label', { class: 'field' }, `Usual range (${area.measure.unit})`, h('div', { class: 'row' }, low, h('span', {}, 'to'), high))),
      h('p', { class: 'small muted' }, 'What is normal for them. It does not change early warning scores or any prescribed target.')) : null,
    h('label', { class: 'field' }, area.measure ? 'In words (optional)' : 'What is usual for them', statement),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Where this comes from', source), h('label', { class: 'field grow' }, 'Who or which record', sourceName)),
  ), 'Save', async () => {
    await post(`/api/work/patients/${personId}/usual`, {
      domain: area.domain, statement: statement.value, low: low?.value ?? '', high: high?.value ?? '', source: source.value, sourceName: sourceName.value,
    });
    toast('Saved.');
    reload();
  });
}

function noticeDialog(personId, d, reload, domain, prefill) {
  const pick = select(Object.fromEntries(d.options.domains.map((x) => [x.id, x.label])), domain ?? 'MOOD');
  const nowText = h('textarea', { placeholder: 'How they are now, and since when' });
  nowText.value = prefill ?? '';
  const usualLine = h('p', { class: 'small muted' });
  const sync = () => { const a = d.areas.find((x) => x.domain === pick.value); usualLine.textContent = a?.usual ? `Usually: ${a.usual.text}` : 'Nothing recorded as usual for this yet.'; };
  pick.addEventListener('change', sync);
  sync();
  dialog('Different from usual', h('div', { class: 'stack' }, h('label', { class: 'field' }, 'What is different', pick), usualLine, h('label', { class: 'field' }, 'Now', nowText)),
    'Save', async () => {
      await post(`/api/work/patients/${personId}/differences`, { domain: pick.value, nowText: nowText.value });
      toast('Saved. A nurse or doctor will see it.');
      reload();
    });
}

function closeDialog(x, d, reload) {
  const area = d.areas?.find((a) => a.domain === x.domain);
  const allowed = x.state === 'NOTICED' ? { BACK_TO_USUAL: d.options.outcomes.BACK_TO_USUAL } : d.options.outcomes;
  const outcome = select(allowed, 'BACK_TO_USUAL');
  const note = h('textarea', { placeholder: 'How it ended' });
  const statement = h('textarea', { placeholder: 'What is usual for them now' });
  const measure = d.options.domains.find((m) => m.id === x.domain)?.measure;
  const [low, high] = measure ? rangeInputs(measure) : [null, null];
  const newUsual = h('div', { class: 'stack', hidden: true },
    measure ? h('label', { class: 'field' }, `New usual range (${measure.unit})`, h('div', { class: 'row' }, low, h('span', {}, 'to'), high)) : null,
    h('label', { class: 'field' }, 'New usual', statement),
    area?.usual ? h('p', { class: 'small muted' }, `It replaces: ${area.usual.text}`) : null);
  outcome.addEventListener('change', () => { newUsual.hidden = outcome.value !== 'NEW_USUAL'; });
  dialog(`Close: ${x.label}`, h('div', { class: 'stack' }, h('label', { class: 'field' }, 'How it ended', outcome), h('label', { class: 'field' }, 'Note', note), newUsual), 'Close it', async () => {
    await post(`/api/work/differences/${x.id}/close`, { outcome: outcome.value, note: note.value, statement: statement.value, low: low?.value ?? '', high: high?.value ?? '' });
    reload();
  });
}

async function actOn(x, reload) {
  const done = await ask({ title: `${x.label}: what is being done`, label: 'Action', confirm: 'Save', multiline: true, minLength: 5 });
  if (!done) return;
  try {
    await post(`/api/work/differences/${x.id}/act`, { action: done });
    reload();
  } catch (err) { showError(err); }
}

export function differenceCard(x, d, reload, showPatient) {
  return h('div', { class: `tile stack difference difference-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/usual`) }, h('b', {}, x.patient)) : null,
        h('div', {}, h('b', {}, x.label)), showPatient && x.location ? h('div', { class: 'small muted' }, x.location) : null),
      h('span', { class: `tag ${TONE[x.state]}` }, x.stateLabel)),
    h('div', { class: 'usual-compare' },
      h('div', {}, h('span', { class: 'small muted' }, 'Usually '), x.usualText ?? 'Not recorded'),
      h('div', {}, h('span', { class: 'small muted' }, 'Now '), h('b', {}, x.nowText))),
    h('div', { class: 'small muted' }, `Noticed by ${x.noticedBy} ${fmtDateTime(x.noticedAt)}`),
    x.action ? h('div', { class: 'small' }, h('b', {}, `${x.actedBy}: `), x.action) : null,
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `${x.outcomeLabel}: `), x.outcomeNote, h('span', { class: 'muted' }, ` (${x.closedBy}, ${fmtDate(x.closedAt)})`)) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) =>
      h('button', { class: `btn small${a === 'act' ? ' primary' : ''}`, onclick: () => (a === 'act' ? actOn(x, reload) : closeDialog(x, d, reload)) },
        a === 'act' ? 'Record action' : 'Close'))) : null,
  );
}

async function markError(u, reload) {
  const reason = await ask({ title: 'Entered in error', label: 'What was wrong', confirm: 'Mark in error', multiline: true, minLength: 5 });
  if (!reason) return;
  try {
    await post(`/api/work/usual/${u.id}/error`, { reason });
    reload();
  } catch (err) { showError(err); }
}

// The person's Usual state view in the Live Workstation.
export function usualPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.outside.map((o) => h('div', { class: 'tile stack usual-outside' },
      h('div', { class: 'spread' }, h('b', {}, `${o.label} ${o.value}${o.unit === '%' ? '%' : ` ${o.unit}`}: ${o.direction} their usual`), h('span', { class: 'tag danger' }, 'Outside usual')),
      h('div', { class: 'small' }, `Usually ${o.usual}. Reading at ${fmtDateTime(o.at)}.`),
      d.canRecord ? h('div', {}, h('button', { class: 'btn small primary', onclick: () => noticeDialog(personId, d, reload, o.domain, `${o.label} ${o.value}${o.unit === '%' ? '%' : ` ${o.unit}`} at ${fmtDateTime(o.at)}`) }, 'Record the difference')) : null)),
    d.open.length ? h('section', { class: 'stack' }, h('h3', {}, `Different from usual (${d.open.length})`), d.open.map((x) => differenceCard(x, d, reload, false))) : null,
    d.canRecord ? h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => noticeDialog(personId, d, reload) }, 'Something is different')) : null,
    h('section', { class: 'stack' }, h('h3', {}, `What is usual for this ${subject}`),
      d.areas.map((a) => h('div', { class: `tile usual-area${a.different ? ' usual-different' : ''}` },
        h('div', { class: 'spread' }, h('b', {}, a.label),
          d.canRecord ? h('button', { class: 'link-btn small', onclick: () => usualDialog(personId, d, a, reload) }, a.usual ? 'Update' : 'Record') : null),
        a.usual ? h('div', {}, a.usual.text) : h('div', { class: 'muted small' }, 'Not recorded'),
        a.usual ? h('div', { class: 'small muted' }, [`${a.usual.recordedBy} ${fmtDate(a.usual.recordedAt)}`,
          a.usual.sourceLabel ? `from ${a.usual.sourceLabel.toLowerCase()}${a.usual.sourceName ? ` (${a.usual.sourceName})` : ''}` : null].filter(Boolean).join(' · '),
          a.usual.actions.includes('error') ? h('button', { class: 'link-btn small', onclick: () => markError(a.usual, reload) }, ' Entered in error') : null) : null,
        a.different ? h('div', { class: 'small notice' }, `Now: ${a.different.nowText}`) : null)),
      d.seesFunction ? h('div', { class: 'small muted' }, 'Usual walking, washing, dressing and other everyday activities are in ',
        h('button', { class: 'link-btn small', onclick: () => go(`/work/patient/${personId}/function`) }, 'Function'), '.') : null),
    d.closed.length ? h('details', {}, h('summary', {}, `Earlier differences (${d.closed.length})`), h('div', { class: 'stack' }, d.closed.map((x) => differenceCard(x, d, reload, false)))) : null,
    d.earlier.length ? h('details', {}, h('summary', {}, `Earlier usual (${d.earlier.length})`), h('div', { class: 'stack' }, d.earlier.map((u) =>
      h('div', { class: 'tile small stack' }, h('div', { class: 'spread' }, h('b', {}, u.label), h('span', { class: 'tag muted' }, u.stateLabel)),
        h('div', {}, u.text), u.errorReason ? h('div', {}, h('b', {}, 'Why: '), u.errorReason) : null,
        h('div', { class: 'muted' }, `${u.recordedBy} ${fmtDate(u.recordedAt)}`))))) : null,
  );
}

// Home → Different from usual.
export async function usualView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/usual');
    mount(root,
      workHeader(),
      pageTitle('Different from usual', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Changes no one has acted on yet, latest readings outside someone\'s usual range, then changes being acted on.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Needs action (${d.noticed.length})`),
        d.noticed.length ? d.noticed.map((x) => differenceCard(x, d, load, true)) : h('div', { class: 'card empty' }, 'Nothing waiting.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Readings outside their usual (${d.readings.length})`),
        d.readings.length ? d.readings.map((o) => h('div', { class: 'tile stack usual-outside' },
          h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${o.personId}/usual`) }, h('b', {}, o.patient))),
          h('div', {}, h('b', {}, `${o.label} ${o.value}${o.unit === '%' ? '%' : ` ${o.unit}`}`), ` (usually ${o.usual})`),
          h('div', { class: 'small muted' }, [o.location, `reading at ${fmtDateTime(o.at)}`].filter(Boolean).join(' · ')))) : h('div', { class: 'card empty' }, 'None.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Being acted on (${d.acting.length})`),
        d.acting.length ? d.acting.map((x) => differenceCard(x, d, load, true)) : h('div', { class: 'card empty' }, 'None.')),
    );
  };
  await load();
  return root;
}
