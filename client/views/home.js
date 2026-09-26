import { h, icon, mount } from '../lib/dom.js';
import { get, put, del } from '../lib/api.js';
import { showError, toast } from '../lib/ui.js';
import { state, go } from '../app.js';
import { workHeader } from './entry.js';

const DESCRIPTIONS = {
  workstation: (s) => `Select a ${s} and open the active documentation workspace.`,
  tasks: () => 'Outstanding work remains visible until resolved.',
  search: (s) => `Find a ${s}.`,
  handover: () => 'Review items explicitly marked for handover.',
  received: () => 'Information routed to you. Nothing is received until you open it.',
  knowledge: () => 'Ask colleagues anonymously. SHIFT gives no answers of its own.',
  vacancies: () => 'Open shifts and who has asked for them. Only your decision changes the roster.',
  swaps: () => 'Shifts staff have offered to colleagues, waiting on a rostering decision.',
  leave: () => 'Leave requests waiting for a decision.',
  transfers: () => 'Admissions and transfers coming in and going out, one step at a time.',
  flow: () => 'Beds across the hospital and who is waiting for one.',
  discharges: () => 'Discharges being planned and what is still outstanding.',
  consults: () => 'Advice asked of your team, and advice your team has asked for.',
  escalations: () => 'Concerns raised to you, and the ones you raised, until reassessed.',
};
const TARGET = {
  workstation: '/work/records', tasks: '/work/tasks', search: '/work/search', handover: '/work/handover', received: '/work/received', knowledge: '/work/knowledge',
  vacancies: '/work/rostering/vacancies', swaps: '/work/rostering/swaps', leave: '/work/rostering/leave',
  transfers: '/work/transfers', flow: '/work/flow', discharges: '/work/discharges', escalations: '/work/escalations', consults: '/work/consultations',
};

export function openTab(tabId) {
  go(tabId === 'list' ? '/work/records' : `/work/records?open=${tabId}`);
}

export async function homeView() {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const home = await get('/api/work/home');
  const root = h('div');

  const counts = {};
  const loadCounts = async () => {
    const want = home.cards.filter((c) => !c.hidden).map((c) => c.id);
    const jobs = [];
    if (want.includes('tasks')) jobs.push(get('/api/work/tasks').then((t) => (counts.tasks = t.filter((x) => !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(x.state)).length)));
    if (want.includes('received')) jobs.push(get('/api/work/received').then((r) => (counts.received = r.filter((x) => x.state === 'DELIVERED').length)));
    for (const id of ['vacancies', 'swaps', 'leave']) {
      if (want.includes(id)) jobs.push(get(`/api/work/rostering/${id}`).then((rows) => (counts[id] = rows.length)));
    }
    if (want.includes('transfers')) jobs.push(get('/api/work/transfers').then((rows) => (counts.transfers = rows.filter((t) => t.actions.length).length)));
    if (want.includes('discharges')) jobs.push(get('/api/work/discharges').then((rows) => (counts.discharges = rows.filter((d) => d.actions.length || d.requirements.some((r) => r.canRecord)).length)));
    if (want.includes('escalations')) jobs.push(get('/api/work/escalations').then((rows) => (counts.escalations = rows.filter((x) => x.actions.some((a) => ['receive', 'acknowledge', 'respond'].includes(a))).length)));
    if (want.includes('consults')) jobs.push(get('/api/work/consultations').then((rows) => (counts.consults = rows.filter((c) => c.actions.some((a) => a !== 'withdraw')).length)));
    if (want.includes('flow')) jobs.push(get('/api/work/beds').then((rows) => (counts.flow = rows.filter((b) => b.state === 'AVAILABLE').length)));
    if (want.includes('handover')) jobs.push(get('/api/work/handover').then((g) => (counts.handover = g.reduce((a, p) => a + p.items.filter((i) => !i.myReceipt).length, 0))));
    await Promise.allSettled(jobs);
  };

  const draw = () => {
    customising = false;
    const cards = home.cards.filter((c) => !c.hidden).map((c) =>
      h('button', { class: 'card home-card', onclick: () => go(TARGET[c.id]) },
        counts[c.id] ? h('span', { class: 'count paua' }, String(counts[c.id])) : null,
        h('div', { class: 'icon-tile' }, icon(c.id)),
        h('h2', {}, c.label),
        h('p', {}, DESCRIPTIONS[c.id]?.(subject) ?? ''),
      ),
    );
    const tabs = home.tabs.filter((t) => !t.hidden).map((t) => h('button', { class: 'pill', onclick: () => openTab(t.id) }, t.label));
    mount(root,
      workHeader(),
      tabs.length ? h('h2', { class: 'section-title paua' }, 'Workstation tabs') : null,
      tabs.length ? h('div', { class: 'strip', role: 'list' }, tabs) : null,
      h('div', { class: 'grid-cards' }, cards),
      h('div', { class: 'customise-bar' },
        h('button', { class: 'link-btn', onclick: customise }, 'Customise Home'),
        h('span', { class: 'small muted' }, `${state.me.context.roleLabel} · ${state.me.context.matrixRow}`),
      ),
    );
  };

  // Customise: reorder and hide within the authorised set. Organisation-required cards can
  // be moved but not hidden. Nothing here changes what you are authorised to do.
  let customising = false;
  const customise = () => {
    customising = true;
    const draft = { cards: home.cards.map((c) => ({ ...c })), tabs: home.tabs.map((t) => ({ ...t })) };
    const cardList = sortableList(draft.cards, 'card');
    const tabList = sortableList(draft.tabs, 'tab');
    mount(root,
      workHeader(),
      h('div', { class: 'banner' },
        h('strong', {}, 'Customise Home'),
        'Drag to reorder, or use the arrows. Hiding a card or tab only changes your screen, never your authority.',
      ),
      h('h3', {}, 'Cards'), cardList,
      draft.tabs.length ? h('h3', {}, 'Workstation tabs') : null, draft.tabs.length ? tabList : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            Object.assign(home, await put('/api/work/home', { cards: draft.cards.map(({ id, hidden }) => ({ id, hidden })), tabs: draft.tabs.map(({ id, hidden }) => ({ id, hidden })) }));
            toast('Home saved.');
            draw();
          } catch (err) { showError(err); }
        } }, 'Save'),
        h('button', { class: 'btn', onclick: draw }, 'Cancel'),
        h('button', { class: 'btn', onclick: async () => {
          try { Object.assign(home, await del('/api/work/home')); toast('Home reset to your service default.'); draw(); } catch (err) { showError(err); }
        } }, 'Reset to default'),
      ),
    );
  };

  draw();
  loadCounts().then(() => { if (!customising) draw(); });
  return root;
}

function sortableList(items, kind) {
  const list = h('div', { class: 'sortable', role: 'list' });
  const redraw = () => {
    mount(list, items.map((it, i) => {
      const row = h('div', { class: `sort-item${it.hidden ? ' is-hidden' : ''}`, role: 'listitem', dataset: { index: String(i) } },
        h('span', { class: 'handle', 'aria-hidden': 'true', onpointerdown: (e) => startDrag(e, row) }, icon('grip')),
        h('span', { class: 'label' }, it.label),
        it.required ? h('span', { class: 'tag' }, 'Required') : null,
        h('button', { class: 'btn small', 'aria-label': `Move ${it.label} up`, disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
        h('button', { class: 'btn small', 'aria-label': `Move ${it.label} down`, disabled: i === items.length - 1, onclick: () => move(i, i + 1) }, '↓'),
        it.required ? null : h('button', { class: 'btn small', onclick: () => { it.hidden = !it.hidden; redraw(); } }, it.hidden ? 'Show' : 'Hide'),
      );
      return row;
    }));
  };
  const move = (from, to) => {
    if (to < 0 || to >= items.length) return;
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
    redraw();
  };

  // Pointer-based dragging works with touch, pen and mouse alike.
  const startDrag = (e, row) => {
    e.preventDefault();
    const from = Number(row.dataset.index);
    row.classList.add('dragging');
    let to = from;
    const onMove = (ev) => {
      const rows = [...list.children];
      to = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { to = i; break; }
      }
      const target = rows[to];
      if (target !== row) {
        if (to > Number(row.dataset.index)) target.after(row); else target.before(row);
      }
      [...list.children].forEach((c, i) => (c.dataset.index = String(i)));
      to = [...list.children].indexOf(row);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      move(from, to);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  list.dataset.kind = kind;
  redraw();
  return list;
}
