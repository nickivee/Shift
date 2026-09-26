import { h } from './dom.js';

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${kind === 'error' ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : 3500);
}

export function showError(err) {
  const refs = err?.detail?.ruleRefs?.length ? ` (${err.detail.ruleRefs.join(', ')})` : '';
  const label = err?.detail?.decision && err.detail.decision !== 'BLOCK' ? `${err.detail.decision}: ` : '';
  toast(`${label}${err?.message ?? 'Something went wrong.'}${refs}`, 'error');
}

// A small modal that asks for text. Resolves null when cancelled.
export function ask({ title, message, label, placeholder = '', confirm = 'Save', multiline = false, minLength = 0 }) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea', { placeholder }) : h('input', { type: 'text', placeholder });
    const error = h('p', { class: 'small', hidden: true });
    const dlg = h('dialog', {},
      h('form', { method: 'dialog', class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v.length < minLength) { error.textContent = `Please write at least ${minLength} characters.`; error.hidden = false; return; }
        dlg.close(); dlg.remove(); resolve(v);
      } },
        h('h2', {}, title),
        message ? h('p', { class: 'muted' }, message) : null,
        h('label', { class: 'field' }, label, input),
        error,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, confirm),
          h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); resolve(null); } }, 'Cancel'),
        ),
      ),
    );
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

export function confirmDialog(title, message, confirm = 'Confirm') {
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog', {},
      h('h2', {}, title),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => done(true) }, confirm),
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
      ),
    );
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

const DATE = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const WEEKDAY = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });

export const fmtDate = (s) => (s ? DATE.format(new Date(s.length === 10 ? `${s}T00:00:00` : s)) : '');
export const fmtDateTime = (s) => (s ? DATETIME.format(new Date(s)) : '');
export const fmtDay = (s) => (s ? WEEKDAY.format(new Date(`${s}T00:00:00`)) : '');
export const money = (cents) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const titleCase = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function stateTag(state) {
  const tone = {
    SENT: 'muted', DELIVERED: 'warn', RECEIVED: '', REVIEWED: '', ACCEPTED: 'ok', ACTIONED: 'ok',
    CREATED: 'warn', ASSIGNED: 'warn', REASSIGNED: 'warn', IN_PROGRESS: '', COMPLETED: 'ok', CLOSED: 'muted', CANCELLED: 'muted',
    AVAILABLE: 'warn', CURRENT: 'ok', ENTERED_IN_ERROR: 'danger', SUPERSEDED: 'muted',
  }[state] ?? '';
  return h('span', { class: `tag ${tone}` }, titleCase(state));
}

export function pageTitle(text, back) {
  return h('div', { class: 'page-title' },
    back ? h('button', { class: 'back', onclick: back, 'aria-label': 'Back' }, '‹ Back') : null,
    h('h1', {}, text),
  );
}
