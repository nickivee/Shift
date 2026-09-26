import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Bed and location: placement need → move asked for → bed found and held → patient moved →
// the old bed goes for cleaning. Every stay in a bed is kept.
const STATE = { REQUESTED: ['Needs a bed', 'warn'], ALLOCATED: ['Bed held', 'ok'], MOVED: ['Moved', 'muted'], CANCELLED: ['Cancelled', 'muted'] };
const BED = { AVAILABLE: 'ok', RESERVED: 'warn', OCCUPIED: '', CLEANING: 'muted' };

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

function allocateDialog(m, reload) {
  const pick = h('select', {}, m.beds.map((b) => h('option', { value: b.id }, `${b.label}${b.matches ? '' : ` (no ${b.missing.join(', ').toLowerCase()})`}`)));
  const note = h('input', { type: 'text', placeholder: 'Needed if the bed does not meet every need' });
  const info = h('p', { class: 'small muted' });
  const sync = () => {
    const b = m.beds.find((x) => x.id === pick.value);
    info.textContent = b ? (b.features.length ? b.features.join(' · ') : 'No listed features') : '';
  };
  pick.addEventListener('change', sync);
  dialog(`Find a bed for ${m.patient}`, h('div', { class: 'stack' },
    m.needLabels.length ? h('p', {}, h('b', {}, 'Needs: '), m.needLabels.join(', ')) : null,
    m.beds.length ? h('label', { class: 'field' }, 'Bed', pick) : h('p', { class: 'notice' }, 'No beds are available.'),
    info,
    h('label', { class: 'field' }, 'Note', note),
  ), 'Hold this bed', async () => {
    await post(`/api/work/moves/${m.id}/allocate`, { bedId: pick.value, note: note.value });
    toast('Bed held.');
    reload();
  });
  sync();
}

async function doAction(m, action, reload) {
  if (action === 'allocate') return allocateDialog(m, reload);
  let note = '';
  if (action === 'cancel' || action === 'release') {
    note = await ask(action === 'cancel'
      ? { title: 'Cancel this move', message: m.patient, label: 'Why it is no longer needed', confirm: 'Cancel move', multiline: true, minLength: 3 }
      : { title: `Give back ${m.bed}`, message: 'The move goes back to needing a bed.', label: 'Why', confirm: 'Give back', multiline: true, minLength: 3 });
    if (!note) return;
  }
  try {
    await post(`/api/work/moves/${m.id}/${action}`, { note });
    toast({ move: `Moved to ${m.bed}. The old bed is marked for cleaning.`, cancel: 'Move cancelled.', release: 'Bed given back.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { allocate: ['Find a bed', true], move: ['Patient moved', true], release: ['Give back bed', false], cancel: ['Cancel', false] };

export function moveCard(m, reload, { showPatient = true } = {}) {
  const [label, tone] = STATE[m.state] ?? [m.state, ''];
  return h('div', { class: `tile stack${m.urgency === 'NOW' && m.state === 'REQUESTED' ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${m.personId}/location`) }, h('b', {}, m.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, m.bed ? `${m.fromBed} to ${m.bed}` : `From ${m.fromBed}`)),
      ),
      h('div', { class: 'row' }, ['REQUESTED', 'ALLOCATED'].includes(m.state) ? h('span', { class: `tag ${m.urgency === 'NOW' ? 'danger' : ''}` }, m.urgencyLabel) : null, h('span', { class: `tag ${tone}` }, label)),
    ),
    h('div', {}, m.reason),
    m.needLabels.length ? h('div', { class: 'small' }, h('b', {}, 'Needs: '), m.needLabels.join(', ')) : null,
    m.allocationNote ? h('div', { class: 'small' }, h('b', {}, 'Bed note: '), m.allocationNote) : null,
    m.closeReason ? h('div', { class: 'small' }, h('b', {}, `Cancelled (${m.closedBy}): `), m.closeReason) : null,
    h('div', { class: 'small muted' }, [
      `Asked by ${m.requestedBy} ${fmtDateTime(m.requestedAt)}`,
      m.allocatedBy ? `bed held by ${m.allocatedBy}` : null,
      m.movedBy ? `moved by ${m.movedBy} ${fmtDateTime(m.movedAt)}` : null,
    ].filter(Boolean).join(' · ')),
    m.actions.length ? h('div', { class: 'row' }, m.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(m, x, reload) }, ACTION[x][0]))) : null,
  );
}

function stays(list) {
  return h('ul', { class: 'small stack' }, list.map((s) => h('li', {},
    h('b', {}, `${s.bed ?? s.patient}: `), `${fmtDateTime(s.fromAt)} to ${s.untilAt ? fmtDateTime(s.untilAt) : 'now'}.`,
    s.reasonIn ? ` In: ${s.reasonIn}.` : '', s.reasonOut ? ` Out: ${s.reasonOut}.` : '')));
}

// The patient's Bed and location view inside the Live Workstation.
export function locationPanel(personId, d, reload) {
  const form = () => {
    const boxes = Object.entries(d.options.features).map(([k, v]) => {
      const box = h('input', { type: 'checkbox', value: k });
      return h('label', { class: 'check' }, box, ` ${v}`);
    });
    const reason = h('input', { type: 'text', placeholder: 'Why they need to move' });
    const urgency = h('select', {}, Object.entries(d.options.urgency).map(([k, v]) => h('option', { value: k }, v)));
    urgency.value = 'TODAY';
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const needs = boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value).join(',');
        await post(`/api/work/patients/${personId}/moves`, { needs, reason: reason.value, urgency: urgency.value });
        toast('Move asked for.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Ask for a move'),
      h('label', { class: 'field' }, 'Why', reason),
      h('div', { class: 'field' }, 'Needs', h('div', { class: 'checks' }, boxes)),
      h('label', { class: 'field' }, 'How soon', urgency),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Ask')),
    );
  };
  const open = d.moves.filter((m) => ['REQUESTED', 'ALLOCATED'].includes(m.state));
  return h('div', { class: 'stack' },
    d.bed ? h('div', { class: 'tile stack' },
      h('div', { class: 'spread' }, h('b', {}, d.bed.label), h('span', { class: 'muted small' }, d.bed.service)),
      h('div', { class: 'small' }, d.bed.features.length ? d.bed.features.join(' · ') : 'No listed features'),
      d.bed.since ? h('div', { class: 'small muted' }, `Here since ${fmtDateTime(d.bed.since)}`) : null,
    ) : h('div', { class: 'empty' }, 'Not in a bed on the bed board.'),
    open.map((m) => moveCard(m, reload, { showPatient: false })),
    d.canRequest ? form() : null,
    d.stays.length ? h('details', {}, h('summary', {}, `Where they have been (${d.stays.length})`), stays(d.stays)) : null,
    d.moves.length > open.length ? h('details', {}, h('summary', {}, 'Earlier moves'), h('div', { class: 'stack' }, d.moves.filter((m) => !open.includes(m)).map((m) => moveCard(m, reload, { showPatient: false })))) : null,
  );
}

async function bedDialog(b) {
  try {
    const r = await get(`/api/work/beds/${b.id}/history`);
    dialog(r.label, h('div', { class: 'stack' },
      b.features.length ? h('p', { class: 'small' }, b.features.join(' · ')) : null,
      r.stays.length ? stays(r.stays) : h('p', { class: 'muted' }, 'No stays recorded yet.'),
    ), 'Close', async () => {});
  } catch (err) { showError(err); }
}

// Home → Bed moves.
export async function movesView() {
  const root = h('div');
  const load = async () => {
    const { moves, beds } = await get('/api/work/moves');
    mount(root,
      workHeader(),
      pageTitle('Bed moves', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Moves asked for, most urgent first. Beds that meet every need are listed first; a bed that does not needs a note.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Moves'),
        moves.length ? moves.map((m) => moveCard(m, load)) : h('div', { class: 'card empty' }, 'No moves waiting.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Beds'),
        h('div', { class: 'bed-grid' }, beds.map((b) => h('button', { class: `bed-cell bed-${b.state.toLowerCase()}`, onclick: () => bedDialog(b) },
          h('b', {}, b.label.replace(/^.*Bed /, 'Bed ')),
          h('span', { class: `tag ${BED[b.state] ?? ''}` }, b.state === 'RESERVED' ? 'Held' : b.state.charAt(0) + b.state.slice(1).toLowerCase()),
          b.patient ? h('span', { class: 'small' }, b.patient) : null,
          b.features.length ? h('span', { class: 'small muted' }, b.features.join(', ')) : null)))),
    );
  };
  await load();
  return root;
}
