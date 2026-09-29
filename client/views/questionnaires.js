import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog } from '../lib/forms.js';

const dialog = (title, body, submitLabel, onSubmit) => formDialog(title, body, submitLabel, onSubmit, { wide: true });

// Questionnaires: asked for → the version used → done with the person → score and band →
// what it means → what was done → repeated when due.
const STATE_TONE = { REQUESTED: 'warn', COMPLETED: 'danger', INTERPRETED: 'ok', DECLINED: 'muted', CANCELLED: 'muted' };

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

const localInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function completeDialog(u, options, reload) {
  const inst = options.instruments.find((i) => i.code === u.code);
  const modes = Object.fromEntries(Object.entries(options.modes).filter(([k]) => inst.selfComplete || k !== 'SELF_COMPLETED'));
  const mode = select(modes, inst.selfComplete ? 'STAFF_ASKED' : 'OBSERVED');
  const total = h('b', {}, 'Score: 0');
  const chosen = {};
  const recount = () => {
    const n = inst.items.reduce((t, it) => t + (chosen[it.id] !== undefined ? it.options[chosen[it.id]].score : 0), 0);
    const answered = Object.keys(chosen).length;
    total.textContent = `Score so far: ${n} (${answered} of ${inst.items.length} answered)`;
  };
  const items = inst.items.map((it, n) => h('fieldset', { class: 'item' },
    h('legend', {}, `${n + 1}. ${it.text}`),
    it.options.map((o, k) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: `${u.id}-${it.id}`, value: String(k), onchange: () => { chosen[it.id] = k; recount(); } }),
      ` ${o.label}`, h('span', { class: 'muted small' }, ` (${o.score})`))),
  ));
  recount();
  dialog(inst.name, h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, `Version: ${inst.version} · ${inst.source}`),
    h('p', {}, h('i', {}, inst.preamble)),
    h('label', { class: 'field' }, 'How it was done', mode),
    ...items,
    total,
  ), 'Save answers', async () => {
    await post(`/api/work/questionnaires/${u.id}/complete`, { mode: mode.value, responses: chosen });
    toast('Saved. It now needs a clinician to interpret it.');
    reload();
  });
}

function interpretDialog(u, options, reload) {
  const inst = options.instruments.find((i) => i.code === u.code);
  const meaning = h('textarea', { placeholder: 'What the result means for this person, with what else you know' });
  const done = h('textarea', { placeholder: 'What was done because of it (needed for flagged or high results)' });
  const repeat = h('input', { type: 'number', min: 0, max: 365, step: 1, value: String(inst.repeatDays) });
  dialog(`Interpret ${u.code}: ${u.score} (${u.band})`, h('div', { class: 'stack' },
    u.flags.map((f) => h('p', { class: 'notice' }, f)),
    h('label', { class: 'field' }, 'What it means', meaning),
    h('label', { class: 'field' }, 'Action', done),
    h('label', { class: 'field' }, 'Repeat in days (0 for no repeat)', repeat),
  ), 'Save', async () => {
    await post(`/api/work/questionnaires/${u.id}/interpret`, { interpretation: meaning.value, action: done.value, repeatDays: Number(repeat.value) });
    toast('Interpreted.');
    reload();
  });
}

async function close(u, action, reload) {
  const note = await ask({
    title: action === 'decline' ? `${u.code}: they declined` : `Cancel ${u.code}`,
    label: action === 'decline' ? 'What they said' : 'Why it is no longer needed', confirm: action === 'decline' ? 'Declined' : 'Cancel it', multiline: true, minLength: 3,
  });
  if (!note) return;
  try {
    await post(`/api/work/questionnaires/${u.id}/${action}`, { note });
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { complete: ['Do it now', true], interpret: ['Interpret', true], decline: ['They declined', false], cancel: ['Cancel', false] };

export function useCard(u, options, reload, showPatient) {
  const scored = u.score !== null && u.score !== undefined;
  return h('div', { class: `tile stack instrument${u.flags.length ? ' instrument-flag' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${u.personId}/instruments`) }, h('b', {}, u.patient)) : null,
        h('div', {}, h('b', {}, u.name)),
        h('div', { class: 'small muted' }, [showPatient ? u.location : null, u.reason].filter(Boolean).join(' · '))),
      h('div', { class: 'row' }, u.overdue ? h('span', { class: 'tag danger' }, 'Overdue') : null, h('span', { class: `tag ${STATE_TONE[u.state] ?? ''}` }, u.stateLabel)),
    ),
    u.state === 'REQUESTED' ? h('div', { class: 'small' }, `Due ${fmtDateTime(u.dueAt)} · asked for by ${u.requestedBy}`) : null,
    scored ? h('div', { class: 'score-line' },
      h('span', { class: 'score' }, `${u.score}`, h('span', { class: 'small muted' }, ` / ${u.maxScore}`)),
      u.band ? h('span', { class: `tag ${u.tone ?? ''}` }, u.band) : null,
      u.previous ? h('span', { class: 'small muted' }, `Last time ${u.previous.score} (${fmtDate(u.previous.at)})`) : null) : null,
    u.flags.map((f) => h('div', { class: 'small notice' }, f)),
    u.interpretation ? h('div', { class: 'small' }, h('b', {}, `${u.interpretedBy}: `), u.interpretation) : null,
    u.action ? h('div', { class: 'small' }, h('b', {}, 'Action: '), u.action) : null,
    u.nextId ? h('div', { class: 'small muted' }, 'Repeat booked.') : null,
    u.closedReason ? h('div', { class: 'small' }, h('b', {}, `${u.stateLabel}: `), u.closedReason) : null,
    u.answers.length ? h('details', {}, h('summary', { class: 'small' }, 'Answers'), h('ol', { class: 'small' }, u.answers.map((a) =>
      h('li', {}, `${a.text}: `, h('b', {}, a.answer), ` (${a.score})`)))) : null,
    h('div', { class: 'small muted' }, [
      `Version: ${u.version}`, u.administeredBy ? `done by ${u.administeredBy} ${fmtDateTime(u.administeredAt)} (${u.modeLabel})` : null,
    ].filter(Boolean).join(' · ')),
    u.actions.length ? h('div', { class: 'row' }, u.actions.map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => {
        if (a === 'complete') return completeDialog(u, options, reload);
        if (a === 'interpret') return interpretDialog(u, options, reload);
        return close(u, a, reload);
      } }, ACTION[a][0]))) : null,
  );
}

function requestForm(personId, d, reload) {
  const code = select(Object.fromEntries(d.options.instruments.map((i) => [i.code, `${i.name}: ${i.purpose}`])), d.options.instruments[0]?.code);
  const reason = h('input', { type: 'text', placeholder: 'Why, e.g. low mood since admission' });
  const due = h('input', { type: 'datetime-local', value: localInput(new Date()) });
  const licence = h('p', { class: 'small muted' });
  const sync = () => { const i = d.options.instruments.find((x) => x.code === code.value); licence.textContent = `${i.version}. ${i.licence} Text to be checked against the publisher's current version (RR-INSTR-001).`; };
  code.addEventListener('change', sync);
  sync();
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/questionnaires`, { code: code.value, reason: reason.value, dueAt: due.value ? new Date(due.value).toISOString() : '' });
      toast('Added. It shows as due.');
      reload();
    } catch (err) { showError(err); }
  } },
    h('h3', {}, 'Use a questionnaire'),
    h('label', { class: 'field' }, 'Questionnaire', code), licence,
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Why', reason), h('label', { class: 'field' }, 'Due', due)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
  );
}

// The person's Questionnaires view in the Live Workstation.
export function questionnairesPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const byCode = {};
  for (const u of [...d.done, ...d.open.filter((x) => x.state === 'COMPLETED')]) (byCode[u.code] ??= []).push(u);
  return h('div', { class: 'stack' },
    d.open.length ? d.open.map((u) => useCard(u, d.options, reload, false)) : h('div', { class: 'empty' }, `No questionnaires due for this ${subject}.`),
    d.canUse ? h('details', {}, h('summary', {}, 'Use a questionnaire'), requestForm(personId, d, reload)) : null,
    Object.keys(byCode).length ? h('section', { class: 'stack' }, h('h3', {}, 'Scores over time'),
      Object.entries(byCode).map(([code, list]) => h('div', { class: 'small' }, h('b', {}, `${code}: `),
        [...list].reverse().map((u) => `${u.score} (${fmtDate(u.administeredAt)})`).join(' → ')))) : null,
    d.done.length ? h('details', {}, h('summary', {}, `Interpreted (${d.done.length})`), h('div', { class: 'stack' }, d.done.map((u) => useCard(u, d.options, reload, false)))) : null,
    d.closed.length ? h('details', {}, h('summary', {}, `Declined or cancelled (${d.closed.length})`), h('div', { class: 'stack' }, d.closed.map((u) => useCard(u, d.options, reload, false)))) : null,
  );
}

// Home → Questionnaires.
export async function questionnairesView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/questionnaires');
    mount(root,
      workHeader(),
      pageTitle('Questionnaires', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Results to interpret (safety flags first), then questionnaires due in the next day.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `To interpret (${d.toInterpret.length})`),
        d.toInterpret.length ? d.toInterpret.map((u) => useCard(u, d.options, load, true)) : h('div', { class: 'card empty' }, 'Nothing to interpret.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Due (${d.due.length})`),
        d.due.length ? d.due.map((u) => useCard(u, d.options, load, true)) : h('div', { class: 'card empty' }, 'Nothing due.')),
    );
  };
  await load();
  return root;
}
