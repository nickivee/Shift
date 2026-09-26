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
};
const TARGET = { workstation: '/work/records', tasks: '/work/tasks', search: '/work/search', handover: '/work/handover', received: '/work/received', knowledge: '/work/knowledge' };

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
    if (want.includes('handover')) jobs.push(get('/api/work/handover').then((g) => (counts.handover = g.reduce((a, p) => a + p.items.filter((i) => !i.myReceipt).length, 0))));
    await Promise.allSettled(jobs);
  };

  const draw = () => {
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
      h('h2', { class: 'section-title paua' }, 'Workstation tabs'),
      h('div', { class: 'strip', role: 'list' }, tabs),
      h('div', { class: 'grid-cards' }, cards),
      h('div', { class: 'customise-bar' },
        h('button', { class: 'link-btn', onclick: customise }, 'Customise Home'),
        h('span', { class: 'small muted' }, `${state.me.context.roleLabel} · ${state.me.context.matrixRow}`),
      ),
    );
  };

  // Customise: reorder and hide within the authorised set. Organisation-required cards can
  // be moved but not hidden. Nothing here changes what you are authorised to do.
  const customise = () => {
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
      h('h3', {}, 'Workstation tabs'), tabList,
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
  loadCounts().then(draw);
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
