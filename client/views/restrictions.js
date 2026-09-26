import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Clinical restriction / precaution: need identified → authorised → what, which side, from
// when and until when → everyone caring for the person reads it → checks that it is followed
// → review → changed or stopped. Who may authorise each kind is the organisation's setting.
const STATUS = {
  PROPOSED: ['Waiting for authorisation', 'warn'], CURRENT: ['In force', 'danger'], UPCOMING: ['Starts later', 'warn'],
  CEASED: ['Ended', 'muted'], DECLINED: ['Not authorised', 'muted'], SUPERSEDED: ['Changed', 'muted'],
};
const RESTRAINT = 'Restraint, and anything that limits a person\'s freedom of movement without their agreement, is not recorded here. The rules for it are still being researched (RR-RESTRAINT-001).';
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const local = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const who = (list) => list.map((p) => p.toLowerCase()).join(' or ');

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
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, typeof v === 'string' ? v : v.label)));
  if (value) s.value = value;
  return s;
};

// The fields that say what a restriction is, shared by proposing one and changing one.
function restrictionFields(options, r = {}) {
  const f = {
    kind: select(options.kinds, r.kind),
    side: select(options.sides, r.side ?? 'LEFT'),
    detail: h('input', { type: 'text', value: r.detail ?? '', placeholder: 'The restriction itself, e.g. no more than 1.5 L a day' }),
    instructions: h('textarea', { placeholder: 'What staff should do' }),
    reason: h('input', { type: 'text', value: r.reason ?? '', placeholder: 'Why it is needed' }),
    patientView: select(options.views, r.patientView ?? 'NOT_YET'),
    effectiveFrom: h('input', { type: 'datetime-local', value: r.id ? '' : local(new Date().toISOString()) }),
    effectiveUntil: h('input', { type: 'datetime-local', value: local(r.effectiveUntil) }),
    reviewDate: h('input', { type: 'date', value: inDays(1) }),
  };
  f.instructions.value = r.instructions ?? '';
  const sideField = h('label', { class: 'field grow' }, 'Side', f.side);
  const notAgreed = h('p', { class: 'small notice' }, RESTRAINT);
  const sync = () => {
    sideField.hidden = !options.kinds[f.kind.value].side;
    notAgreed.hidden = f.patientView.value !== 'NOT_AGREED';
  };
  f.kind.addEventListener('change', sync);
  f.patientView.addEventListener('change', sync);
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  const body = (withKind) => {
    const el = h('div', { class: 'stack' },
      withKind ? h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Kind', f.kind), sideField) : (r.side ? h('div', { class: 'row' }, sideField) : null),
      h('label', { class: 'field' }, 'Restriction', f.detail),
      h('label', { class: 'field' }, 'What staff should do', f.instructions),
      withKind ? h('label', { class: 'field' }, 'Why', f.reason) : null,
      h('label', { class: 'field' }, "Patient's view", f.patientView),
      notAgreed,
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'From', f.effectiveFrom), h('label', { class: 'field grow' }, 'Until (optional)', f.effectiveUntil)),
      h('label', { class: 'field' }, 'Review by', f.reviewDate),
    );
    sync();
    return el;
  };
  return { values, body, kind: f.kind };
}

function reviewDialog(r, options, reload) {
  const outcomes = r.canChange ? options.outcomes : { CONTINUE: options.outcomes.CONTINUE };
  const outcome = select(outcomes, 'CONTINUE');
  const finding = h('textarea', { placeholder: 'What the review found' });
  const next = h('input', { type: 'date', value: inDays(1) });
  const change = restrictionFields(options, r);
  const continueBox = h('label', { class: 'field' }, 'Next review', next);
  const changeBox = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'The current restriction is kept in the history and the new one replaces it.'), change.body(false));
  const sync = () => { continueBox.hidden = outcome.value !== 'CONTINUE'; changeBox.hidden = outcome.value !== 'CHANGED'; };
  outcome.addEventListener('change', sync);
  dialog(`Review: ${r.label.toLowerCase()}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Finding', finding),
    h('label', { class: 'field' }, 'Decision', outcome),
    r.canChange ? null : h('p', { class: 'small muted' }, `Changing or stopping it is done by a ${who(r.authorisers)}.`),
    continueBox, changeBox,
  ), 'Save review', async () => {
    const body = { outcome: outcome.value, note: finding.value };
    await post(`/api/work/restrictions/${r.id}/review`, outcome.value === 'CHANGED' ? { ...change.values(), ...body } : { ...body, reviewDate: next.value });
    toast({ CONTINUE: 'Review saved.', CHANGED: 'Restriction changed.', STOPPED: 'Restriction stopped.' }[outcome.value]);
    reload();
  });
  sync();
}

function checkDialog(r, reload) {
  const followed = select({ true: 'Yes, it is being followed', false: 'No, it was not followed' }, 'true');
  const note = h('textarea', { placeholder: 'Optional if followed; what happened and what was done if not' });
  dialog(`Check: ${r.label.toLowerCase()}`, h('div', { class: 'stack' },
    h('p', { class: 'summary' }, r.detail),
    h('label', { class: 'field' }, 'Followed?', followed),
    h('label', { class: 'field' }, 'Note', note),
  ), 'Save check', async () => {
    await post(`/api/work/restrictions/${r.id}/check`, { followed: followed.value === 'true', note: note.value });
    toast(followed.value === 'true' ? 'Check recorded.' : 'Recorded. Tell the person in charge.');
    reload();
  });
}

async function doAction(r, action, options, reload) {
  if (action === 'review') return reviewDialog(r, options, reload);
  if (action === 'check') return checkDialog(r, reload);
  let body = {};
  if (action === 'decline') {
    const own = !r.actions.includes('authorise');
    const note = await ask(own
      ? { title: 'Withdraw this proposal', message: r.label, label: 'Why', confirm: 'Withdraw', multiline: true, minLength: 3 }
      : { title: 'Do not authorise', message: `${r.proposedBy} will see your reason.`, label: 'Why not', confirm: 'Do not authorise', multiline: true, minLength: 3 });
    if (!note) return;
    body = { note };
  }
  try {
    await post(`/api/work/restrictions/${r.id}/${action}`, body);
    toast({ authorise: 'Authorised. It shows on the record for everyone caring for them.', decline: 'Done.', read: 'Marked as read.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { authorise: ['Authorise', true], read: ["I've read this", true], check: ['Record check', false], review: ['Review', false], decline: ['Decline', false] };

export function restrictionCard(r, options, reload, { showPatient = true } = {}) {
  const [label, tone] = STATUS[r.status] ?? [r.status, ''];
  const open = r.state === 'PROPOSED' || r.state === 'ACTIVE';
  const decline = r.state === 'PROPOSED' && !r.actions.includes('authorise') ? 'Withdraw' : 'Do not authorise';
  return h('div', { class: `tile stack${r.status === 'CURRENT' ? ' restriction-on' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${r.personId}/restrictions`) }, h('b', {}, r.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, r.label), showPatient && r.location ? ` · ${r.location}` : ''),
      ),
      h('div', { class: 'row' },
        r.reviewDue ? h('span', { class: 'tag warn' }, 'Review due') : null,
        open && r.state === 'ACTIVE' && !r.read && r.actions.includes('read') ? h('span', { class: 'tag warn' }, 'Not read by you') : null,
        h('span', { class: `tag ${tone}` }, label),
      ),
    ),
    h('div', { class: 'summary' }, h('b', {}, r.detail), r.instructions ? h('div', {}, r.instructions) : null),
    h('div', { class: 'small' }, [
      r.reason,
      open ? (r.effectiveUntil ? `${fmtDateTime(r.effectiveFrom)} until ${fmtDateTime(r.effectiveUntil)}` : `from ${fmtDateTime(r.effectiveFrom)}`) : null,
      `patient: ${r.patientViewLabel.toLowerCase()}`,
    ].filter(Boolean).join(' · ')),
    r.patientView === 'NOT_AGREED' && open ? h('div', { class: 'small notice' }, RESTRAINT) : null,
    r.state === 'PROPOSED' ? h('div', { class: 'small' }, `Proposed by ${r.proposedBy}, ${fmtDateTime(r.proposedAt)}. Authorised by a ${who(r.authorisers)}.`)
      : h('div', { class: 'small muted' }, [`Authorised by ${r.authorisedBy ?? r.proposedBy} (${r.service}) ${fmtDateTime(r.authorisedAt ?? r.proposedAt)}`,
        r.reviewDate && open ? `review by ${fmtDate(r.reviewDate)}` : null].filter(Boolean).join(' · ')),
    r.acks.length && open ? h('div', { class: 'small muted' }, `Read by ${r.acks.map((a) => a.by).join(', ')}`) : null,
    r.checks.length && !r.checks[0].followed ? h('div', { class: 'small' }, h('span', { class: 'tag danger' }, 'Not followed'),
      ` ${fmtDateTime(r.checks[0].at)}, ${r.checks[0].by}: ${r.checks[0].note ?? ''}`) : null,
    r.checks.length ? h('details', {}, h('summary', {}, `Checks (${r.checks.length})`),
      h('ul', { class: 'small stack' }, r.checks.map((c) => h('li', {}, h('b', {}, `${fmtDateTime(c.at)}, ${c.by}: `),
        c.followed ? 'Followed' : h('span', { class: 'tag danger' }, 'Not followed'), c.note ? ` ${c.note}` : ''))))
      : null,
    r.reviews.length ? h('div', { class: 'small' }, h('b', {}, `Last review (${r.reviews[0].by}, ${fmtDateTime(r.reviews[0].at)}): `), `${r.reviews[0].outcomeLabel}. ${r.reviews[0].finding}`) : null,
    r.closeReason && !open ? h('div', { class: 'small' }, h('b', {}, `${label}${r.closedBy ? ` (${r.closedBy})` : ''}: `), r.closeReason) : null,
    r.actions.length ? h('div', { class: 'row' }, r.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(r, x, options, reload) }, x === 'decline' ? decline : ACTION[x][0]))) : null,
  );
}

// The patient's Restrictions view inside the Live Workstation.
export function restrictionsPanel(personId, d, reload) {
  const form = () => {
    const f = restrictionFields(d.options);
    const note = h('p', { class: 'small muted' });
    const sync = () => {
      const k = d.options.kinds[f.kind.value];
      note.textContent = d.profession && k.authorisers.includes(d.profession)
        ? 'You can authorise this, so it takes effect when you save.'
        : `This is authorised by a ${who(k.authorisers)}. It will wait for them.`;
    };
    f.kind.addEventListener('change', sync);
    sync();
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await post(`/api/work/patients/${personId}/restrictions`, f.values());
        toast(r.state === 'ACTIVE' ? 'Restriction in place. It shows on the record for everyone caring for them.' : 'Proposed. It waits for authorisation.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Add a restriction or precaution'),
      f.body(true),
      note,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
    );
  };
  return h('div', { class: 'stack' },
    d.restrictions.length ? d.restrictions.map((r) => restrictionCard(r, d.options, reload, { showPatient: false })) : h('div', { class: 'empty' }, 'No restrictions for this patient.'),
    d.canPropose ? form() : null,
    d.past.length ? h('details', {}, h('summary', {}, `Ended (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((r) => restrictionCard(r, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Restrictions.
export async function restrictionsView() {
  const root = h('div');
  const load = async () => {
    const { restrictions: rows, options } = await get('/api/work/restrictions');
    const waiting = rows.filter((r) => r.state === 'PROPOSED');
    const unread = rows.filter((r) => r.state === 'ACTIVE' && r.actions.includes('read'));
    const rest = rows.filter((r) => r.state === 'ACTIVE' && !r.actions.includes('read'));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((r) => restrictionCard(r, options, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Restrictions', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Restrictions and precautions for the people your service is caring for, whichever service set them.'),
      waiting.length ? section('Waiting for authorisation', waiting, '') : null,
      section('Not read by you yet', unread, 'You have read them all.'),
      section('In place', rest, 'None.'),
    );
  };
  await load();
  return root;
}
