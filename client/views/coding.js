import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Clinical coding: an episode ends → it needs coding → the coder reads what was recorded and
// assigns codes, each pointing back to its source → checks → finalised → reopened with a reason.
const STATE_TONE = { REQUIRED: 'danger', IN_PROGRESS: 'warn', FINALISED: 'ok' };
const HISTORY = { REQUIRED: 'Needs coding', IN_PROGRESS: 'Being coded', FINALISED: 'Finalised' };
const QUERY_TONE = { OPEN: 'warn', ANSWERED: 'ok', WITHDRAWN: 'muted' };

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

const clip = (t, n = 110) => (t.length <= n ? t : `${t.slice(0, t.lastIndexOf(' ', n))}…`);
const stay = (c) => `${fmtDate(c.startedAt)} to ${fmtDate(c.endedAt)}`;

function codeLine(e, extra) {
  return h('div', { class: `code-line${e.role === 'PRINCIPAL' ? ' code-principal' : ''}` },
    h('span', { class: 'code' }, e.code),
    h('span', { class: 'grow' }, h('b', {}, e.term), h('div', { class: 'small muted' }, `${e.roleLabel} · ${e.systemLabel}`)),
    extra ?? null,
  );
}

function queryCard(q, actions) {
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' }, h('b', { class: 'small' }, `Asked by ${q.askedBy} ${fmtDateTime(q.askedAt)}`),
      h('span', { class: `tag ${QUERY_TONE[q.state] ?? ''}` }, q.state === 'OPEN' ? 'Waiting for an answer' : q.state === 'ANSWERED' ? 'Answered' : 'Withdrawn')),
    h('div', { class: 'small' }, q.question),
    q.answer ? h('div', { class: 'small summary' }, h('b', {}, q.answeredBy ? `${q.answeredBy}: ` : ''), q.answer) : null,
    actions ?? null,
  );
}

// Home → Clinical coding (coder).
export async function codingView() {
  const root = h('div');
  const d = await get('/api/work/coding');
  const row = (c) => h('button', { class: 'card stack coding-row', onclick: () => go(`/work/coding/${c.id}`) },
    h('div', { class: 'spread' }, h('b', {}, c.patient), h('span', { class: `tag ${STATE_TONE[c.state]}` }, c.stateLabel)),
    h('div', { class: 'small muted' }, [`NHI ${c.nhi ?? 'none'}`, c.service, c.location, stay(c)].filter(Boolean).join(' · ')),
    h('div', { class: 'row small' },
      h('span', {}, `${c.codes} ${c.codes === 1 ? 'code' : 'codes'}`),
      c.openQueries ? h('span', { class: 'tag warn' }, `${c.openQueries} question${c.openQueries === 1 ? '' : 's'} open`) : null,
      c.coder ? h('span', { class: 'muted' }, `Coder: ${c.coder}`) : null,
      c.amendments ? h('span', { class: 'muted' }, `Reopened ${c.amendments}×`) : null),
  );
  const section = (title, rows, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${rows.length})`),
    rows.length ? rows.map(row) : h('div', { class: 'card empty' }, empty));
  mount(root,
    workHeader(),
    pageTitle('Clinical coding', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Hospital episodes that have ended and need coding. You see what was recorded in the episode, not the rest of the record.'),
    section('To code', d.toCode, 'Nothing waiting to be coded.'),
    section('Being coded', d.inProgress, 'Nothing being coded.'),
    section('Finalised in the last fortnight', d.finalised, 'Nothing finalised recently.'),
  );
  return root;
}

// One episode, coded.
export async function codingCaseView(id) {
  const root = h('div');
  const run = async (action, body = {}) => {
    try {
      await post(`/api/work/coding/${id}/${action}`, body);
      return true;
    } catch (err) { showError(err); return false; }
  };
  const load = async () => {
    const c = await get(`/api/work/coding/${id}`);
    const coding = c.state === 'IN_PROGRESS';

    // Add-a-code form, which a source entry can fill in.
    const f = {
      role: select(c.options.roles, c.entries.some((e) => e.role === 'PRINCIPAL') ? 'ADDITIONAL' : 'PRINCIPAL'),
      system: select(c.options.systems, 'ICD10AM'),
      code: h('input', { type: 'text', placeholder: 'Code', autocapitalize: 'characters' }),
      term: h('input', { type: 'text', placeholder: 'What the code stands for' }),
      source: select({ '': 'Choose the entry it comes from…', ...Object.fromEntries(c.sources.map((s) => [s.id, `${fmtDateTime(s.at)} · ${s.text.slice(0, 70)}`])) }, ''),
      sourceNote: h('input', { type: 'text', placeholder: 'Or where in the record, e.g. "discharge summary"' }),
    };
    f.role.addEventListener('change', () => {
      if (f.role.value === 'PROCEDURE') f.system.value = 'ACHI';
      else if (f.system.value === 'ACHI') f.system.value = 'ICD10AM';
    });
    const addForm = h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      if (await run('add', { role: f.role.value, system: f.system.value, code: f.code.value, term: f.term.value, sourceEventId: f.source.value, sourceNote: f.sourceNote.value })) {
        toast('Code added.');
        load();
      }
    } },
      h('h3', {}, 'Add a code'),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'For', f.role), h('label', { class: 'field grow' }, 'Classification', f.system)),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Code', f.code), h('label', { class: 'field grow' }, 'Term', f.term)),
      h('label', { class: 'field' }, 'Comes from', f.source), f.sourceNote,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add code')),
    );
    const useSource = (s) => { f.source.value = s.id; f.term.focus(); addForm.scrollIntoView({ block: 'center' }); };

    const question = h('textarea', { placeholder: 'e.g. The notes say "chest pain, troponin rising". Was this confirmed as a myocardial infarction?' });
    const askForm = h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      if (await run('ask', { question: question.value })) { toast(`Asked ${c.service}.`); load(); }
    } }, h('label', { class: 'field' }, `Ask ${c.service}`, question), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Send question')));

    const remove = async (e) => {
      const note = await ask({ title: `Remove ${e.code}`, message: e.term, label: 'Why', confirm: 'Remove', minLength: 3 });
      if (note && await run('remove', { entryId: e.id, note })) { toast('Removed. It stays in the history.'); load(); }
    };
    const withdraw = async (q) => {
      const note = await ask({ title: 'Withdraw question', message: q.question, label: 'Why', confirm: 'Withdraw', minLength: 3 });
      if (note && await run('withdraw', { queryId: q.id, note })) load();
    };
    const top = async (action) => {
      if (action === 'amend') {
        const note = await ask({ title: 'Reopen this coding', label: 'Why it needs changing', confirm: 'Reopen', multiline: true, minLength: 5 });
        if (!note) return;
        if (await run('amend', { note })) { toast('Reopened. The earlier finalisation stays in the history.'); load(); }
        return;
      }
      if (await run(action)) { toast(action === 'start' ? 'Coding started.' : 'Finalised.'); load(); }
    };
    const TOP = { start: ['Start coding', true], finalise: ['Finalise', true], amend: ['Reopen', false] };

    mount(root,
      workHeader(),
      pageTitle(c.patient, () => go('/work/coding')),
      h('div', { class: 'card stack' },
        h('div', { class: 'spread' },
          h('div', {}, h('b', {}, `${c.service} · ${stay(c)}`),
            h('div', { class: 'small muted' }, [`NHI ${c.nhi ?? 'none'}`, c.location, c.requiredReason, c.discharge?.note].filter(Boolean).join(' · '))),
          h('span', { class: `tag ${STATE_TONE[c.state]}` }, c.stateLabel)),
        c.finalisedBy ? h('div', { class: 'small' }, `Finalised by ${c.finalisedBy} ${fmtDateTime(c.finalisedAt)}`) : null,
        h('div', { class: 'row' }, c.actions.filter((a) => TOP[a]).map((a) =>
          h('button', { class: `btn${TOP[a][1] ? ' primary' : ''}`, onclick: () => top(a) }, TOP[a][0]))),
      ),
      h('div', { class: 'coding-grid' },
        h('section', { class: 'stack' },
          h('h2', { class: 'section-title paua' }, `What was recorded (${c.sources.length})`),
          c.sources.length ? c.sources.map((s) => h('div', { class: 'tile stack source' },
            h('div', { class: 'small muted' }, `${fmtDateTime(s.at)} · ${s.author ?? ''}`),
            h('div', { class: 'small' }, s.text),
            coding ? h('div', {}, h('button', { class: 'btn small', onclick: () => useSource(s) }, 'Code from this')) : null))
            : h('div', { class: 'card empty' }, 'Nothing was recorded in this episode.'),
        ),
        h('section', { class: 'stack' },
          h('h2', { class: 'section-title paua' }, `Codes (${c.entries.length})`),
          c.entries.length ? h('div', { class: 'tile stack' }, c.entries.map((e) => h('div', { class: 'stack' },
            codeLine(e, coding ? h('button', { class: 'btn small', onclick: () => remove(e) }, 'Remove') : null),
            h('div', { class: 'small muted' }, `From: ${e.sourceText ? clip(e.sourceText) : e.sourceNote} · added by ${e.addedBy}`)))) : h('div', { class: 'card empty' }, 'No codes yet.'),
          coding ? addForm : null,
          c.state !== 'REQUIRED' ? h('div', { class: `tile stack ${c.validation.ok ? 'checks-ok' : 'checks-bad'}` },
            h('b', {}, c.state === 'FINALISED' ? 'Checks' : c.validation.ok ? 'Ready to finalise' : 'Not ready to finalise'),
            c.validation.problems.length ? h('ul', { class: 'small' }, c.validation.problems.map((p) => h('li', {}, p))) : null,
            h('div', { class: 'small muted' }, c.validation.note)) : null,
          h('h2', { class: 'section-title paua' }, `Questions (${c.queries.length})`),
          c.queries.map((q) => queryCard(q, q.state === 'OPEN' && coding ? h('div', {}, h('button', { class: 'btn small', onclick: () => withdraw(q) }, 'Withdraw')) : null)),
          coding ? askForm : null,
          c.removed.length ? h('details', {}, h('summary', {}, `Removed codes (${c.removed.length})`),
            h('div', { class: 'tile stack' }, c.removed.map((e) => h('div', { class: 'stack' }, codeLine(e),
              h('div', { class: 'small muted' }, `Removed by ${e.removedBy} ${fmtDateTime(e.removedAt)}: ${e.removedReason}`))))) : null,
          h('details', {}, h('summary', {}, 'History'), h('ul', { class: 'small' }, c.history.map((x) =>
            h('li', {}, `${fmtDateTime(x.at)} · ${HISTORY[x.to_state] ?? x.to_state} · ${x.actor ?? ''}${x.reason ? `: ${x.reason}` : ''}`)))),
        ),
      ),
    );
  };
  await load();
  return root;
}

function answerForm(q, reload) {
  const a = h('textarea', { placeholder: 'Your answer, from the record and your knowledge of the episode' });
  return h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/coding/queries/${q.id}/answer`, { answer: a.value });
      toast('Answered. The coder will see it.');
      reload();
    } catch (err) { showError(err); }
  } }, h('label', { class: 'field' }, 'Answer', a), h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send answer')));
}

// Home → Coding questions (doctors).
export async function codingQueriesView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/coding/queries');
    const card = (q, open) => h('div', { class: 'card stack' },
      h('div', { class: 'spread' },
        h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${q.personId}/coding`) }, h('b', {}, q.patient)),
        h('span', { class: 'small muted' }, `Stay ${stay(q)}`)),
      q.codes.length ? h('div', { class: 'stack' }, q.codes.map((e) => codeLine(e))) : null,
      queryCard(q, open ? answerForm(q, load) : null));
    mount(root,
      workHeader(),
      pageTitle('Coding questions', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Coders ask when the record does not say clearly what was diagnosed or done. Answer from what happened in the episode.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `To answer (${d.open.length})`),
        d.open.length ? d.open.map((q) => card(q, true)) : h('div', { class: 'card empty' }, 'No questions waiting.')),
      d.answered.length ? h('details', {}, h('summary', {}, `Answered this week (${d.answered.length})`), h('div', { class: 'stack' }, d.answered.map((q) => card(q, false)))) : null,
    );
  };
  await load();
  return root;
}

// The person's Coding view in the Live Workstation.
export function codingPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, d.note),
    d.cases.length ? d.cases.map((c) => h('div', { class: 'tile stack' },
      h('div', { class: 'spread' }, h('b', {}, `${c.service} · ${stay(c)}`), h('span', { class: `tag ${STATE_TONE[c.state]}` }, c.stateLabel)),
      c.entries.length ? h('div', { class: 'stack' }, c.entries.map((e) => codeLine(e))) : h('div', { class: 'small muted' }, 'Not coded yet.'),
      c.finalisedBy ? h('div', { class: 'small muted' }, `Finalised by ${c.finalisedBy} ${fmtDateTime(c.finalisedAt)}`) : null,
      c.queries.map((q) => queryCard(q, q.state === 'OPEN' && d.canAnswer && q.serviceId === d.serviceId ? answerForm(q, reload) : null)),
    )) : h('div', { class: 'empty' }, 'No hospital episodes have needed coding yet.'),
  );
}
