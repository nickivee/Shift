import { h } from './dom.js';

// Shared pieces for the pop-up forms every screen uses.
export const field = (label, el) => h('label', { class: 'field' }, label, el);
export const select = (entries, label, blank = 'Choose…') => h('select', { 'aria-label': label }, blank === null ? null : h('option', { value: '' }, blank), entries.map(([k, v]) => h('option', { value: k }, v)));

// A dialog with several ways out: each action button runs its own handler.
export function dialog(title, body) {
  const error = h('p', { class: 'small notice', hidden: true });
  const close = () => { dlg.close(); dlg.remove(); };
  const run = (fn) => async () => {
    error.hidden = true;
    try { await fn(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); }
  };
  const dlg = h('dialog', { class: 'idm-dialog wide' }, h('div', { class: 'stack' }, h('h2', {}, title), body(run, close), error,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

// A pop-up form with one submit button. If saving fails the message shows in the form and it stays open.
export function formDialog(title, body, submitLabel, onSubmit, { wide = false } = {}) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', wide ? { class: 'wide' } : {},
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
