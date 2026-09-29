import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Wounds: identified → assessed → treatment plan → serial reassessment → healed or closed.
// Area is shown for reference; whether a wound is improving is the assessor's judgement.
const LABEL = { IDENTIFIED: 'Not yet assessed', ASSESSED: 'Assessed, no plan', PLANNED: 'Plan in place', HEALED: 'Healed', CLOSED: 'Closed' };
const TONE = { IDENTIFIED: 'danger', ASSESSED: 'warn', PLANNED: '', HEALED: 'ok', CLOSED: 'muted' };
const TREND = { FIRST: ['First assessment', ''], IMPROVING: ['Improving', 'ok'], STATIC: ['Static', 'warn'], DETERIORATING: ['Deteriorating', 'danger'] };
const area = (a) => (a.lengthMm && a.widthMm ? `${((a.lengthMm * a.widthMm) / 100).toFixed(1)} cm²` : '—');
const size = (a) => `${a.lengthMm} × ${a.widthMm}${a.depthMm !== null ? ` × ${a.depthMm}` : ''} mm`;

const select = (label, list, blank = true) => {
  const el = h('select', { 'aria-label': label }, blank ? h('option', { value: '' }, 'Choose') : null, list.map((o) => h('option', { value: o }, titleCase(o).replace(/^./, (c) => c.toUpperCase()))));
  return [h('label', { class: 'field grow' }, label, el), el];
};
const number = (label, max) => {
  const el = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: String(max), 'aria-label': label });
  return [h('label', { class: 'field grow' }, label, el), el];
};

function assessDialog(w, options, reload) {
  const first = w.state === 'IDENTIFIED';
  const [lL, l] = number('Length (mm)', 2000);
  const [wL, wd] = number('Width (mm)', 2000);
  const [dL, d] = number('Depth (mm)', 2000);
  const [sL, stage] = select('Stage', options.stage);
  const [bL, bed] = select('Wound bed', options.bed);
  const [eL, exudate] = select('Exudate', options.exudate);
  const [suL, surrounding] = select('Surrounding skin', options.surrounding);
  const [cL, complication] = select('Complication', options.complication, false);
  const [pL, pain] = number('Pain (0–10)', 10);
  const [tL, trend] = select('Since last time', options.trend);
  const dressing = h('input', { type: 'text', 'aria-label': 'Dressing', value: w.latest?.dressing ?? '' });
  const note = h('textarea', { 'aria-label': 'Note' });
  dialog(first ? `Assess ${w.site.toLowerCase()} wound` : `Reassess ${w.site.toLowerCase()} wound`, h('div', { class: 'stack' },
    h('div', { class: 'row' }, lL, wL, dL),
    h('div', { class: 'row' }, sL, bL),
    h('div', { class: 'row' }, eL, suL),
    h('div', { class: 'row' }, cL, pL),
    first ? null : h('div', { class: 'row' }, tL),
    h('label', { class: 'field' }, 'Dressing applied', dressing),
    h('label', { class: 'field' }, 'Note', note),
  ), 'Record assessment', async () => {
    const r = await post(`/api/work/wounds/${w.id}/assess`, {
      lengthMm: l.value, widthMm: wd.value, depthMm: d.value, stage: stage.value, bed: bed.value, exudate: exudate.value, surrounding: surrounding.value,
      complication: complication.value, pain: pain.value, trend: trend.value, dressing: dressing.value, note: note.value,
    });
    toast(r.latest?.trend === 'DETERIORATING' || (r.latest?.complication && r.latest.complication !== 'None')
      ? 'Assessment recorded and marked urgent. Consider escalating.' : 'Assessment recorded.');
    reload();
  });
}

function planDialog(w, reload) {
  const plan = h('textarea', { 'aria-label': 'Plan', placeholder: 'Cleansing, dressing, offloading, and anything else to do' });
  plan.value = w.plan ?? '';
  const days = h('input', { type: 'number', min: '1', max: '28', 'aria-label': 'Reassess every (days)', value: String(w.reviewDays ?? 2) });
  dialog(w.plan ? 'Change the treatment plan' : 'Set the treatment plan', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Treatment plan', plan),
    h('label', { class: 'field' }, 'Reassess every (days)', days),
  ), 'Save plan', async () => {
    await post(`/api/work/wounds/${w.id}/plan`, { plan: plan.value, reviewDays: days.value });
    toast('Plan saved. The next review date is set from today.');
    reload();
  });
}

async function finish(w, action, reload) {
  const note = await ask(action === 'heal'
    ? { title: 'Mark as healed', message: 'Describe the healed wound. Any further change needs a new wound.', label: 'Description', multiline: true, minLength: 3, confirm: 'Mark healed' }
    : { title: 'Close without healing', message: 'For example, the person has left the service.', label: 'Reason', multiline: true, minLength: 5, confirm: 'Close' });
  if (!note) return;
  try { await post(`/api/work/wounds/${w.id}/${action}`, { note }); toast(action === 'heal' ? 'Marked healed.' : 'Closed.'); reload(); } catch (err) { showError(err); }
}

export function woundCard(w, options, reload, { showPatient = false } = {}) {
  const worse = w.latest && (w.latest.trend === 'DETERIORATING' || (w.latest.complication && w.latest.complication !== 'None'));
  return h('div', { class: `tile stack${worse ? ' esc esc-immediate' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${w.personId}/wounds`) }, h('b', {}, w.patient)) : null,
        h('div', {}, h('b', {}, `${w.kind}, ${w.site}`), w.location && showPatient ? h('span', { class: 'muted' }, ` · ${w.location}`) : null),
      ),
      h('div', { class: 'row' },
        w.latest && w.latest.trend !== 'FIRST' ? h('span', { class: `tag ${TREND[w.latest.trend][1]}` }, TREND[w.latest.trend][0]) : null,
        w.due ? h('span', { class: 'tag warn' }, 'Review due') : null,
        h('span', { class: `tag ${TONE[w.state]}` }, LABEL[w.state]),
      ),
    ),
    w.description ? h('div', { class: 'small' }, w.description) : null,
    worse ? h('div', { class: 'notice' }, `Last assessment: ${[w.latest.trend === 'DETERIORATING' ? 'deteriorating' : null, w.latest.complication !== 'None' ? w.latest.complication.toLowerCase() : null].filter(Boolean).join(', ')}.`,
      ' ', h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${w.personId}/escalations`) }, 'Escalate')) : null,
    w.plan ? h('div', { class: 'summary' }, h('b', {}, 'Plan: '), w.plan, h('div', { class: 'small muted' }, `${w.planBy} · reassess every ${w.reviewDays} day${w.reviewDays === 1 ? '' : 's'}${w.nextReview ? ` · next ${fmtDate(w.nextReview)}` : ''}`)) : null,
    w.assessments.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['When', 'Size', 'Area', 'Bed', 'Exudate', 'Trend', 'By'].map((c) => h('th', {}, c)))),
      h('tbody', {}, w.assessments.map((a) => h('tr', {},
        h('td', {}, fmtDateTime(a.at)), h('td', {}, size(a)), h('td', {}, area(a)), h('td', {}, a.bed ?? ''), h('td', {}, a.exudate ?? ''),
        h('td', {}, a.trend ? TREND[a.trend][0] : ''), h('td', {}, a.by),
      ))),
    )) : h('div', { class: 'small muted' }, `Reported by ${w.identifiedBy}, ${fmtDateTime(w.identifiedAt)}. Not yet assessed by an RN.`),
    w.closeReason ? h('div', { class: 'small' }, h('b', {}, `${LABEL[w.state]} (${w.closedBy}, ${fmtDate(w.closedAt)}): `), w.closeReason) : null,
    w.actions.length ? h('div', { class: 'row' },
      w.actions.includes('assess') ? h('button', { class: 'btn small primary', onclick: () => assessDialog(w, options, reload) }, w.state === 'IDENTIFIED' ? 'Assess' : 'Reassess') : null,
      w.actions.includes('plan') ? h('button', { class: `btn small${w.state === 'ASSESSED' ? ' primary' : ''}`, onclick: () => planDialog(w, reload) }, w.plan ? 'Change plan' : 'Set plan') : null,
      w.actions.includes('heal') ? h('button', { class: 'btn small', onclick: () => finish(w, 'heal', reload) }, 'Mark healed') : null,
      w.actions.includes('close') ? h('button', { class: 'btn small', onclick: () => finish(w, 'close', reload) }, 'Close') : null,
    ) : null,
  );
}

// The person's Wounds view inside the Live Workstation.
export function woundsPanel(personId, d, reload) {
  const form = () => {
    const site = h('input', { type: 'text', placeholder: 'For example, left heel' });
    const kind = h('select', {}, d.kinds.map((k) => h('option', { value: k }, k)));
    const description = h('textarea', { placeholder: 'What you can see' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/wounds`, { site: site.value, kind: kind.value, description: description.value });
        toast('Wound reported. An RN assesses it next.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Report a new wound'),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Where', site), h('label', { class: 'field grow' }, 'Type', kind)),
      h('label', { class: 'field' }, 'What you can see', description),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Report wound')),
    );
  };
  const open = d.wounds.filter((w) => !['HEALED', 'CLOSED'].includes(w.state));
  const closed = d.wounds.filter((w) => ['HEALED', 'CLOSED'].includes(w.state));
  return h('div', { class: 'stack' },
    open.length ? open.map((w) => woundCard(w, d.options, reload)) : h('div', { class: 'empty' }, 'No open wounds.'),
    d.canIdentify ? form() : null,
    closed.length ? h('details', {}, h('summary', {}, `Healed and closed (${closed.length})`), h('div', { class: 'stack' }, closed.map((w) => woundCard(w, d.options, reload)))) : null,
  );
}

// Home → Wound reviews: wounds not yet assessed, then reviews due.
export async function woundReviewsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/wounds');
    const options = rows.length ? (await get(`/api/work/patients/${rows[0].personId}/views/wounds`)).options : null;
    const unassessed = rows.filter((w) => w.state === 'IDENTIFIED');
    const due = rows.filter((w) => w.state !== 'IDENTIFIED' && w.due);
    const rest = rows.filter((w) => w.state !== 'IDENTIFIED' && !w.due);
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((w) => woundCard(w, options, load, { showPatient: true })) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Wound reviews', () => go('/work/home')),
      section('Reported, not yet assessed', unassessed, 'Every reported wound has been assessed.'),
      section('Review due', due, 'No wound reviews due today.'),
      rest.length ? section('Other open wounds', rest, '') : null,
    );
  };
  await load();
  return root;
}
