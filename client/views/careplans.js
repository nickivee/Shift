import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Care plan: need → goal → care → who → review date → review (continue, change, achieved,
// ceased). A change supersedes the old item; reviews carry forward so the trail is unbroken.
const OUTCOME = { CONTINUE: 'Continue', MODIFIED: 'Changed', ACHIEVED: 'Achieved', CEASED: 'Ceased' };
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

function itemFields(responsible, item = {}) {
  const need = h('input', { type: 'text', 'aria-label': 'Need', value: item.need ?? '' });
  const goal = h('textarea', { 'aria-label': 'Goal' }); goal.value = item.goal ?? '';
  const intervention = h('textarea', { 'aria-label': 'Care' }); intervention.value = item.intervention ?? '';
  const who = h('select', { 'aria-label': 'Who' }, responsible.map((r) => h('option', { value: r }, r))); if (item.responsible) who.value = item.responsible;
  const review = h('input', { type: 'date', 'aria-label': 'Review by', value: inDays(14) });
  return {
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Need', need),
      h('label', { class: 'field' }, 'Goal', goal),
      h('label', { class: 'field' }, 'Care', intervention),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Who', who), h('label', { class: 'field grow' }, 'Review by', review)),
    ),
    values: () => ({ need: need.value, goal: goal.value, intervention: intervention.value, responsible: who.value, reviewDate: review.value }),
    need,
  };
}

function reviewDialog(item, responsible, reload) {
  const evaluation = h('textarea', { 'aria-label': 'Evaluation', placeholder: 'How the person is going against the goal' });
  const outcome = h('select', { 'aria-label': 'Outcome' },
    h('option', { value: 'CONTINUE' }, 'Continue as planned'), h('option', { value: 'MODIFIED' }, 'Change the plan'),
    h('option', { value: 'ACHIEVED' }, 'Goal achieved'), h('option', { value: 'CEASED' }, 'No longer needed'));
  const next = h('input', { type: 'date', 'aria-label': 'Next review', value: inDays(14) });
  const change = itemFields(responsible, item);
  change.need.readOnly = true;
  const nextRow = h('label', { class: 'field' }, 'Next review', next);
  const changeBox = h('div', { class: 'tile', hidden: true }, change.body);
  outcome.onchange = () => { nextRow.hidden = outcome.value !== 'CONTINUE'; changeBox.hidden = outcome.value !== 'MODIFIED'; };
  dialog(`Review: ${item.need}`, h('div', { class: 'stack' },
    h('div', { class: 'summary' }, h('b', {}, 'Goal: '), item.goal, h('br'), h('b', {}, 'Care: '), item.intervention),
    h('label', { class: 'field' }, 'Evaluation', evaluation),
    h('label', { class: 'field' }, 'Outcome', outcome),
    nextRow, changeBox,
  ), 'Record review', async () => {
    const body = { evaluation: evaluation.value, outcome: outcome.value, reviewDate: next.value };
    if (outcome.value === 'MODIFIED') Object.assign(body, change.values());
    await post(`/api/work/careplan/${item.id}/review`, body);
    toast({ CONTINUE: 'Review recorded.', MODIFIED: 'Plan changed. The earlier version is kept.', ACHIEVED: 'Goal achieved.', CEASED: 'Item ended.' }[outcome.value]);
    reload();
  });
}

export function carePlanItem(item, responsible, reload, { showPatient = false } = {}) {
  const last = item.reviews[0];
  return h('div', { class: `tile stack${item.overdue ? ' esc esc-urgent' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${item.personId}/careplan`) }, h('b', {}, item.patient)) : null,
        h('h3', {}, item.need),
      ),
      h('div', { class: 'row' },
        item.state !== 'ACTIVE' ? h('span', { class: `tag ${item.state === 'ACHIEVED' ? 'ok' : 'muted'}` }, OUTCOME[item.state] ?? item.state)
          : item.overdue ? h('span', { class: 'tag danger' }, `Review overdue since ${fmtDate(item.reviewDate)}`)
          : item.due ? h('span', { class: 'tag warn' }, 'Review due today')
          : h('span', { class: 'tag' }, `Review ${fmtDate(item.reviewDate)}`),
      ),
    ),
    h('div', {}, h('b', {}, 'Goal: '), item.goal ?? ''),
    h('div', {}, h('b', {}, 'Care: '), item.intervention),
    h('div', { class: 'small muted' }, [item.responsible, item.author ? `written by ${item.author}` : null, item.supersedesId ? 'changed from an earlier version' : null].filter(Boolean).join(' · ')),
    item.closeReason ? h('div', { class: 'small' }, h('b', {}, `${item.closedBy}, ${fmtDate(item.closedAt)}: `), item.closeReason) : null,
    last ? h('details', {}, h('summary', {}, `Reviews (${item.reviews.length}) · last ${fmtDate(last.at)} by ${last.by}`),
      h('ul', { class: 'reqs' }, item.reviews.map((r) => h('li', { class: 'req met' },
        h('div', { class: 'spread' }, h('b', {}, OUTCOME[r.outcome]), h('span', { class: 'small muted' }, `${r.by} · ${fmtDateTime(r.at)}`)),
        h('div', { class: 'small' }, r.evaluation),
      )))) : null,
    item.canManage ? h('div', { class: 'row' }, h('button', { class: `btn small${item.due ? ' primary' : ''}`, onclick: () => reviewDialog(item, responsible, reload) }, 'Review')) : null,
  );
}

// The person's Care Plan view inside the Live Workstation.
export function carePlanPanel(personId, d, reload) {
  const add = () => {
    const f = itemFields(d.responsible);
    dialog('Add to the care plan', f.body, 'Add', async () => {
      await post(`/api/work/patients/${personId}/careplan`, f.values());
      toast('Added to the care plan.');
      reload();
    });
  };
  return h('div', { class: 'stack' },
    d.canManage ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: add }, 'Add a need')) : null,
    d.items.length ? d.items.map((i) => carePlanItem(i, d.responsible, reload)) : h('div', { class: 'empty' }, 'No active care plan items.'),
    d.past.length ? h('details', {}, h('summary', {}, `Achieved and ended (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((i) => carePlanItem(i, d.responsible, reload)))) : null,
  );
}

// Home → Care plan reviews.
export async function carePlanReviewsView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/careplan-reviews');
    const responsible = rows.length ? (await get(`/api/work/patients/${rows[0].personId}/views/careplan`)).responsible : [];
    mount(root,
      workHeader(),
      pageTitle('Care plan reviews', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Care plan items due or overdue for review. Each review records how the person is going, then continues, changes or ends the item. Changes keep the earlier version.'),
      rows.length ? h('div', { class: 'stack' }, rows.map((i) => carePlanItem(i, responsible, load, { showPatient: true })))
        : h('div', { class: 'card empty' }, 'No care plan reviews due.'),
    );
  };
  await load();
  return root;
}
