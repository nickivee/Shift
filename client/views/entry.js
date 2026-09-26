import { h, icon } from '../lib/dom.js';
import { get, post, del, localInfo, resetDevice } from '../lib/api.js';
import { showError, toast, pageTitle, confirmDialog } from '../lib/ui.js';
import { state, go, refreshMe } from '../app.js';

export async function entryView() {
  if (!state.me) await refreshMe();
  const enter = (space) => () => {
    if (!state.me) return go(`/signin?next=${space}`);
    if (space === 'personal') return go('/personal');
    return go(state.me.context ? '/work/home' : '/work/context');
  };
  return h('div', { class: 'entry' },
    h('div', { class: 'brand paua-frame' },
      h('div', { class: 'logo' }, 'S'),
      h('p', {}, 'Enter once. Information moves.'),
    ),
    h('button', { class: 'choice paua-frame', onclick: enter('personal') },
      h('h2', { class: 'paua-text' }, 'PERSONAL'),
      h('p', {}, 'Personal employment functions.'),
    ),
    h('button', { class: 'choice paua-frame', onclick: enter('work') },
      h('h2', { class: 'paua-text' }, 'WORK'),
      h('p', {}, 'Authorised work context, patient workflow and documentation.'),
    ),
  );
}

export function signInView(next) {
  const username = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await post('/api/auth/login', { username: username.value, password: password.value });
        await refreshMe();
        go(next === 'personal' ? '/personal' : '/work/context');
      } catch (err) {
        showError(err);
        password.value = '';
        submit.disabled = false;
      }
    },
  },
    h('label', { class: 'field' }, 'Username', username),
    h('label', { class: 'field' }, 'Password', password),
    submit,
  );
  setTimeout(() => username.focus(), 0);
  // On a device running SHIFT's synthetic data set, show who can sign in.
  const accounts = localInfo ? h('div', { class: 'card stack' },
    h('h3', {}, 'Synthetic workforce on this device'),
    h('div', { class: 'list' }, localInfo.users.map((u) => h('button', { class: 'btn', type: 'button', onclick: () => { username.value = u.username; password.value = localInfo.password; password.focus(); } }, u.label))),
    h('p', { class: 'small muted' }, `Password for these accounts: ${localInfo.password}. Everything you enter is kept on this device.`),
    h('button', { class: 'link-btn small', type: 'button', onclick: async () => {
      if (!(await confirmDialog('Start again with fresh synthetic data?', 'Everything recorded on this device will be replaced with the original synthetic data set.', 'Start again'))) return;
      await resetDevice();
      toast('Fresh synthetic data loaded.');
    } }, 'Start again with fresh synthetic data'),
  ) : null;
  return h('div', { class: 'signin' },
    h('div', { class: 'header-card card' },
      h('div', { class: 'logo small' }, 'S'),
      h('div', { class: 'grow' }, h('h1', {}, 'Sign in'), h('div', { class: 'sub' }, next === 'personal' ? 'to PERSONAL' : 'to WORK')),
    ),
    form,
    accounts,
    h('button', { class: 'link-btn', onclick: () => go('/') }, 'Back'),
  );
}

// WORK entry needs an active context: which of your current positions you are working in.
// Signing in alone grants no clinical access.
export async function contextView() {
  const me = await refreshMe();
  const items = me.positions.map((p) =>
    h('button', {
      class: 'list-item', disabled: !p.configured,
      onclick: async () => {
        try {
          await post('/api/work/context', { positionId: p.positionId });
          await refreshMe();
          const a = state.me.context?.authority;
          if (a && !a.current) toast(`Your ${a.profession} practising authority is ${a.status.toLowerCase()}. Clinical entries will be blocked.`, 'error');
          go('/work/home');
        } catch (err) { showError(err); }
      },
    },
      h('div', { class: 'icon-tile' }, icon('workstation')),
      h('div', { class: 'grow' },
        h('h3', {}, `${p.title} · ${p.serviceName}`),
        h('p', {}, [p.organisationName, p.facilityName].filter(Boolean).join(', ')),
        p.configured ? null : h('p', { class: 'small' }, 'No workstation configuration for this position yet.'),
      ),
      h('span', { class: 'chev' }, '›'),
    ),
  );
  return h('div', {},
    h('div', { class: 'header-card card' },
      h('div', { class: 'logo small' }, 'S'),
      h('div', { class: 'grow' }, h('h1', {}, me.worker.name), h('div', { class: 'sub' }, 'Choose your WORK context')),
    ),
    me.context ? h('div', { class: 'banner' },
      h('strong', {}, `Working in ${me.context.service}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => go('/work/home') }, 'Continue'),
        h('button', { class: 'btn', onclick: async () => { await del('/api/work/context'); await refreshMe(); go('/work/context'); } }, 'End this context'),
      ),
    ) : null,
    items.length ? h('div', { class: 'list' }, items) : h('div', { class: 'card empty' }, 'You have no current positions, so WORK is not available.'),
  );
}

export function workHeader(title, subtitle) {
  const ctx = state.me.context;
  return h('div', { class: 'header-card card' },
    h('div', { class: 'logo small' }, 'S'),
    h('div', { class: 'grow' },
      h('h1', {}, title ?? state.me.worker.name),
      h('div', { class: 'sub' }, subtitle ?? `WORK · ${ctx.service}`),
    ),
    h('button', { class: 'btn small', onclick: () => go('/work/context'), title: 'Change WORK context' }, 'Context'),
  );
}

export { pageTitle };
