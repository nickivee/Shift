import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Monitoring plan: what to check, how, how often, the clinician's limits and target, who does
// it. Entries are made with the usual .key; the plan shows whether they are happening, and a
// review continues, changes or stops it. SHIFT applies no thresholds of its own.
const STATUS = { OVERDUE: ['Overdue', 'danger'], DUE_SOON: ['Due soon', 'warn'], ON_TRACK: ['On track', 'ok'] };
const EVERY = { 1: 'Every hour', 2: 'Every 2 hours', 4: 'Every 4 hours', 6: 'Every 6 hours', 8: 'Every 8 hours', 12: 'Twice a day', 24: 'Once a day', 48: 'Every 2 days', 168: 'Once a week' };
const every = (n) => EVERY[n] ?? `Every ${n} hours`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

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
  const entries = Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options);
  const s = h('select', {}, entries.map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined && value !== null) s.value = String(value);
  return s;
};

// The fields that define a plan, shared by starting one and changing one.
function planFields(options, m = {}) {
  const f = {
    parameter: select(options.parameters, m.parameter),
    reason: h('input', { type: 'text', value: m.reason ?? '', placeholder: 'Why this monitoring is needed' }),
    frequency: select(EVERY, m.frequency ?? 4),
    method: h('input', { type: 'text', value: m.method ?? '', placeholder: 'Optional: how to do it' }),
    limits: h('textarea', { placeholder: 'When to act, and who to tell' }),
    target: h('input', { type: 'text', value: m.target ?? '', placeholder: 'Optional' }),
    responsible: select(options.responsible, m.responsible),
    reviewDate: h('input', { type: 'date', value: m.reviewDate ?? inDays(1) }),
  };
  f.limits.value = m.limits ?? '';
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  const body = (withParameter) => h('div', { class: 'stack' },
    withParameter ? h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Monitor', f.parameter), h('label', { class: 'field grow' }, 'How often', f.frequency)) : h('label', { class: 'field' }, 'How often', f.frequency),
    withParameter ? h('label', { class: 'field' }, 'Why', f.reason) : null,
    h('label', { class: 'field' }, 'Method', f.method),
    h('label', { class: 'field' }, 'Limits (your words)', f.limits),
    h('label', { class: 'field' }, 'Target', f.target),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Who', f.responsible), h('label', { class: 'field grow' }, 'Review by', f.reviewDate)),
  );
  return { values, body };
}

function reviewDialog(m, options, reload) {
  const outcome = select(options.outcomes, 'CONTINUE');
  const finding = h('textarea', { placeholder: 'What the monitoring shows' });
  const action = h('input', { type: 'text', placeholder: 'Optional: what is being done' });
  const next = h('input', { type: 'date', value: inDays(1) });
  const change = planFields(options, { ...m, reviewDate: undefined });
  const continueBox = h('label', { class: 'field' }, 'Next review', next);
  const changeBox = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'The current plan is kept in the history and the new one replaces it.'), change.body(false));
  const sync = () => { continueBox.hidden = outcome.value !== 'CONTINUE'; changeBox.hidden = outcome.value !== 'CHANGED'; };
  outcome.addEventListener('change', sync);
  dialog(`Review ${m.parameterLabel.toLowerCase()} monitoring`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Finding', finding),
    h('label', { class: 'field' }, 'Action', action),
    h('label', { class: 'field' }, 'Decision', outcome),
    continueBox, changeBox,
  ), 'Save review', async () => {
    const body = { outcome: outcome.value, finding: finding.value, action: action.value, reviewDate: next.value };
    await post(`/api/work/monitoring/${m.id}/review`, outcome.value === 'CHANGED' ? { ...change.values(), ...body, reviewDate: change.values().reviewDate } : body);
    toast({ CONTINUE: 'Review saved.', CHANGED: 'Plan changed.', STOPPED: 'Monitoring stopped.' }[outcome.value]);
    reload();
  });
  sync();
}

export function monitoringCard(m, options, reload, { showPatient = true } = {}) {
  const [label, tone] = STATUS[m.status] ?? ['Stopped', 'muted'];
  return h('div', { class: `tile stack${m.status === 'OVERDUE' ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${m.personId}/monitoring`) }, h('b', {}, m.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, `${m.parameterLabel}: ${every(m.frequency).toLowerCase()}`), showPatient && m.location ? ` · ${m.location}` : ''),
      ),
      h('div', { class: 'row' }, m.reviewDue ? h('span', { class: 'tag warn' }, 'Review due') : null, h('span', { class: `tag ${tone}` }, label)),
    ),
    m.nextDue ? h('div', {}, h('b', {}, m.status === 'OVERDUE' ? 'Was due: ' : 'Next due: '), fmtDateTime(m.nextDue), ` · ${m.responsible}`) : null,
    h('div', { class: 'small' }, m.reason, m.method ? ` · ${m.method}` : ''),
    m.limits ? h('div', { class: 'summary' }, h('b', {}, 'Limits: '), m.limits) : null,
    m.target ? h('div', { class: 'small' }, h('b', {}, 'Target: '), m.target) : null,
    m.recent.length ? h('details', {}, h('summary', {}, `Latest: ${fmtDateTime(m.recent[0].at)}`),
      h('ul', { class: 'small stack' }, m.recent.map((e) => h('li', {}, h('b', {}, `${fmtDateTime(e.at)}${e.author ? `, ${e.author}` : ''}: `), e.text))))
      : h('div', { class: 'small muted' }, 'Nothing recorded yet.'),
    m.reviews.length ? h('div', { class: 'small' }, h('b', {}, `Last review (${m.reviews[0].by}, ${fmtDateTime(m.reviews[0].at)}): `), `${m.reviews[0].outcomeLabel}. ${m.reviews[0].finding}${m.reviews[0].action ? ` Action: ${m.reviews[0].action}` : ''}`) : null,
    m.closeReason && m.status === null ? h('div', { class: 'small' }, h('b', {}, `Stopped (${m.closedBy}): `), m.closeReason) : null,
    h('div', { class: 'small muted' }, [`Set by ${m.startedBy} ${fmtDateTime(m.startedAt)}`, m.reviewDate && m.status ? `review by ${fmtDate(m.reviewDate)}` : null].filter(Boolean).join(' · ')),
    m.canRecord || m.canPlan ? h('div', { class: 'row' },
      m.canRecord ? h('button', { class: 'btn small primary', onclick: () => go(`/work/patient/${m.personId}/${m.view}`) }, `Record ${m.parameterLabel.toLowerCase()}`) : null,
      m.canPlan ? h('button', { class: 'btn small', onclick: () => reviewDialog(m, options, reload) }, 'Review') : null,
    ) : null,
  );
}

// The patient's Monitoring view inside the Live Workstation.
export function monitoringPanel(personId, d, reload) {
  const form = () => {
    const f = planFields(d.options);
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/monitoring`, f.values());
        toast('Monitoring plan started.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Start monitoring'),
      f.body(true),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Start')),
    );
  };
  return h('div', { class: 'stack' },
    d.plans.length ? d.plans.map((m) => monitoringCard(m, d.options, reload, { showPatient: false })) : h('div', { class: 'empty' }, 'No monitoring planned for this patient.'),
    d.canPlan ? form() : null,
    d.past.length ? h('details', {}, h('summary', {}, `Stopped (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((m) => monitoringCard(m, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Monitoring due.
export async function monitoringView() {
  const root = h('div');
  const load = async () => {
    const { plans, options } = await get('/api/work/monitoring');
    const by = (s) => plans.filter((m) => m.status === s);
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((m) => monitoringCard(m, options, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Monitoring due', () => go('/work/home')),
      h('div', { class: 'banner' }, 'What each patient is being monitored for, and when it is next due. Limits are the clinician\'s own words; SHIFT does not set thresholds.'),
      section('Overdue', by('OVERDUE'), 'Nothing overdue.'),
      section('Due in the next hour', by('DUE_SOON'), 'Nothing due in the next hour.'),
      by('ON_TRACK').length ? section('On track', by('ON_TRACK'), '') : null,
    );
  };
  await load();
  return root;
}
