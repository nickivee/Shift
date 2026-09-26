import { h, mount } from '../lib/dom.js';
import { get, post, put } from '../lib/api.js';
import { showError, toast, fmtDateTime } from '../lib/ui.js';
import { state, go } from '../app.js';

// Personal Notes: your own working memory. Not clinical documentation, never shared,
// never routed. Dismissing hides a note; it is not destroyed.
export async function notesView() {
  const root = h('div');
  let showDismissed = false;
  const load = async () => {
    const notes = await get(`/api/notes${showDismissed ? '?dismissed=1' : ''}`);
    const draft = h('textarea', { placeholder: 'Jot something down for yourself' });
    const edit = (n) => {
      const area = h('textarea', { value: n.body });
      const card = h('div', { class: 'card stack' }, area, h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { try { await put(`/api/notes/${n.id}`, { body: area.value }); load(); } catch (err) { showError(err); } } }, 'Save'),
        h('button', { class: 'btn', onclick: load }, 'Cancel'),
      ));
      return card;
    };
    mount(root,
      h('div', { class: 'header-card card' },
        h('div', { class: 'logo small' }, 'S'),
        h('div', { class: 'grow' }, h('h1', {}, 'Notes'), h('div', { class: 'sub' }, `${state.me.worker.name} · personal working notes`)),
      ),
      h('div', { class: 'banner' }, 'Notes are yours alone. They are not part of any patient record and are never sent anywhere. Record clinical information with a .key in the Live Workstation.'),
      h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await post('/api/notes', { body: draft.value }); toast('Note saved.'); load(); } catch (err) { showError(err); }
      } }, draft, h('button', { class: 'btn primary', type: 'submit' }, 'Add note')),
      h('div', { class: 'spread' }, h('h3', {}, showDismissed ? 'All notes' : 'Current notes'),
        h('button', { class: 'link-btn', onclick: () => { showDismissed = !showDismissed; load(); } }, showDismissed ? 'Hide dismissed' : 'Show dismissed')),
      notes.length ? h('div', { class: 'list' }, notes.map((n) => {
        const card = h('div', { class: 'card stack' },
          h('div', {}, n.body),
          h('div', { class: 'spread small muted' }, `${fmtDateTime(n.updatedAt)}${n.dismissedAt ? ' · dismissed' : ''}`,
            h('span', { class: 'row' },
              n.dismissedAt
                ? h('button', { class: 'btn small', onclick: async () => { await post(`/api/notes/${n.id}/restore`).catch(showError); load(); } }, 'Restore')
                : [h('button', { class: 'btn small', onclick: () => card.replaceWith(edit(n)) }, 'Edit'),
                  h('button', { class: 'btn small', onclick: async () => { await post(`/api/notes/${n.id}/dismiss`).catch(showError); load(); } }, 'Dismiss')],
            ),
          ),
        );
        return card;
      })) : h('div', { class: 'card empty' }, 'No notes.'),
    );
  };
  await load();
  return root;
}
