import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Whānau and support people: who they are → how they are related → what the person wants → what
// may be shared → any legal authority seen → every contact → changes and limits.
const NOT_AGREED = 'The person has not agreed that this person can be told about their health. When it may be shared without agreement is still being researched (RR-WHANAU-001).';
const AUTHORITY_NOTE = 'SHIFT records that the document was seen. Whether it is in effect is still being researched (RR-CAP-001).';
const SHARE_TONE = { ALL: 'ok', GENERAL: 'warn', NOTHING: 'danger', UNKNOWN: 'muted' };

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

// The fields that describe a support person, shared by adding and changing.
function fields(options, p = {}) {
  const f = {
    name: h('input', { type: 'text', value: p.name ?? '', placeholder: 'Their name' }),
    relationship: select({ '': 'Choose…', ...options.relationships }, p.relationship ?? ''),
    relationshipNote: h('input', { type: 'text', value: p.relationshipNote ?? '', placeholder: 'e.g. eldest daughter, lives nearby (optional)' }),
    phone: h('input', { type: 'text', value: p.phone ?? '', placeholder: 'Phone (optional)' }),
    firstContact: h('input', { type: 'checkbox', checked: !!p.firstContact }),
    wishes: select(options.wishes, p.wishes ?? 'NOT_YET'),
    share: select(options.share, p.share ?? 'UNKNOWN'),
    involve: h('input', { type: 'text', value: p.involve ?? '', placeholder: 'What the person wants them involved in, e.g. discharge planning' }),
    limits: h('input', { type: 'text', value: p.limits ?? '', placeholder: 'Anything they must not be told or do (optional)' }),
    authority: select(options.authority, p.authority ?? 'NONE'),
    authorityRef: h('input', { type: 'text', value: p.authorityRef ?? '', placeholder: 'Which document you saw, and its date' }),
  };
  const shareField = h('label', { class: 'field' }, 'What the person agrees can be shared', f.share);
  const involveField = h('label', { class: 'field' }, 'Involve them in', f.involve);
  const refField = h('label', { class: 'field' }, 'Document seen', f.authorityRef);
  const authNote = h('p', { class: 'small notice' }, AUTHORITY_NOTE);
  const notAsked = h('p', { class: 'small notice' }, 'Until the person says, treat what can be shared as not known.');
  const sync = () => {
    const asked = f.wishes.value === 'ASKED';
    shareField.hidden = !asked; involveField.hidden = !asked; notAsked.hidden = asked;
    refField.hidden = f.authority.value === 'NONE'; authNote.hidden = f.authority.value === 'NONE';
  };
  f.wishes.addEventListener('change', sync);
  f.authority.addEventListener('change', sync);
  sync();
  const body = h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Name', f.name), h('label', { class: 'field grow' }, 'Relationship', f.relationship)),
    h('label', { class: 'field' }, 'About them', f.relationshipNote),
    h('label', { class: 'field' }, 'Phone', f.phone),
    h('label', { class: 'check' }, f.firstContact, ' First person to contact'),
    h('label', { class: 'field' }, "The person's wishes", f.wishes), notAsked,
    shareField, involveField,
    h('label', { class: 'field' }, 'Limits', f.limits),
    h('label', { class: 'field' }, 'Legal authority', f.authority), refField, authNote,
  );
  const values = () => ({ ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])), firstContact: f.firstContact.checked });
  return { body, values };
}

function contactDialog(p, options, reload) {
  const kind = select(options.contacts, 'WE_CALLED');
  const summary = h('textarea', { placeholder: 'What was talked about' });
  const shared = select(p.mayShare
    ? { NONE: 'No health information shared', HEALTH: 'Health information shared, as the person agreed' }
    : { NONE: 'No health information shared' }, 'NONE');
  dialog(`Contact with ${p.name}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Kind', kind),
    h('label', { class: 'field' }, 'Summary', summary),
    h('label', { class: 'field' }, 'Health information', shared),
    p.mayShare ? (p.share === 'GENERAL' ? h('p', { class: 'small notice' }, 'The person agreed to general updates only.') : null) : h('p', { class: 'small notice' }, NOT_AGREED),
  ), 'Save', async () => {
    await post(`/api/work/whanau/${p.id}/contact`, { kind: kind.value, summary: summary.value, shared: shared.value });
    toast('Contact recorded.');
    reload();
  });
}

function changeDialog(p, options, reload) {
  const f = fields(options, p);
  const note = h('input', { type: 'text', placeholder: 'What changed and who said so' });
  dialog(`Change ${p.name}`, h('div', { class: 'stack' }, f.body, h('label', { class: 'field' }, 'Why', note)), 'Save change', async () => {
    await post(`/api/work/whanau/${p.id}/change`, { ...f.values(), note: note.value });
    toast('Changed.');
    reload();
  });
}

async function doAction(p, action, options, reload) {
  if (action === 'contact') return contactDialog(p, options, reload);
  if (action === 'change') return changeDialog(p, options, reload);
  const note = await ask({ title: `${p.name} is no longer a support person`, message: p.relationshipLabel, label: 'Why, and who said so', confirm: 'Remove', multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/whanau/${p.id}/end`, { note });
    toast('Removed. Their earlier contacts are kept.');
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { contact: ['Record contact', true], change: ['Change', false], end: ['No longer involved', false] };

export function supportCard(p, options, reload) {
  const ended = p.state === 'ENDED';
  return h('div', { class: `tile stack support${p.share === 'NOTHING' || p.limits ? ' support-limit' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, p.name), h('div', { class: 'small muted' }, p.relationshipLabel, p.relationshipNote ? `, ${p.relationshipNote}` : '')),
      h('div', { class: 'row' },
        p.firstContact ? h('span', { class: 'tag ok' }, 'First contact') : null,
        ended ? h('span', { class: 'tag muted' }, 'No longer involved') : h('span', { class: `tag ${SHARE_TONE[p.share] ?? ''}` }, p.shareLabel)),
    ),
    p.phone ? h('div', { class: 'small' }, h('b', {}, 'Phone: '), p.phone) : null,
    h('div', { class: 'small' }, h('b', {}, 'Wishes: '), p.wishesLabel),
    p.involve ? h('div', { class: 'small' }, h('b', {}, 'Involve in: '), p.involve) : null,
    p.limits ? h('div', { class: 'small notice' }, h('b', {}, 'Limits: '), p.limits) : null,
    p.authority !== 'NONE' ? h('div', { class: 'small' }, h('b', {}, `${p.authorityLabel}: `), `${p.authorityRef}. Seen by ${p.authoritySeenBy} ${fmtDateTime(p.authoritySeenAt)}. `, h('span', { class: 'muted' }, AUTHORITY_NOTE)) : null,
    p.contacts.length ? h('details', {}, h('summary', { class: 'small' }, `Contacts (${p.contacts.length})`), h('ul', { class: 'small stack' }, p.contacts.map((c) => h('li', {},
      h('b', {}, `${c.kindLabel}, ${fmtDateTime(c.at)} (${c.by}, ${c.service}): `), c.summary,
      c.shared === 'HEALTH' ? h('span', { class: 'tag warn' }, ' Health information shared') : h('span', { class: 'tag muted' }, ' No health information'))))) : null,
    p.history?.some((c) => c.from_state === c.to_state) ? h('details', {}, h('summary', { class: 'small' }, `Changes (${p.history.filter((c) => c.from_state === c.to_state).length})`),
      h('ul', { class: 'small stack' }, p.history.filter((c) => c.from_state === c.to_state).map((c) => h('li', {}, h('b', {}, `${c.actor ?? 'SHIFT'}, ${fmtDateTime(c.at)}: `), c.reason)))) : null,
    ended ? h('div', { class: 'small' }, h('b', {}, `Removed (${p.endedBy}): `), p.endReason) : null,
    h('div', { class: 'small muted' }, [`Added by ${p.addedBy} ${fmtDateTime(p.addedAt)}`, p.updatedBy ? `changed by ${p.updatedBy} ${fmtDateTime(p.updatedAt)}` : null].filter(Boolean).join(' · ')),
    p.actions.length ? h('div', { class: 'row' }, p.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(p, x, options, reload) }, ACTION[x][0]))) : null,
  );
}

function addForm(personId, d, reload) {
  const f = fields(d.options);
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/whanau`, f.values());
      toast('Added.');
      reload();
    } catch (err) { showError(err); }
  } }, h('h3', {}, 'Add whānau or a support person'), f.body, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add')));
}

// The person's Whānau and support view inside the Live Workstation.
export function supportPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.people.length ? d.people.map((p) => supportCard(p, d.options, reload))
      : h('div', { class: 'empty' }, `No whānau or support people recorded for this ${subject}. Ask them who they want involved.`),
    d.canManage ? h('details', {}, h('summary', {}, 'Add whānau or a support person'), addForm(personId, d, reload)) : null,
    d.past.length ? h('details', {}, h('summary', {}, `No longer involved (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((p) => supportCard(p, d.options, reload)))) : null,
  );
}

// Home → Whānau and support.
export async function whanauView() {
  const root = h('div');
  const load = async () => {
    const { patients, options } = await get('/api/work/whanau');
    const ask = patients.filter((p) => p.toAsk);
    const card = (p) => h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${p.id}/support`) }, h('b', {}, p.name)), h('span', { class: 'muted small' }, p.location ?? '')),
      p.people.length ? p.people.map((s) => supportCard(s, options, load)) : h('div', { class: 'small muted' }, 'No one recorded yet.'));
    mount(root,
      workHeader(),
      pageTitle('Whānau and support', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Who each person wants involved and what they agree can be shared. People to ask come first.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Ask about whānau (${ask.length})`),
        ask.length ? ask.map(card) : h('div', { class: 'card empty' }, 'Everyone has been asked.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Everyone else'), patients.filter((p) => !p.toAsk).map(card)),
    );
  };
  await load();
  return root;
}
