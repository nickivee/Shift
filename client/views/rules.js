import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Home → Rules and settings. Each rule SHIFT applies is a value with its source, start date and version.
// One person proposes a change; a different person approves it; it starts on its date and the earlier
// value stays in the history. Another country, state or health system keeps its own values.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const show = (r, v) => {
  if (v === undefined || v === null) return 'Not set';
  switch (r.kind) {
    case 'int': return `${v} ${r.unit ?? ''}`.trim();
    case 'professions': return v.join(', ');
    case 'dates': return v.map((d) => `${d.day} ${MONTHS[d.month - 1]}`).join(', ');
    case 'reasons': return v.map((x) => x.label).join('; ');
    default: return String(v);
  }
};
const asText = (r, v) => {
  if (v === undefined || v === null) return '';
  switch (r.kind) {
    case 'professions': return v.join('\n');
    case 'dates': return v.map((d) => `${d.month}-${d.day}`).join('\n');
    case 'reasons': return v.map((x) => x.label).join('\n');
    default: return String(v);
  }
};
const hint = { professions: 'One profession on each line.', dates: 'One date on each line, as month-day, e.g. 6-30.', reasons: 'One reason on each line.', int: '' };
const today = () => new Date().toISOString().slice(0, 10);

const link = (ref, url) => (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, ref) : h('span', {}, ref));

function proposeDialog(r, d, reload) {
  const jur = select(d.jurisdictions.map((j) => [j.id, `${j.name} (${j.kindLabel.toLowerCase()})`]), 'For', null);
  jur.value = d.organisation.jurisdictionId;
  const value = r.kind === 'int' ? h('input', { type: 'number', 'aria-label': 'New value', value: asText(r, r.current?.value) }) : h('textarea', { 'aria-label': 'New value', rows: '5' }, asText(r, r.current?.value));
  const from = h('input', { type: 'date', 'aria-label': 'Starts on', value: today() });
  const src = h('input', { 'aria-label': 'Where it comes from', placeholder: r.category === 'ORGANISATIONAL CONFIGURATION' ? 'e.g. Medicines policy v4' : 'e.g. Misuse of Drugs Regulations 1977, reg 44' });
  const url = h('input', { type: 'url', 'aria-label': 'Link to the public page', placeholder: 'https://…' });
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog(`Propose a change: ${r.label}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, `${r.what} A different person approves it before it applies.`),
    field('For', jur), field(`New value${r.unit ? ` (${r.unit})` : ''}`, value), hint[r.kind] ? h('p', { class: 'small muted' }, hint[r.kind]) : null,
    field('Starts on', from), field('Where it comes from', src),
    field(r.category === 'ORGANISATIONAL CONFIGURATION' ? 'Link (optional)' : 'Link to the public official page', url), field('Note (optional)', note)), 'Send for approval', async () => {
    await post('/api/work/rules/propose', { jurisdictionId: jur.value, key: r.key, value: value.value, effectiveFrom: from.value, sourceRef: src.value, sourceUrl: url.value, note: note.value });
    toast('Sent for approval.');
    reload();
  });
}

function decideDialog(r, p, approve, reload) {
  const note = h('input', { 'aria-label': 'Reason', placeholder: approve ? 'Optional' : 'Why it is not approved' });
  dialog(approve ? `Approve: ${r.label}` : `Not approving: ${r.label}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, `${show(r, p.value)}, starting ${p.effectiveFrom}. Source: ${p.sourceRef}.`), field(approve ? 'Note (optional)' : 'Why', note)),
  approve ? 'Approve' : 'Not approved', async () => {
    await post(`/api/work/rules/${approve ? 'approve' : 'reject'}`, { id: p.id, note: note.value });
    toast(approve ? 'Approved. It applies from its start date.' : 'Recorded.');
    reload();
  });
}

function ruleCard(r, d, reload) {
  const cur = r.current;
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' }, h('b', {}, r.label), h('span', { class: 'row' }, h('span', { class: 'tag' }, r.group), h('span', { class: 'tag' }, r.category === 'ORGANISATIONAL CONFIGURATION' ? 'Organisation\'s own' : r.category === 'LAW' ? 'Law' : r.category === 'REGULATION/CODE' ? 'Regulation or code' : r.category))),
    h('div', { class: 'small muted' }, r.what),
    cur ? h('div', {}, h('div', {}, h('b', {}, show(r, cur.value))),
      h('div', { class: 'small muted' }, `From ${cur.effectiveFrom} · version ${cur.version} · set for ${cur.jurisdiction} · source: `, link(cur.sourceRef, cur.sourceUrl), cur.note ? ` · ${cur.note}` : ''))
      : h('div', { class: 'tag warn' }, r.waiting ?? 'Not set for this organisation\'s jurisdiction. Nothing is assumed.'),
    r.pending.map((p) => h('div', { class: 'det-step' },
      h('div', { class: 'small' }, h('b', {}, 'Waiting for approval: '), `${show(r, p.value)}, starting ${p.effectiveFrom}, for ${d.jurisdictions.find((j) => j.id === p.jurisdictionId)?.name ?? p.jurisdictionId}`),
      h('div', { class: 'small muted' }, `Proposed by ${p.proposedBy}, ${fmtDateTime(p.proposedAt)} · source: `, link(p.sourceRef, p.sourceUrl), p.note ? ` · ${p.note}` : ''),
      d.canApprove && p.proposedById !== d.me ? h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => decideDialog(r, p, true, reload) }, 'Approve'),
        h('button', { class: 'btn small', onclick: () => decideDialog(r, p, false, reload) }, 'Not approved'))
        : d.canApprove ? h('div', { class: 'small muted' }, 'You proposed this, so someone else approves it.') : null)),
    d.canPropose && !r.pending.length ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => proposeDialog(r, d, reload) }, 'Propose a change')) : null,
    r.history.length ? h('details', {}, h('summary', { class: 'small' }, `History (${r.history.length})`), h('ol', { class: 'det-steps' }, r.history.map((x) => h('li', { class: 'det-step' },
      h('div', { class: 'small' }, h('b', {}, x.state), ` · version ${x.version} · ${show(r, x.value)} · from ${x.effectiveFrom} · ${d.jurisdictions.find((j) => j.id === x.jurisdictionId)?.name ?? x.jurisdictionId}`),
      h('div', { class: 'small muted' }, `Source: ${x.sourceRef}${x.decidedBy ? ` · decided by ${x.decidedBy}` : ''}${x.decisionNote ? ` · ${x.decisionNote}` : ''}`))))) : null);
}

function addJurisdictionDialog(d, reload) {
  const name = h('input', { 'aria-label': 'Name', placeholder: 'e.g. Victoria, or Queensland Health' });
  const kind = select(Object.entries(d.kinds), 'Kind', null);
  const parent = select(d.jurisdictions.map((j) => [j.id, j.name]), 'Sits inside', 'Nothing: it stands alone');
  dialog('Add a country, state or health system', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'It starts with no rules set. A state or health system uses what the one it sits inside has set, until it sets its own.'),
    field('Name', name), field('Kind', kind), field('Sits inside', parent)), 'Add', async () => {
    await post('/api/work/rules/jurisdiction', { name: name.value, kind: kind.value, parentId: parent.value });
    toast('Added.');
    reload();
  });
}

function moveDialog(d, reload) {
  const jur = select(d.jurisdictions.map((j) => [j.id, j.name]), 'Moves under', null);
  jur.value = d.organisation.jurisdictionId;
  const note = h('input', { 'aria-label': 'Why', placeholder: 'Why the organisation is moving' });
  dialog(`Which rules apply to ${d.organisation.name}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Every rule on this page then comes from the one you choose. A rule it has not set shows as not set, and the screens that need it say so.'),
    field('Jurisdiction', jur), field('Why', note)), 'Save', async () => {
    await post('/api/work/rules/assign', { jurisdictionId: jur.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

export async function rulesView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/rules');
    mount(root,
      workHeader(),
      pageTitle('Rules and settings', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Each rule here is a value with its source, start date and version. One person proposes a change and a different person approves it. It applies from its start date, and the earlier value stays in the history. Where nothing is set, nothing is assumed.'),
      h('div', { class: 'tile stack' },
        h('div', {}, `${d.organisation.name} follows the rules of `, h('b', {}, d.organisation.jurisdiction), '.'),
        d.canApprove ? h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => moveDialog(d, load) }, 'Change which rules apply'),
          h('button', { class: 'btn small', onclick: () => addJurisdictionDialog(d, load) }, 'Add a country, state or health system')) : null),
      d.rules.map((r) => ruleCard(r, d, load)),
    );
  };
  await load();
  return root;
}
