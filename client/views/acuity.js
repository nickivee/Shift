import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Clinical status: evidence → a clinician's assessment → what it means → look again → changed status.
const CHANGE_TONE = { WORSE: 'danger', BETTER: 'ok', SAME: 'muted', FIRST: 'muted' };

function evidenceList(e) {
  if (!e) return null;
  const rows = [
    e.obs ? ['Latest observations', `${e.obs.text} (${fmtDateTime(e.obs.at)})`] : ['Latest observations', 'None in the last 24 hours'],
    e.different.length ? ['Different from usual', e.different.join(' · ')] : null,
    e.escalations.length ? ['Open escalations', e.escalations.join(' · ')] : null,
    e.help.length ? ['Help needed', e.help.join(' · ')] : null,
    e.alerts.length ? ['Alerts', e.alerts.join(' · ')] : null,
  ].filter(Boolean);
  return h('dl', { class: 'acuity-evidence' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function assessDialog(personId, d, reload) {
  const error = h('p', { class: 'small notice', hidden: true });
  let level = '';
  const choices = h('div', { class: 'stack acuity-levels' }, d.levels.map((l) => h('label', { class: `acuity-choice acuity-${l.id.toLowerCase()}` },
    h('input', { type: 'radio', name: 'acuity-level', value: l.id, onchange: () => { level = l.id; } }),
    h('span', {}, h('b', {}, l.label), h('span', { class: 'small muted' }, ` Look again within ${l.reviewHours === 1 ? 'the hour' : `${l.reviewHours} hours`}.`)))));
  const basis = h('textarea', { placeholder: 'e.g. Resp rate up to 24 from 16, more confused than this morning, not drinking' });
  const dlg = h('dialog', {},
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/acuity`, { level, basis: basis.value });
        dlg.close(); dlg.remove(); toast('Status recorded.'); reload();
      } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; }
    } },
      h('h2', {}, d.current ? 'Reassess clinical status' : 'Record clinical status'),
      h('details', { open: true }, h('summary', {}, 'What SHIFT holds now'), evidenceList(d.evidence)),
      h('fieldset', { class: 'stack' }, h('legend', {}, 'How are they?'), choices),
      h('label', { class: 'field' }, 'What you are basing this on', basis),
      h('p', { class: 'small muted' }, 'This is your clinical judgement. SHIFT does not calculate a score.'),
      error,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Record'),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function statusTile(a, d, reload) {
  return h('div', { class: `tile stack acuity-now acuity-${a.level.toLowerCase()}${a.overdue ? ' acuity-overdue' : ''}` },
    h('div', { class: 'spread' }, h('h3', {}, a.label),
      h('span', { class: `tag ${CHANGE_TONE[a.change]}` }, a.changeLabel)),
    h('div', { class: 'small muted' }, `${a.assessedBy} ${fmtDateTime(a.assessedAt)}`),
    h('div', {}, a.basis),
    h('div', { class: a.overdue ? 'notice small' : 'small' }, a.overdue ? `Overdue for a look: was due ${fmtDateTime(a.reviewDue)}.` : `Look again by ${fmtDateTime(a.reviewDue)}.`),
    h('div', { class: 'acuity-implication' }, h('b', {}, 'What this means: '), a.implication),
    a.escalate ? (d.escalationOpen
      ? h('div', { class: 'small' }, 'An escalation is open for them.')
      : h('div', { class: 'row' }, h('span', { class: 'small alloc-warn' }, 'No escalation is open for them.'),
        d.canEscalate ? h('button', { class: 'btn small', onclick: () => go(`/work/patient/${a.personId}/escalations`) }, 'Go to escalations') : null)) : null,
    a.evidence ? h('details', {}, h('summary', {}, 'Evidence SHIFT held at the time'), evidenceList(a.evidence)) : null,
    a.actions.includes('error') ? h('div', {}, h('button', { class: 'btn small', onclick: async () => {
      const reason = await ask({ title: 'Entered in error', label: 'What was wrong', confirm: 'Mark as entered in error', multiline: true, minLength: 5 });
      if (!reason) return;
      try { await post(`/api/work/acuity/${a.id}/error`, { reason }); reload(); } catch (err) { showError(err); }
    } }, 'Entered in error')) : null,
  );
}

// The person's Clinical status view in the Live Workstation.
export function acuityPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.current ? statusTile(d.current, d, reload) : h('div', { class: 'card empty' }, 'No clinical status recorded.'),
    d.canAssess ? h('div', {}, h('button', { class: 'btn primary', onclick: () => assessDialog(personId, d, reload) }, d.current ? 'Reassess' : 'Record status')) : null,
    h('p', { class: 'small muted' }, `SHIFT does not calculate an early-warning or acuity score: ${d.calculation.reason?.toLowerCase() ?? 'not available'} (${d.calculation.refs.join(', ')}).`),
    d.earlier.length ? h('details', {}, h('summary', {}, `Earlier (${d.earlier.length})`), h('div', { class: 'stack' }, d.earlier.map((a) =>
      h('div', { class: 'tile small stack' },
        h('div', { class: 'spread' }, h('b', {}, a.label), h('span', { class: 'tag muted' }, a.state === 'ENTERED_IN_ERROR' ? 'Entered in error' : a.changeLabel)),
        h('div', { class: 'muted' }, `${a.assessedBy} ${fmtDateTime(a.assessedAt)}: ${a.basis}`),
        a.errorReason ? h('div', { class: 'muted' }, `Entered in error: ${a.errorReason}`) : null)))) : null,
  );
}

function row(x) {
  const s = x.status;
  return h('div', { class: `tile stack${s ? ` acuity-${s.level.toLowerCase()}` : ''}${s?.overdue ? ' acuity-overdue' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/acuity`) }, h('b', {}, x.patient)),
        x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null),
      s ? h('span', { class: `tag ${s.tone}` }, s.short) : h('span', { class: 'tag muted' }, 'Not recorded')),
    s ? h('div', { class: 'small' }, `${s.changeLabel} · ${s.assessedBy} ${fmtDateTime(s.assessedAt)} · ${s.overdue ? `overdue since ${fmtDateTime(s.reviewDue)}` : `look again by ${fmtDateTime(s.reviewDue)}`}`) : null,
    s?.escalate && !x.escalationOpen ? h('div', { class: 'small alloc-warn' }, 'No escalation open') : null,
  );
}

// Home → Clinical status.
export async function acuityView() {
  const d = await get('/api/work/acuity');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Clinical status', () => go('/work/home')),
    h('div', { class: 'banner' }, 'How unwell each person in your service is, in the words of the clinician who last looked, and who is due for another look.'),
    h('div', { class: 'chips' }, d.counts.map((c) => h('span', { class: `tag ${c.count ? c.tone : 'muted'}` }, `${c.short}: ${c.count}`))),
    section('Unwell', d.unwell, 'No one is recorded as unwell.'),
    section('Overdue for a look', d.overdue, 'None overdue.'),
    section('Not yet recorded', d.none, 'Everyone has a status.'),
    section('Everyone else', d.others, 'No one else.'),
  );
}

