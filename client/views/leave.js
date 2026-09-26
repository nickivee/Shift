import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Leave and outings: asked for → approved (legal authority where it applies) → conditions gone
// through → they leave → away → back on time, extended, or not back → how they are on return.
const TONE = { REQUESTED: 'warn', APPROVED: 'ok', AWAY: 'warn', NOT_RETURNED: 'danger', RETURNED: 'muted', DECLINED: 'muted', CANCELLED: 'muted' };
const EVENT = { EXTENDED: 'Leave extended', CONTACT: 'Contact', NOT_RETURNED: 'Not back' };
const LEGAL_NOTE = 'SHIFT cannot approve leave for someone under a legal order yet. The rules for this are still being researched (RR-LEAVE-001), so follow your service\'s legal process and record the outcome in their notes.';
const local = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const later = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

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

function approveDialog(l, legalOptions, reload) {
  const legal = select(legalOptions, l.legal);
  const note = h('input', { type: 'text', placeholder: 'Anything to add (optional)' });
  const warn = h('p', { class: 'small notice' }, LEGAL_NOTE);
  const sync = () => { warn.hidden = legal.value !== 'ORDER'; };
  legal.addEventListener('change', sync);
  dialog(`Approve leave for ${l.patient}`, h('div', { class: 'stack' },
    h('p', {}, h('b', {}, `${l.kindLabel}: `), l.purpose),
    h('p', { class: 'small' }, `${fmtDateTime(l.leaveAt)} to ${fmtDateTime(l.returnBy)}`),
    l.conditions ? h('p', { class: 'small' }, h('b', {}, 'Conditions: '), l.conditions) : null,
    h('label', { class: 'field' }, 'Legal order', legal), warn,
    h('label', { class: 'field' }, 'Note', note),
  ), 'Approve', async () => {
    await post(`/api/work/leave/${l.id}/approve`, { legal: legal.value, note: note.value });
    toast('Leave approved.');
    reload();
  });
  sync();
}

function extendDialog(l, reload) {
  const until = h('input', { type: 'datetime-local', value: local(new Date(Math.max(Date.parse(l.returnBy), Date.now()) + 2 * 3600_000).toISOString()) });
  const note = h('input', { type: 'text', placeholder: 'Why the leave is longer' });
  dialog(`Extend leave for ${l.patient}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Now due back', until),
    h('label', { class: 'field' }, 'Why', note),
  ), 'Extend', async () => {
    await post(`/api/work/leave/${l.id}/extend`, { returnBy: until.value ? new Date(until.value).toISOString() : '', note: note.value });
    toast('Leave extended.');
    reload();
  });
}

const ASK = {
  decline: { title: 'Do not approve this leave', label: 'Why', confirm: 'Do not approve', done: 'Leave not approved.' },
  cancel: { title: 'Cancel this leave', label: 'Why', confirm: 'Cancel leave', done: 'Leave cancelled.' },
  depart: { title: 'They have left', label: 'What was gone through before they left (conditions, medicines, contact)', confirm: 'They have left', done: 'Recorded as away.' },
  contact: { title: 'Record contact', label: 'Who was contacted and what was said', confirm: 'Save', done: 'Contact recorded.' },
  notReturned: { title: 'Not back from leave', label: 'What has been done to find them and who has been told', confirm: 'Record', done: 'Recorded as not back.' },
  return: { title: 'They are back', label: 'How they are now they are back', confirm: 'They are back', done: 'Recorded as back.' },
};

async function doAction(l, action, options, reload) {
  if (action === 'approve') return approveDialog(l, options.legal, reload);
  if (action === 'extend') return extendDialog(l, reload);
  const a = ASK[action];
  const note = await ask({ title: a.title, message: l.patient, label: a.label, confirm: a.confirm, multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/leave/${l.id}/${action}`, { note });
    toast(a.done);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = {
  approve: ['Approve', true], decline: ['Do not approve', false], depart: ['They have left', true], return: ['They are back', true],
  extend: ['Extend', false], contact: ['Record contact', false], notReturned: ['Not back', false], cancel: ['Cancel', false],
};

export function leaveCard(l, options, reload, { showPatient = true } = {}) {
  const late = l.state === 'NOT_RETURNED' || l.overdue;
  return h('div', { class: `tile stack leave-card${late ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${l.personId}/absence`) }, h('b', {}, l.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, l.kindLabel), l.destination ? ` to ${l.destination}` : ''),
      ),
      h('div', { class: 'row' }, l.overdue ? h('span', { class: 'tag danger' }, 'Late') : null, h('span', { class: `tag ${TONE[l.state] ?? ''}` }, l.stateLabel)),
    ),
    h('div', {}, l.purpose),
    h('div', { class: 'small' }, h('b', {}, l.state === 'AWAY' || l.state === 'NOT_RETURNED' ? 'Due back ' : 'Leaving '),
      l.state === 'AWAY' || l.state === 'NOT_RETURNED' ? fmtDateTime(l.returnBy) : `${fmtDateTime(l.leaveAt)}, back ${fmtDateTime(l.returnBy)}`),
    l.companion ? h('div', { class: 'small' }, h('b', {}, 'With: '), l.companion) : null,
    h('div', { class: 'small' }, h('b', {}, 'Contact: '), l.contact),
    l.conditions ? h('div', { class: 'small' }, h('b', {}, 'Conditions: '), l.conditions) : null,
    l.needsLegal && l.state === 'REQUESTED' ? h('div', { class: 'small notice' }, l.legal === 'ORDER' ? LEGAL_NOTE : 'Whether a legal order applies has not been checked yet.') : null,
    l.departureNote ? h('div', { class: 'small' }, h('b', {}, `Left (${l.departedBy}): `), l.departureNote) : null,
    l.events.length ? h('ul', { class: 'small stack' }, l.events.map((e) => h('li', {},
      h('b', {}, `${EVENT[e.kind] ?? e.kind} (${e.by}, ${fmtDateTime(e.at)}): `), e.note, e.returnBy ? ` Now due back ${fmtDateTime(e.returnBy)}.` : ''))) : null,
    l.returnNote ? h('div', { class: 'small' }, h('b', {}, `Back (${l.returnedBy}, ${fmtDateTime(l.returnedAt)}): `), l.returnNote) : null,
    l.closeReason ? h('div', { class: 'small' }, h('b', {}, `${l.state === 'DECLINED' ? 'Not approved' : 'Cancelled'} (${l.closedBy}): `), l.closeReason) : null,
    h('div', { class: 'small muted' }, [
      `Asked by ${l.requestedBy} ${fmtDateTime(l.requestedAt)}`,
      l.approvedBy ? `approved by ${l.approvedBy}` : null,
    ].filter(Boolean).join(' · ')),
    l.actions.length ? h('div', { class: 'row' }, l.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(l, x, options, reload) }, ACTION[x][0]))) : null,
  );
}

function requestForm(personId, d, reload) {
  const f = {
    kind: select(d.options.kinds, 'DAY'),
    purpose: h('input', { type: 'text', placeholder: 'What the leave is for' }),
    destination: h('input', { type: 'text', placeholder: 'Where they are going' }),
    companion: h('input', { type: 'text', placeholder: 'Who is going with them' }),
    contact: h('input', { type: 'text', placeholder: 'Phone number or how to reach them' }),
    conditions: h('textarea', { placeholder: 'Medicines to take, supports, limits, and when to come back early' }),
    legal: select({ '': 'Choose…', ...d.options.legal }, ''),
    leaveAt: h('input', { type: 'datetime-local', value: local(later(1)) }),
    returnBy: h('input', { type: 'datetime-local', value: local(later(6)) }),
  };
  const warn = h('p', { class: 'small notice' }, LEGAL_NOTE);
  const sync = () => { warn.hidden = f.legal.value !== 'ORDER'; };
  f.legal.addEventListener('change', sync);
  sync();
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      v.leaveAt = v.leaveAt ? new Date(v.leaveAt).toISOString() : '';
      v.returnBy = v.returnBy ? new Date(v.returnBy).toISOString() : '';
      const r = await post(`/api/work/patients/${personId}/leave`, v);
      toast(r.state === 'APPROVED' ? 'Leave approved.' : 'Leave asked for. It needs approval.');
      reload();
    } catch (err) { showError(err); }
  } },
    h('h3', {}, 'Ask for leave'),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Kind', f.kind), h('label', { class: 'field grow' }, 'Legal order', f.legal)),
    warn,
    h('label', { class: 'field' }, 'What for', f.purpose),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Where', f.destination), h('label', { class: 'field grow' }, 'With', f.companion)),
    h('label', { class: 'field' }, 'Contact while away', f.contact),
    h('label', { class: 'field' }, 'Conditions', f.conditions),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Leaving', f.leaveAt), h('label', { class: 'field grow' }, 'Back by', f.returnBy)),
    h('p', { class: 'small muted' }, d.canApprove ? 'You can approve leave, so it is approved when you ask, unless a legal order applies or might.' : 'This will wait for someone who can approve leave.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Ask')),
  );
}

// The patient's Leave and outings view inside the Live Workstation.
export function leavePanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.leave.length ? d.leave.map((l) => leaveCard(l, d.options, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, `No leave planned for this ${state.me.context.subjectLabel.toLowerCase()}.`),
    d.canRequest ? requestForm(personId, d, reload) : null,
    d.past.length ? h('details', {}, h('summary', {}, `Earlier leave (${d.past.length})`),
      h('div', { class: 'stack' }, d.past.map((l) => leaveCard(l, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Leave and outings.
export async function leaveView() {
  const root = h('div');
  const load = async () => {
    const { leave, recent, options } = await get('/api/work/leave');
    const away = leave.filter((l) => ['AWAY', 'NOT_RETURNED'].includes(l.state));
    const coming = leave.filter((l) => !away.includes(l));
    mount(root,
      workHeader(),
      pageTitle('Leave and outings', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Who is away now and when they are due back, then leave waiting to be approved or taken. They keep their bed while they are away.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Away now (${away.length})`),
        away.length ? away.map((l) => leaveCard(l, options, load)) : h('div', { class: 'card empty' }, 'No one is away.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Asked for and approved'),
        coming.length ? coming.map((l) => leaveCard(l, options, load)) : h('div', { class: 'card empty' }, 'No leave waiting.')),
      recent.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Back in the last day'),
        recent.map((l) => leaveCard(l, options, load))) : null,
    );
  };
  await load();
  return root;
}
