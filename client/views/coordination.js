import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime, stateTag } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Tasks: responsibility is taken on explicitly (Accept), never by routing or by viewing.
export async function tasksView() {
  const root = h('div');
  const load = async () => {
    const tasks = await get('/api/work/tasks');
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
      tasks.length ? h('div', { class: 'list' }, tasks.map((t) => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('b', {}, t.description), stateTag(t.state)),
        h('div', { class: 'small muted' }, [t.patient, t.location, t.dueAt ? `Due ${t.dueAt}` : null, `Assigned: ${t.assignedTo}`, `From ${t.createdBy}`].filter(Boolean).join(' · ')),
        t.outcome ? h('div', { class: 'small' }, `Outcome: ${t.outcome}`) : null,
        h('div', { class: 'row' }, actions(t), h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${t.personId}/tasks`) }, 'Open record')),
      ))) : h('div', { class: 'card empty' }, 'No outstanding tasks.'),
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
