import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime, stateTag } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { dialog, field, select } from '../lib/forms.js';

// Tasks: responsibility is taken on explicitly (Accept), never by routing or by viewing.
// Work queue: missed work goes one step up the service's ladder, and the next person
// acknowledges it and records what they did.
const ESC_TONE = { OPEN: 'danger', ACKNOWLEDGED: 'warn', RESOLVED: 'ok', SUPERSEDED: '' };
function escalationCard(e, reload) {
  const post2 = (action, body = {}) => post(`/api/work/queue/${e.id}/${action}`, body);
  const withNote = (title, label, placeholder, extra, submit, send) => dialog(title, (run, close) => {
    const note = h('textarea', { 'aria-label': label, placeholder });
    return h('div', { class: 'stack' }, h('p', { class: 'small' }, `${e.patient} · ${e.description}`), extra, field(label, note),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => { await send(note.value); close(); toast('Saved.'); reload(); }) }, submit)));
  });
  const handlers = {
    acknowledge: () => post2('acknowledge').then(() => { toast('Acknowledged.'); reload(); }, showError),
    take: () => withNote('Take it over', 'Note (optional)', 'e.g. Doing it now', null, 'Take it over', (note) => post2('take', { note })),
    extend: () => {
      const mins = select(e.extendOptions.map((m) => [String(m), m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`]), 'How much more time', null);
      return withNote('Give it more time', 'Why it can wait', 'e.g. Resident asleep; do at 3 pm', field('How much more time', mins), 'Give more time', (note) => post2('extend', { note, minutes: Number(mins.value) }));
    },
    note: () => withNote('What you are doing about it', 'What you are doing', 'e.g. Asked Tama; he is on his way now', null, 'Save', (note) => post2('note', { note })),
  };
  const LABEL = { acknowledge: 'Acknowledge', take: 'Take it over', extend: 'Give more time', note: 'Add what I am doing' };
  return h('div', { class: `card stack esc esc-${e.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('b', {}, e.description), h('span', { class: `tag ${ESC_TONE[e.state] ?? ''}` }, e.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, `${e.reasonLabel}. `), `Due ${e.dueAt ?? ''} · held by ${e.holder}`),
    h('div', { class: 'small muted' }, [e.patient, e.location, `escalated to ${e.toRoleLabel} ${fmtDateTime(e.escalatedAt)}`].filter(Boolean).join(' · ')),
    e.actionNote ? h('div', { class: 'small' }, h('b', {}, `${e.actionBy}: `), e.actionNote) : null,
    e.resolution ? h('div', { class: 'small' }, h('b', {}, 'Resolved: '), e.resolution) : null,
    e.actions.length ? h('div', { class: 'row' }, e.actions.map((a) => h('button', { class: `btn small${a === 'acknowledge' || a === 'take' ? ' primary' : ''}`, onclick: handlers[a] }, LABEL[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${e.log.length})`),
      h('ol', { class: 'det-steps' }, e.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kind.charAt(0) + s.kind.slice(1).toLowerCase()), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

export async function tasksView() {
  const root = h('div');
  const load = async () => {
    let [tasks, q] = await Promise.all([get('/api/work/tasks'), get('/api/work/queue')]);
    const escalated = q.toMe.filter((e) => ['OPEN', 'ACKNOWLEDGED'].includes(e.state));
    const settled = q.toMe.filter((e) => !['OPEN', 'ACKNOWLEDGED'].includes(e.state));
    const act = async (t, action, prompt) => {
      let note;
      if (prompt) {
        note = await ask(prompt);
        if (note === null) return;
      }
      try { await post(`/api/work/tasks/${t.id}/${action}`, { note }); toast('Task updated.'); load(); } catch (err) { showError(err); }
    };
    const actions = (t) => {
      const out = [];
      if (['CREATED', 'ASSIGNED'].includes(t.state)) out.push(h('button', { class: 'btn small primary', onclick: () => act(t, 'accept') }, 'Accept'));
      if (t.state === 'ACCEPTED' && t.mine) out.push(h('button', { class: 'btn small', onclick: () => act(t, 'start') }, 'Start'));
      if (['ACCEPTED', 'IN_PROGRESS'].includes(t.state) && t.mine) out.push(h('button', { class: 'btn small primary', onclick: () => act(t, 'complete', { title: 'Complete task', label: 'Outcome', minLength: 2, confirm: 'Complete' }) }, 'Complete'));
      if (t.state === 'COMPLETED') out.push(h('button', { class: 'btn small', onclick: () => act(t, 'close') }, 'Close'));
      if (!['COMPLETED', 'CLOSED', 'CANCELLED'].includes(t.state)) out.push(h('button', { class: 'btn small danger', onclick: () => act(t, 'cancel', { title: 'Cancel task', label: 'Reason', minLength: 2, confirm: 'Cancel task' }) }, 'Cancel'));
      return out;
    };
    mount(root,
      workHeader(),
      pageTitle('Tasks', () => go('/work/home')),
      q.ladder.length ? h('div', { class: 'banner' }, `Work not accepted or not done in time goes one step up: ${q.ladder.join(' → ')}. The next person acknowledges it and records what they did.`) : null,
      escalated.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Escalated to you (${escalated.length})`), escalated.map((e) => escalationCard(e, load))) : null,
      (tasks = tasks.filter((t) => !escalated.some((e) => e.taskId === t.id))).length ? h('div', { class: 'list' }, tasks.map((t) => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('b', {}, t.description), stateTag(t.state)),
        q.onTasks[t.id] ? h('div', { class: 'small notice' }, `${q.onTasks[t.id].reasonLabel}: escalated to ${q.onTasks[t.id].toRoleLabel} ${fmtDateTime(q.onTasks[t.id].escalatedAt)}`) : null,
        h('div', { class: 'small muted' }, [t.patient, t.location, t.dueAt ? `Due ${t.dueAt}` : null, `Assigned: ${t.assignedTo}`, `From ${t.createdBy}`].filter(Boolean).join(' · ')),
        t.outcome ? h('div', { class: 'small' }, `Outcome: ${t.outcome}`) : null,
        h('div', { class: 'row' }, actions(t), h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${t.personId}/tasks`) }, 'Open record')),
      ))) : h('div', { class: 'card empty' }, 'No outstanding tasks.'),
      settled.length ? h('details', { class: 'tile' }, h('summary', {}, `Escalations resolved in the last 12 hours (${settled.length})`), h('div', { class: 'stack' }, settled.map((e) => escalationCard(e, load)))) : null,
    );
  };
  await load();
  return root;
}

// Received: routed items. Delivered is not received; received is not reviewed; reviewed is
// not accepted or actioned. Each step is a separate, recorded act.
export async function receivedView() {
  const root = h('div');
  const load = async () => {
    const items = await get('/api/work/received');
    const act = async (r, action) => {
      try { await post(`/api/work/routes/${r.id}/${action}`); toast('Updated.'); load(); } catch (err) { showError(err); }
    };
    const next = (r) => ({
      DELIVERED: [['receive', 'Mark received']],
      RECEIVED: [['review', 'Mark reviewed']],
      REVIEWED: r.requiresAcceptance ? [['accept', 'Accept']] : [['action', 'Mark actioned']],
      ACCEPTED: [['action', 'Mark actioned']],
    }[r.state] ?? []);
    mount(root,
      workHeader(),
      pageTitle('Received', () => go('/work/home')),
      items.length ? h('div', { class: 'list' }, items.map((r) => h('div', { class: `card stack${r.urgent ? ' urgent' : ''}` },
        h('div', { class: 'spread' }, h('b', {}, r.patient), h('span', { class: 'row' }, r.urgent ? h('span', { class: 'tag danger' }, 'Urgent') : null, stateTag(r.state))),
        h('div', { class: r.enteredInError ? 'muted' : '' }, r.text),
        r.amended ? h('span', { class: 'tag warn' }, 'Amended since it was sent; showing the current version') : null,
        r.enteredInError ? h('span', { class: 'tag danger' }, 'Marked entered in error after it was sent') : null,
        h('div', { class: 'small muted' }, `From ${r.sender} (${r.senderRole}) to ${r.destination} · ${fmtDateTime(r.createdAt)}${r.requiresAcceptance ? ' · needs explicit acceptance' : ''}`),
        h('div', { class: 'row' },
          next(r).map(([a, label], i) => h('button', { class: `btn small${i === 0 ? ' primary' : ''}`, onclick: () => act(r, a) }, label)),
          h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${r.personId}/history`) }, 'Open record'),
        ),
      ))) : h('div', { class: 'card empty' }, 'Nothing has been routed to you.'),
    );
  };
  await load();
  return root;
}

// Handover: explicitly marked entries, shown from the canonical record.
export async function handoverView() {
  const root = h('div');
  const load = async () => {
    const groups = await get('/api/work/handover');
    const act = async (item, action) => {
      try { await post(`/api/work/handover/${item.markId}/${action}`); load(); } catch (err) { showError(err); }
    };
    mount(root,
      workHeader(),
      pageTitle('Handover', () => go('/work/home')),
      groups.length ? h('div', { class: 'list' }, groups.map((g) => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('h3', {}, g.patient, g.location ? ` · ${g.location}` : ''), h('button', { class: 'btn small', onclick: () => go(`/work/patient/${g.personId}/handover`) }, 'Open record')),
        g.items.map((i) => h('div', { class: `entry-item${i.urgent ? ' urgent' : ''}` },
          h('div', { class: 'text' }, i.text),
          h('div', { class: 'meta' }, `${fmtDateTime(i.effectiveAt)} · marked by ${i.markedBy}`),
          h('div', { class: 'entry-actions' },
            i.myReceipt ? h('span', { class: 'tag ok' }, i.myReceipt === 'REVIEWED' ? 'You reviewed this' : 'You received this') : null,
            !i.myReceipt ? h('button', { class: 'btn small primary', onclick: () => act(i, 'receive') }, 'Received') : null,
            i.myReceipt !== 'REVIEWED' ? h('button', { class: 'btn small', onclick: () => act(i, 'review') }, 'Reviewed') : null,
            h('button', { class: 'btn small', onclick: () => act(i, 'clear') }, 'Clear from handover'),
          ),
        )),
      ))) : h('div', { class: 'card empty' }, 'Nothing is marked for handover in this service.'),
    );
  };
  await load();
  return root;
}
