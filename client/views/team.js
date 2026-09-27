import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Care team: named clinicians and teams. Required → proposed → confirmed → active → covered or
// handed over → ended.
const TONE = { PROPOSED: 'warn', CONFIRMED: 'warn', ACTIVE: 'ok', ENDED: 'muted', DECLINED: 'muted' };

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

const localInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const peopleSelect = (people, exclude) => h('select', {}, h('option', { value: '' }, 'Choose…'),
  people.filter((p) => p.id !== exclude).map((p) => h('option', { value: p.id }, `${p.name} (${p.title})`)));

function proposeDialog(personId, d, k, reload, replacing) {
  const people = d.options.people[k.kind] ?? [];
  const who = k.named === 'WORKER' ? peopleSelect(people, replacing?.assigneeId) : null;
  const extName = h('input', { type: 'text', placeholder: k.named === 'TEAM' ? 'e.g. General Medicine Team B' : 'e.g. Dr Anna Whyte' });
  const extOrg = h('input', { type: 'text', placeholder: 'e.g. Cornwall Medical Centre' });
  const reason = h('input', { type: 'text', placeholder: replacing ? 'Why it is changing' : 'Optional' });
  const starts = h('input', { type: 'datetime-local', value: localInput(new Date()) });
  dialog(replacing ? `Hand over: ${k.label.toLowerCase()}` : `Name the ${k.label.toLowerCase()}`, h('div', { class: 'stack' },
    replacing ? h('p', { class: 'small muted' }, `Now: ${replacing.name}. They stay until the new one starts.`) : null,
    who ? h('label', { class: 'field' }, 'Who', who) : null,
    who && !people.length ? h('p', { class: 'small notice' }, 'No one with the right role and a current practising certificate is available.') : null,
    k.named === 'EXTERNAL' ? h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Name', extName), h('label', { class: 'field grow' }, 'Practice', extOrg)) : null,
    k.named === 'TEAM' ? h('label', { class: 'field' }, 'Team', extName) : null,
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Reason', reason), h('label', { class: 'field' }, 'Starts', starts)),
    h('p', { class: 'small muted' }, k.named === 'WORKER' ? 'It needs confirming by them or a senior clinician, unless you are naming yourself.' : 'It needs confirming by a senior clinician.'),
  ), replacing ? 'Propose handover' : 'Propose', async () => {
    await post(`/api/work/patients/${personId}/team`, {
      kind: k.kind, assigneeId: who?.value ?? '', externalName: k.named === 'EXTERNAL' ? extName.value : '', externalOrg: extOrg.value,
      teamName: k.named === 'TEAM' ? extName.value : '', reason: reason.value, startsAt: starts.value ? new Date(starts.value).toISOString() : '', replaces: replacing?.id ?? '',
    });
    toast('Proposed.');
    reload();
  });
}

function coverDialog(a, d, k, reload) {
  const people = d.options?.people?.[k.kind] ?? [];
  const who = k.named === 'WORKER' ? peopleSelect(people, a.assigneeId) : h('input', { type: 'text', placeholder: 'Who is covering' });
  const until = h('input', { type: 'datetime-local', value: localInput(new Date(Date.now() + 3 * 24 * 3600_000)) });
  const note = h('input', { type: 'text', placeholder: 'e.g. Annual leave' });
  dialog(`Cover for ${a.name}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Covering', who),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Why', note), h('label', { class: 'field' }, 'Until', until)),
  ), 'Arrange cover', async () => {
    await post(`/api/work/team/${a.id}/cover`, {
      coverId: k.named === 'WORKER' ? who.value : '', coverName: k.named === 'WORKER' ? '' : who.value, until: until.value ? new Date(until.value).toISOString() : '', note: note.value,
    });
    toast('Cover arranged.');
    reload();
  });
}

async function simple(a, action, reload) {
  const labels = {
    confirm: [a.mine ? 'Accept' : `Confirm ${a.name}`, a.mine ? 'Anything to add (optional)' : 'How they agreed, e.g. at the board round', a.mine ? 'Accept' : 'Confirm', a.mine ? 0 : 3],
    decline: [`Decline: ${a.name}`, 'Why', 'Decline', 3],
    end: [`End: ${a.name}`, 'Why it is ending', 'End it', 3],
  }[action];
  const note = await ask({ title: labels[0], label: labels[1], confirm: labels[2], multiline: true, minLength: labels[3] });
  if (note === null || note === undefined || (labels[3] && !note)) return;
  try {
    await post(`/api/work/team/${a.id}/${action}`, { note });
    reload();
  } catch (err) { showError(err); }
}

const LABELS = { confirm: 'Confirm', decline: 'Decline', cover: 'Arrange cover', handover: 'Hand over', end: 'End' };

function line(a, d, k, reload, prefix) {
  if (!a) return null;
  return h('div', { class: `stack assignment assignment-${a.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, prefix ? h('span', { class: 'small muted' }, `${prefix} `) : null, h('b', {}, a.name)),
      h('span', { class: `tag ${TONE[a.state]}` }, a.state === 'PROPOSED' && a.mine ? 'Waiting for you' : a.stateLabel)),
    h('div', { class: 'small muted' }, [
      a.state === 'PROPOSED' ? `Proposed by ${a.proposedBy} ${fmtDateTime(a.proposedAt)}` : null,
      a.state === 'CONFIRMED' ? `Confirmed by ${a.confirmedBy}; starts ${fmtDateTime(a.startsAt)}` : null,
      a.state === 'ACTIVE' && a.activatedAt ? `Since ${fmtDate(a.activatedAt)}` : null,
      a.state === 'ACTIVE' && a.confirmedBy && a.confirmNote ? `${a.confirmedBy}: ${a.confirmNote}` : null,
      a.endsAt && a.state === 'ACTIVE' ? `until ${fmtDateTime(a.endsAt)}` : null,
      a.reason ? a.reason : null,
    ].filter(Boolean).join(' · ')),
    a.actions.length ? h('div', { class: 'row' }, a.actions.map((x) => h('button', { class: `btn small${x === 'confirm' ? ' primary' : ''}`, onclick: () => {
      if (x === 'cover') return coverDialog(a, d, k, reload);
      if (x === 'handover') return proposeDialog(a.personId, d, k, reload, a);
      return simple(a, x, reload);
    } }, x === 'confirm' && a.mine ? 'Accept' : LABELS[x]))) : null,
  );
}

// The person's Care team view in the Live Workstation.
export function teamPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.required.length ? h('div', { class: 'notice' }, `Required and not yet named: ${d.required.join(', ').toLowerCase()}.`) : null,
    d.kinds.map((k) => {
      const any = k.active || k.upcoming || k.proposed;
      const missing = d.required.includes(k.label);
      return h('div', { class: `tile stack team-kind${missing ? ' team-missing' : ''}` },
        h('div', { class: 'spread' }, h('h3', {}, k.label),
          d.canPropose && !k.active && !k.upcoming && !k.proposed ? h('button', { class: 'btn small', onclick: () => proposeDialog(personId, d, k, reload) }, 'Name someone') : null),
        !any ? h('div', { class: 'muted small' }, missing ? `Required for this ${subject}. No one named yet.` : 'No one named.') : null,
        line(k.active, d, k, reload),
        line(k.cover, d, k, reload, 'Covered by'),
        line(k.upcoming, d, k, reload, 'Next:'),
        line(k.proposed, d, k, reload, k.active ? 'Handing over to' : null),
      );
    }),
    d.past.length ? h('details', {}, h('summary', {}, `Earlier (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((a) =>
      h('div', { class: 'tile small stack' },
        h('div', { class: 'spread' }, h('b', {}, `${a.label}: ${a.name}`), h('span', { class: 'tag muted' }, a.stateLabel)),
        h('div', { class: 'muted' }, a.state === 'ENDED'
          ? `${a.activatedAt ? fmtDate(a.activatedAt) : fmtDate(a.proposedAt)} to ${fmtDate(a.endedAt)}${a.endedBy ? ` · ended by ${a.endedBy}` : ''}: ${a.endReason}`
          : `Declined by ${a.declinedBy} ${fmtDate(a.declinedAt)}: ${a.declineReason}`))))) : null,
  );
}

function personLine(a, reload, d) {
  const k = { kind: a.kind, label: a.label, named: a.externalName ? 'EXTERNAL' : a.teamName ? 'TEAM' : 'WORKER' };
  return h('div', { class: 'tile stack' },
    h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${a.personId}/team`) }, h('b', {}, a.patient)),
      a.location ? h('span', { class: 'small muted' }, ` · ${a.location}`) : null),
    h('div', { class: 'small' }, h('b', {}, `${a.label}: `), a.name),
    line(a, d, k, reload));
}

// Home → Care team.
export async function teamView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/team');
    const section = (title, list, empty, render) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
      list.length ? list.map(render) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Care team', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Who is named for each person: proposals for you to accept, proposals to confirm, people missing a required name, and covers ending soon.'),
      section('Waiting for you', d.forMe, 'Nothing waiting for you.', (a) => personLine(a, load, d)),
      section('To confirm', d.toConfirm, 'Nothing to confirm.', (a) => personLine(a, load, d)),
      section('Missing a required name', d.missing, 'Everyone has the names they need.', (m) => h('div', { class: 'tile stack team-missing' },
        h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${m.personId}/team`) }, h('b', {}, m.patient)),
          m.location ? h('span', { class: 'small muted' }, ` · ${m.location}`) : null),
        h('div', { class: 'small' }, `Needs: ${m.missing.join(', ').toLowerCase()}`))),
      section('Cover ending in the next day', d.endingSoon, 'None.', (a) => personLine(a, load, d)),
      d.waiting.length ? section('Waiting on someone else', d.waiting, '', (a) => personLine(a, load, d)) : null,
    );
  };
  await load();
  return root;
}
