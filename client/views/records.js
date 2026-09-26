import { h, icon, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, ask, pageTitle, fmtDate } from '../lib/ui.js';
import { state, go } from '../app.js';
import { workHeader } from './entry.js';

// Patient Records: the service list, then open a record. When arriving from a Home tab
// (e.g. Observations), the chosen record opens straight at that tab.
export async function recordsView(openTab) {
  const subject = state.me.context.subjectLabel;
  const [patients, config] = await Promise.all([get('/api/work/patients'), openTab ? get('/api/work/config') : null]);
  let mineOnly = patients.some((p) => p.allocated);
  const listEl = h('div', { class: 'list' });
  const tab = openTab && config?.views.some((v) => v.code === openTab) ? openTab : null;
  const tabLabel = tab ? config.tabs.find((t) => t.id === tab)?.label ?? tab : '';

  const draw = () => {
    const shown = mineOnly ? patients.filter((p) => p.allocated) : patients;
    mount(listEl, shown.length ? shown.map((p) =>
      h('button', { class: 'list-item', onclick: () => go(`/work/patient/${p.id}${tab ? `/${tab}` : ''}`) },
        h('div', { class: 'icon-tile' }, icon('person')),
        h('div', { class: 'grow' },
          h('h3', {}, p.name, p.preferredName ? ` (${p.preferredName})` : ''),
          h('p', {}, [p.location, p.age !== null ? `${p.age}y` : null, p.gender, p.nhi ? `NHI ${p.nhi}` : null].filter(Boolean).join(' · ')),
          h('div', { class: 'row small' },
            p.hasAllergy ? h('span', { class: 'tag danger' }, 'Allergy') : null,
            p.handover ? h('span', { class: 'tag' }, `Handover ${p.handover}`) : null,
            p.openTasks ? h('span', { class: 'tag warn' }, `Tasks ${p.openTasks}`) : null,
            p.allocated ? h('span', { class: 'tag ok' }, 'Allocated to you') : null,
          ),
        ),
        h('span', { class: 'chev' }, '›'),
      ),
    ) : h('div', { class: 'card empty' }, mineOnly ? `No ${subject.toLowerCase()}s are allocated to you today.` : `No ${subject.toLowerCase()}s in ${state.me.context.service}.`));
  };
  const toggle = h('div', { class: 'row' },
    h('button', { class: 'pill', onclick: (e) => { mineOnly = true; setActive(e.target); draw(); } }, 'My allocation'),
    h('button', { class: 'pill', onclick: (e) => { mineOnly = false; setActive(e.target); draw(); } }, `All in ${state.me.context.service}`),
    h('button', { class: 'btn small', onclick: () => go('/work/search') }, 'Search'),
  );
  const setActive = (el) => [...toggle.querySelectorAll('.pill')].forEach((b) => b.classList.toggle('active', b === el));
  setActive(toggle.querySelectorAll('.pill')[mineOnly ? 0 : 1]);
  draw();
  return h('div', {},
    workHeader(),
    pageTitle(tab ? `Choose a ${subject.toLowerCase()} to open ${tabLabel}` : `${subject} list`, () => go('/work/home')),
    toggle,
    h('div', { class: 'stack' }, listEl),
  );
}

export function searchView() {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const input = h('input', { type: 'search', placeholder: 'Name or NHI', autocomplete: 'off' });
  const results = h('div', { class: 'list' });
  let timer;
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { mount(results); return; }
    try {
      const rows = await get(`/api/work/search?q=${encodeURIComponent(q)}`);
      mount(results, rows.length ? rows.map((r) =>
        h('div', { class: 'list-item' },
          h('div', { class: 'icon-tile' }, icon('person')),
          h('div', { class: 'grow' },
            h('h3', {}, r.name),
            h('p', {}, [r.nhi ? `NHI ${r.nhi}` : null, r.dateOfBirth ? `DOB ${fmtDate(r.dateOfBirth)}` : null].filter(Boolean).join(' · ')),
            r.relationship ? h('span', { class: 'tag ok' }, r.relationship === 'EXCEPTIONAL' ? 'Exceptional access active' : `In ${state.me.context.service}`) : h('span', { class: 'tag warn' }, 'No care relationship in your service'),
          ),
          r.relationship
            ? h('button', { class: 'btn', onclick: () => go(`/work/patient/${r.id}`) }, 'Open')
            : h('button', { class: 'btn danger', onclick: () => exceptional(r) }, 'Exceptional access'),
        ),
      ) : h('div', { class: 'card empty' }, 'No matches.'));
    } catch (err) { showError(err); }
  };
  const exceptional = async (r) => {
    const reason = await ask({
      title: 'Exceptional access',
      message: `${r.name} has no care relationship with ${state.me.context.service}. Access is recorded with your reason, limited to one hour, and reviewed.`,
      label: 'Why do you need this record?', multiline: true, minLength: 10, confirm: 'Record reason and open',
    });
    if (!reason) return;
    try {
      await post(`/api/work/patients/${r.id}/exceptional-access`, { reason });
      go(`/work/patient/${r.id}`);
    } catch (err) { showError(err); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  setTimeout(() => input.focus(), 0);
  return h('div', {},
    workHeader(),
    pageTitle(`Find a ${subject}`, () => go('/work/home')),
    h('div', { class: 'stack' }, input, results),
  );
}
