import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Safeguarding: concern → safe now → risk → wishes and agreement to share → referred → safety plan
// → followed up → closed. Private: only nurses and doctors who work concerns read them, and each
// read is audited. When a report must be made, and when information may be shared without
// agreement, are still being researched (RR-SAFE-001).
const PRIVATE = 'This is private. Only nurses and doctors who work safeguarding concerns can read it, and every time they do is recorded.';
const RESEARCH = 'When a report must be made, and when information may be shared without their agreement, is still being researched (RR-SAFE-001). SHIFT records who decided and why.';
const LABEL = { safety: 'Safe now', assess: 'Assess risk', refer: 'Referred or told', plan: 'Safety plan', followup: 'Follow up', share: 'Sharing changed', close: 'Close' };
const days = (n) => (n === 1 ? 'Tomorrow' : `In ${n} days`);

function raiseDialog(personId, s, reload) {
  const o = s.options;
  const kind = select(Object.entries(o.kinds), 'What kind of concern');
  const how = select(Object.entries(o.how), 'How you know');
  const concern = h('textarea', { 'aria-label': 'What you saw or heard', placeholder: 'What you saw or heard, in their words where you can' });
  const involved = h('input', { 'aria-label': 'Who may be causing harm', placeholder: 'Optional, e.g. "Her partner"' });
  const share = select(Object.entries(o.share), 'Do they agree to it being shared');
  const wishes = h('input', { 'aria-label': 'What they want', placeholder: 'e.g. Wants to go home but not with him' });
  dialog('Raise a safeguarding concern', h('div', { class: 'stack' },
    h('p', { class: 'small' }, PRIVATE),
    h('p', { class: 'small' }, 'If they are in danger right now, get help first: tell the nurse in charge, or call 111.'),
    field('What kind of concern', kind), field('How you know', how), field('What you saw or heard', concern),
    field('Who may be causing harm', involved), field('Do they agree to it being shared', share), field('What they want', wishes),
  ), 'Raise concern', async () => {
    await post(`/api/work/patients/${personId}/safeguarding`, { kind: kind.value, how: how.value, concern: concern.value, involved: involved.value, share: share.value, wishes: wishes.value });
    toast(s.canManage ? 'Raised.' : 'Raised. A nurse has been asked to look at it today.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/safeguarding/${x.id}/${action}`, { note: note.value, ...body });
  const saved = () => { toast('Saved.'); reload(); };
  const followSelect = () => select(o.followDays.map((n) => [String(n), days(n)]), 'Follow up', null);
  if (action === 'safety') {
    note.placeholder = 'e.g. Moved to a cubicle away from the waiting room; partner asked to wait outside';
    return dialog('Safe now', h('div', { class: 'stack' }, field('What was done to keep them safe now', note)), 'Save', async () => { await send({}); saved(); });
  }
  if (action === 'assess') {
    note.placeholder = 'What you found, and who else is at risk, including children';
    const risk = select(Object.entries(o.risk), 'Risk');
    return dialog('Assess risk', h('div', { class: 'stack' }, field('Risk', risk), field('What you found', note), h('p', { class: 'small muted' }, RESEARCH)), 'Save', async () => { await send({ risk: risk.value }); saved(); });
  }
  if (action === 'refer') {
    note.placeholder = 'Who you spoke with and what was agreed';
    const to = select(Object.entries(o.to), 'Who was told');
    const why = h('textarea', { 'aria-label': 'Why share anyway', placeholder: 'Why it is being shared anyway, and who decided' });
    return dialog('Referred or told', h('div', { class: 'stack' },
      field('Who was told', to), field('What was agreed', note),
      x.share !== 'AGREED' ? h('div', { class: 'stack' }, h('p', { class: 'small' }, `${x.shareLabel}.`), field('Why share anyway', why)) : null,
      h('p', { class: 'small muted' }, RESEARCH),
    ), 'Save', async () => { await send({ to: to.value, why: why.value }); saved(); });
  }
  if (action === 'plan' || action === 'followup') {
    note.placeholder = action === 'plan' ? 'e.g. Visits from her son only with staff present; she has a helpline number' : 'What you found when you followed up';
    const follow = followSelect();
    return dialog(action === 'plan' ? 'Safety plan' : 'Follow up', h('div', { class: 'stack' }, field(action === 'plan' ? 'The plan' : 'What you found', note), field('Follow up', follow)),
      'Save', async () => { await send({ followDays: Number(follow.value) }); saved(); });
  }
  if (action === 'share') {
    note.placeholder = 'What they said';
    const share = select(Object.entries(o.share), 'What they now say'); share.value = x.share;
    return dialog('Sharing changed', h('div', { class: 'stack' }, field('What they now say', share), field('What they said', note)), 'Save', async () => { await send({ share: share.value }); saved(); });
  }
  note.placeholder = 'What was done and who it was handed on to';
  const reason = select(Object.entries(o.close), 'Why it is closing');
  return dialog('Close the concern', h('div', { class: 'stack' }, field('Why it is closing', reason), field('What was done', note)), 'Close concern', async () => { await send({ reason: reason.value }); saved(); });
}

function concernCard(x, o, reload) {
  if (!x.full) {
    return h('div', { class: 'tile stack safeguard' },
      h('div', { class: 'spread' }, h('b', {}, x.kindLabel), h('span', { class: 'tag' }, x.stateLabel)),
      h('div', { class: 'small' }, x.concern),
      h('div', { class: 'small muted' }, `You raised this ${fmtDateTime(x.raisedAt)}. A nurse or doctor works it from here.`));
  }
  return h('div', { class: `tile stack safeguard sg-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('b', {}, x.kindLabel),
      h('span', { class: `tag ${x.overdue || x.risk === 'IMMEDIATE' || x.risk === 'HIGH' ? 'danger' : x.state === 'RAISED' ? 'warn' : ''}` },
        x.overdue ? 'Follow-up overdue' : x.riskLabel ?? x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `${x.howLabel}: `), x.concern),
    x.involved ? h('div', { class: 'small' }, h('b', {}, 'Who may be causing harm: '), x.involved) : null,
    x.wishes ? h('div', { class: 'small' }, h('b', {}, 'What they want: '), x.wishes) : null,
    h('div', { class: `small${x.share === 'AGREED' ? '' : ' warn-text'}` }, h('b', {}, 'Sharing: '), x.shareLabel),
    x.followDue && x.state !== 'CLOSED' ? h('div', { class: 'small muted' }, `Follow up by ${fmtDateTime(x.followDue)}`) : null,
    h('div', { class: 'small muted' }, `Raised by ${x.raisedBy} ${fmtDateTime(x.raisedAt)}`),
    x.closeNote ? h('div', { class: 'small' }, h('b', {}, `${x.closeLabel} (${x.closedBy} ${fmtDateTime(x.closedAt)}): `), x.closeNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'safety' && x.state === 'RAISED' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
      h('div', { class: 'small muted' }, `${s.kindLabel}${s.toLabel ? `: ${s.toLabel}` : ''} · ${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body)))),
  );
}

// Inside the person's Incidents, complaints and safeguarding view, below their complaints.
export function safeguardingPanel(personId, s, reload) {
  const open = s.concerns.filter((x) => x.state !== 'CLOSED');
  const closed = s.concerns.filter((x) => x.state === 'CLOSED');
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Safeguarding'),
      s.canRaise ? h('button', { class: 'btn small', onclick: () => raiseDialog(personId, s, reload) }, 'Raise a concern') : null),
    s.canManage ? h('p', { class: 'small muted' }, PRIVATE) : null,
    open.length ? open.map((x) => concernCard(x, s.options, reload)) : h('div', { class: 'empty' }, s.others ? 'There is a concern you cannot read. Check with the nurse in charge.' : 'No open concerns.'),
    closed.length ? h('details', {}, h('summary', { class: 'small' }, `Closed (${closed.length})`), h('div', { class: 'stack' }, closed.map((x) => concernCard(x, s.options, reload)))) : null,
  );
}
