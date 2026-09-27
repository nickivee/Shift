import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Functional status: how they usually manage → how they are now → the help they need → what is
// being done → looked at again → what has changed.
const CHANGE = { WORSE: ['Worse than usual', 'danger'], BETTER: ['Better than usual', 'ok'], SAME: ['As usual', 'muted'] };

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', { class: 'wide' },
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

const levelText = (e) => e ? `${e.label}${e.aid ? `, ${e.aid.toLowerCase()}` : ''}` : 'Not known';

// One form for both: usual function (a baseline, from someone who knows) and function now (every activity, with a reassessment date).
function assessDialog(personId, d, kind, reload) {
  const o = d.options;
  const from = kind === 'CURRENT' ? d.current : d.baseline;
  const prior = Object.fromEntries((from?.entries ?? []).map((e) => [e.activity, e]));
  const levels = { '': kind === 'BASELINE' ? 'Not known' : 'Choose…', ...Object.fromEntries(o.levels.map((l) => [l.id, l.label])) };
  const fields = o.activities.map((a) => {
    const listId = `aids-${a.id}`;
    const level = select(levels, prior[a.id]?.level ?? '');
    const aid = h('input', { type: 'text', list: listId, placeholder: 'Aid, if any', value: prior[a.id]?.aid ?? '' });
    const note = h('input', { type: 'text', placeholder: 'Note', value: prior[a.id]?.note ?? '' });
    return { a, level, aid, note, el: h('fieldset', { class: 'item function-item' },
      h('legend', {}, a.label),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Help needed', level), h('label', { class: 'field grow' }, 'Aid', aid)),
      h('datalist', { id: listId }, a.aids.map((x) => h('option', { value: x }))),
      note) };
  });
  const source = select({ '': 'Choose…', ...o.sources }, d.baseline?.source ?? '');
  const sourceName = h('input', { type: 'text', placeholder: 'Who, or which record and its date', value: d.baseline?.sourceName ?? '' });
  const review = h('input', { type: 'number', min: 1, max: 90, step: 1, value: '7' });
  const summary = h('textarea', { placeholder: kind === 'CURRENT' ? 'Anything else, e.g. tires after 20 m; needs reminding to use frame' : 'Anything else about how they usually manage at home' });
  dialog(kind === 'CURRENT' ? 'Function now' : 'Usual function', h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, kind === 'CURRENT'
      ? 'The help they need now for each activity. It shows at the top of their record for everyone caring for them.'
      : 'How they usually manage when well, before this illness or admission. Leave an activity as "Not known" if no one knows.'),
    kind === 'BASELINE' ? h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Where this comes from', source), h('label', { class: 'field grow' }, 'Who or which record', sourceName)) : null,
    ...fields.map((f) => f.el),
    kind === 'CURRENT' ? h('label', { class: 'field' }, 'Reassess in days', review) : null,
    h('label', { class: 'field' }, 'Summary', summary),
  ), 'Save', async () => {
    const entries = {};
    for (const f of fields) if (f.level.value) entries[f.a.id] = { level: f.level.value, aid: f.aid.value, note: f.note.value };
    await post(`/api/work/patients/${personId}/function`, {
      kind, entries, summary: summary.value, source: source.value, sourceName: sourceName.value, reviewDays: Number(review.value),
    });
    toast(kind === 'CURRENT' ? 'Saved. The help they need is at the top of their record.' : 'Usual function saved.');
    reload();
  });
}

function planDialog(personId, d, reload, activity) {
  const what = h('textarea', { placeholder: 'What will be done, e.g. physio to walk with frame twice a day' });
  const act = select(Object.fromEntries(d.options.activities.map((a) => [a.id, a.label])), activity ?? d.options.activities[0].id);
  dialog('Plan something to help', h('div', { class: 'stack' }, h('label', { class: 'field' }, 'For', act), h('label', { class: 'field' }, 'What', what)), 'Add', async () => {
    await post(`/api/work/patients/${personId}/function-plans`, { activity: act.value, what: what.value });
    reload();
  });
}

async function planAction(p, action, reload) {
  let outcome = '';
  if (action === 'stop') {
    outcome = await ask({ title: `Stop: ${p.what}`, label: 'How it went', confirm: 'Stop it', multiline: true, minLength: 5 });
    if (!outcome) return;
  }
  try {
    await post(`/api/work/function-plans/${p.id}/${action}`, { outcome });
    reload();
  } catch (err) { showError(err); }
}

function planCard(p, reload) {
  return h('div', { class: `tile stack function-plan${p.state === 'STOPPED' ? '' : ' open'}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, p.activityLabel), h('div', {}, p.what)),
      h('span', { class: `tag ${p.state === 'IN_PLACE' ? 'ok' : p.state === 'PLANNED' ? 'warn' : 'muted'}` }, p.stateLabel)),
    h('div', { class: 'small muted' }, [`Planned by ${p.plannedBy} ${fmtDate(p.plannedAt)}`, p.startedBy ? `in place ${fmtDate(p.startedAt)}` : null,
      p.stoppedBy ? `stopped by ${p.stoppedBy} ${fmtDate(p.stoppedAt)}` : null].filter(Boolean).join(' · ')),
    p.outcome ? h('div', { class: 'small' }, h('b', {}, 'How it went: '), p.outcome) : null,
    p.actions.length ? h('div', { class: 'row' }, p.actions.map((a) =>
      h('button', { class: `btn small${a === 'start' ? ' primary' : ''}`, onclick: () => planAction(p, a, reload) }, a === 'start' ? 'Put in place' : 'Stop'))) : null,
  );
}

async function markError(a, reload) {
  const reason = await ask({ title: 'Entered in error', label: 'What was wrong', confirm: 'Mark in error', multiline: true, minLength: 5 });
  if (!reason) return;
  try {
    await post(`/api/work/function/${a.id}/error`, { reason });
    reload();
  } catch (err) { showError(err); }
}

function assessmentLine(a, reload) {
  if (!a) return null;
  return h('div', { class: 'small muted stack' },
    h('div', {}, [`${a.kindLabel}: ${a.assessedBy} ${fmtDateTime(a.assessedAt)}`,
      a.sourceLabel ? `from ${a.sourceLabel.toLowerCase()}${a.sourceName ? ` (${a.sourceName})` : ''}` : null,
      a.reviewDue ? `reassess by ${fmtDate(a.reviewDue)}` : null].filter(Boolean).join(' · '),
      a.overdue ? h('span', { class: 'tag danger' }, ' Reassessment overdue') : null),
    a.summary ? h('div', { class: 'ink' }, a.summary) : null,
    a.actions.includes('error') ? h('div', {}, h('button', { class: 'link-btn small', onclick: () => markError(a, reload) }, `Mark ${a.kindLabel.toLowerCase()} as entered in error`)) : null,
  );
}

// The person's Function view in the Live Workstation.
export function functionPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.unplanned.length ? h('div', { class: 'notice' }, `Worse than usual with nothing planned: ${d.unplanned.join(', ').toLowerCase()}.`) : null,
    !d.current && !d.baseline ? h('div', { class: 'empty' }, `No function recorded for this ${subject}.`) : h('div', { class: 'stack function-table' },
      d.rows.map((r) => h('div', { class: `tile function-row${r.change === 'WORSE' ? ' function-worse' : ''}` },
        h('div', { class: 'spread' }, h('b', {}, r.label), r.change ? h('span', { class: `tag ${CHANGE[r.change][1]}` }, CHANGE[r.change][0]) : null),
        h('div', { class: 'function-levels' },
          h('div', {}, h('span', { class: 'small muted' }, 'Usually '), levelText(r.usual)),
          h('div', {}, h('span', { class: 'small muted' }, 'Now '), h('b', {}, d.current ? levelText(r.now) : 'Not assessed'))),
        r.now?.note ? h('div', { class: 'small' }, r.now.note) : null,
        r.plans.map((p) => h('div', { class: 'small' }, h('b', {}, `${p.stateLabel}: `), p.what)),
        d.canAssess && r.change === 'WORSE' && !r.plans.length ? h('div', {}, h('button', { class: 'btn small', onclick: () => planDialog(personId, d, reload, r.activity) }, 'Plan something')) : null,
      ))),
    assessmentLine(d.current, reload),
    assessmentLine(d.baseline, reload),
    d.canAssess ? h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => assessDialog(personId, d, 'CURRENT', reload) }, d.current ? 'Reassess function now' : 'Record function now'),
      h('button', { class: 'btn', onclick: () => assessDialog(personId, d, 'BASELINE', reload) }, d.baseline ? 'Update usual function' : 'Record usual function'),
      h('button', { class: 'btn', onclick: () => planDialog(personId, d, reload) }, 'Plan something')) : null,
    d.plans.open.length ? h('section', { class: 'stack' }, h('h3', {}, `Being done (${d.plans.open.length})`), d.plans.open.map((p) => planCard(p, reload))) : null,
    d.plans.stopped.length ? h('details', {}, h('summary', {}, `Stopped (${d.plans.stopped.length})`), h('div', { class: 'stack' }, d.plans.stopped.map((p) => planCard(p, reload)))) : null,
    d.earlier.length ? h('details', {}, h('summary', {}, `Earlier assessments (${d.earlier.length})`), h('div', { class: 'stack' }, d.earlier.map((a) =>
      h('div', { class: 'tile stack small' },
        h('div', { class: 'spread' }, h('b', {}, `${a.kindLabel}, ${fmtDateTime(a.assessedAt)} by ${a.assessedBy}`), h('span', { class: 'tag muted' }, a.stateLabel)),
        a.errorReason ? h('div', {}, h('b', {}, 'Why: '), a.errorReason) : null,
        h('ul', {}, a.entries.map((e) => h('li', {}, `${e.activityLabel}: ${e.levelLabel}${e.aid ? `, ${e.aid}` : ''}`))))))) : null,
  );
}

function personCard(a, extra) {
  return h('div', { class: `tile stack${extra ? ' function-worse' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${a.personId}/function`) }, h('b', {}, a.patient)),
        h('div', { class: 'small muted' }, a.location ?? '')),
      a.overdue ? h('span', { class: 'tag danger' }, 'Overdue') : h('span', { class: 'tag warn' }, `Due ${fmtDateTime(a.reviewDue)}`)),
    extra ? h('div', { class: 'small notice' }, `Worse than usual, nothing planned: ${extra.join(', ').toLowerCase()}`) : null,
    h('div', { class: 'small' }, a.entries.filter((e) => !['INDEPENDENT', 'NOT_DOING'].includes(e.level)).map((e) => `${e.activityLabel}: ${e.levelLabel.toLowerCase()}`).join(' · ') || 'Independent in everything'),
    h('div', { class: 'small muted' }, `Last assessed by ${a.assessedBy} ${fmtDateTime(a.assessedAt)}`),
  );
}

// Home → Function.
export async function functionView() {
  const root = h('div');
  const d = await get('/api/work/function');
  mount(root,
    workHeader(),
    pageTitle('Function', () => go('/work/home')),
    h('div', { class: 'banner' }, 'People worse than usual with nothing planned, then reassessments due in the next day.'),
    h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Worse than usual, nothing planned (${d.worse.length})`),
      d.worse.length ? d.worse.map((a) => personCard(a, a.unplanned)) : h('div', { class: 'card empty' }, 'No one.')),
    h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Reassessment due (${d.due.length})`),
      d.due.length ? d.due.map((a) => personCard(a, null)) : h('div', { class: 'card empty' }, 'Nothing due.')),
  );
  return root;
}
