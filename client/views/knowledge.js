import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDateTime, confirmDialog } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

const RULES = 'Anonymous to colleagues, recorded for audit. SHIFT gives no answers of its own. Nothing here is a referral, moves responsibility, or enters a patient record. Do not include anything that identifies a patient.';

export async function knowledgeView() {
  const questions = await get('/api/work/knowledge');
  const topic = h('input', { type: 'text', maxlength: 120, placeholder: 'Topic' });
  const body = h('textarea', { placeholder: 'Your question, without patient identifiers' });
  return h('div', {},
    workHeader(),
    pageTitle('Shared knowledge', () => go('/work/home')),
    h('div', { class: 'banner' }, RULES),
    h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await post('/api/work/knowledge', { topic: topic.value, body: body.value }); go(`/work/knowledge/${r.id}`); } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Ask colleagues'),
      topic, body,
      h('button', { class: 'btn primary', type: 'submit' }, 'Post anonymously'),
    ),
    h('div', { class: 'list' }, questions.length ? questions.map((q) => h('button', { class: 'list-item', onclick: () => go(`/work/knowledge/${q.id}`) },
      h('div', { class: 'grow' },
        h('h3', {}, q.topic),
        h('p', {}, q.body.length > 160 ? `${q.body.slice(0, 160)}…` : q.body),
        h('div', { class: 'row small' }, h('span', { class: 'tag muted' }, `${q.replies} ${q.replies === 1 ? 'reply' : 'replies'}`), q.state === 'CLOSED' ? h('span', { class: 'tag muted' }, 'Closed') : null, q.mine ? h('span', { class: 'tag' }, 'Yours') : null, h('span', { class: 'muted' }, fmtDateTime(q.createdAt))),
      ),
      h('span', { class: 'chev' }, '›'),
    )) : h('div', { class: 'card empty' }, 'No questions yet.')),
  );
}

export async function questionView(id) {
  const root = h('div');
  const load = async () => {
    const q = await get(`/api/work/knowledge/${id}`);
    const reply = h('textarea', { placeholder: 'Your reply, without patient identifiers' });
    mount(root,
      workHeader(),
      pageTitle(q.topic, () => go('/work/knowledge')),
      h('div', { class: 'banner' }, RULES),
      h('div', { class: 'card stack' },
        h('div', { class: 'small muted' }, `${q.mine ? 'You' : 'Asker'} · ${fmtDateTime(q.createdAt)}`),
        h('div', {}, q.body),
        q.mine && q.state === 'OPEN' ? h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async () => { try { await post(`/api/work/knowledge/${id}/close`); load(); } catch (err) { showError(err); } } }, 'Close question'),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmDialog('Withdraw question', 'It will no longer be shown to colleagues. The audit record remains.', 'Withdraw'))) return;
            try { await post(`/api/work/knowledge/${id}/close`, { withdraw: true }); go('/work/knowledge'); } catch (err) { showError(err); }
          } }, 'Withdraw'),
        ) : null,
      ),
      h('div', { class: 'list' }, q.replies.map((r) => h('div', { class: 'card stack' }, h('div', { class: 'small muted' }, `${r.by} · ${fmtDateTime(r.createdAt)}`), h('div', {}, r.body)))),
      q.state === 'OPEN' ? h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await post(`/api/work/knowledge/${id}/replies`, { body: reply.value }); toast('Reply posted anonymously.'); load(); } catch (err) { showError(err); }
      } }, reply, h('button', { class: 'btn primary', type: 'submit' }, 'Reply')) : h('div', { class: 'card empty' }, 'This question is closed.'),
    );
  };
  await load();
  return root;
}
