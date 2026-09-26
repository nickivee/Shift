import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Diet order: requirement → assessment → diet → each meal given, how much eaten and how it
// went → review → changed or stopped. Texture and drink levels use the IDDSI names.
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const time = (s) => new Date(s).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', {},
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

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined && value !== null) s.value = String(value);
  return s;
};

// The fields that define a diet, shared by ordering one and changing one.
function dietFields(options, d = {}) {
  const chosen = new Set(String(d.diets ?? 'STANDARD').split(','));
  const boxes = Object.entries(options.diets).map(([k, v]) => {
    const box = h('input', { type: 'checkbox', value: k });
    box.checked = chosen.has(k);
    return h('label', { class: 'check' }, box, ` ${v}`);
  });
  const f = {
    texture: select(options.textures, d.texture ?? '7'),
    drinks: select(options.drinks, d.drinks ?? '0'),
    assistance: select(options.assistance, d.assistance ?? 'INDEPENDENT'),
    supplements: h('input', { type: 'text', value: d.supplements ?? '', placeholder: 'Optional' }),
    preferences: h('textarea', { placeholder: 'Likes, dislikes, cultural or religious needs, in their words' }),
    assessment: h('textarea', { placeholder: 'Who assessed the swallow, when, and what they found' }),
    reason: h('input', { type: 'text', value: d.reason ?? '', placeholder: 'Why this diet is needed' }),
    reviewDate: h('input', { type: 'date', value: inDays(7) }),
  };
  f.preferences.value = d.preferences ?? '';
  f.assessment.value = d.assessment ?? '';
  const assessField = h('label', { class: 'field' }, 'Swallowing assessment', f.assessment);
  const sync = () => { assessField.hidden = f.texture.value === '7' && f.drinks.value === '0'; };
  f.texture.addEventListener('change', sync);
  f.drinks.addEventListener('change', sync);
  const values = () => ({
    ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])),
    diets: boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value).join(','),
  });
  const body = () => {
    const el = h('div', { class: 'stack' },
      h('div', { class: 'field' }, 'Diet', h('div', { class: 'checks' }, boxes)),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Food texture', f.texture), h('label', { class: 'field grow' }, 'Drinks', f.drinks)),
      assessField,
      h('label', { class: 'field' }, 'Help at meals', f.assistance),
      h('label', { class: 'field' }, 'Supplements', f.supplements),
      h('label', { class: 'field' }, 'Preferences', f.preferences),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Why', f.reason), h('label', { class: 'field grow' }, 'Review by', f.reviewDate)),
    );
    sync();
    return el;
  };
  return { values, body };
}

function mealDialog(d, options, reload) {
  const next = d.today.find((m) => m.due && !m.record) ?? d.today.find((m) => !m.record);
  const meal = select(options.meals, next?.meal ?? 'SNACK');
  const outcomes = d.nbm ? { WITHHELD: options.outcomes.WITHHELD, AWAY: options.outcomes.AWAY } : options.outcomes;
  const outcome = select(outcomes, d.nbm ? 'WITHHELD' : 'GIVEN');
  const intake = select(options.intake, 'ALL');
  const tolerance = select(options.tolerance, 'FINE');
  const note = h('input', { type: 'text', placeholder: 'Needed if refused or there was a problem' });
  const given = h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How much eaten', intake), h('label', { class: 'field grow' }, 'How it went', tolerance));
  const sync = () => { given.hidden = outcome.value !== 'GIVEN'; };
  outcome.addEventListener('change', sync);
  dialog(`Meal for ${d.patient}`, h('div', { class: 'stack' },
    d.nbm ? h('p', { class: 'notice' }, h('b', {}, 'Nil by mouth. '), d.nbm.detail, d.nbm.until ? ` Until ${fmtDateTime(d.nbm.until)}.` : '') : null,
    h('p', { class: 'small muted' }, `${d.textureLabel} · drinks ${d.drinksLabel} · ${d.assistanceLabel.toLowerCase()}`),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Meal', meal), h('label', { class: 'field grow' }, 'What happened', outcome)),
    given,
    h('label', { class: 'field' }, 'Note', note),
  ), 'Save', async () => {
    await post(`/api/work/diets/${d.id}/meal`, { meal: meal.value, outcome: outcome.value, intake: intake.value, tolerance: tolerance.value, note: note.value });
    toast(['COUGHING', 'CHOKING'].includes(tolerance.value) && outcome.value === 'GIVEN' ? 'Recorded. Tell the RN now; the diet needs reviewing.' : 'Meal recorded.');
    reload();
  });
  sync();
}

function reviewDialog(d, options, reload) {
  const outcome = select(options.review, 'CONTINUE');
  const finding = h('textarea', { placeholder: 'What the review found' });
  const next = h('input', { type: 'date', value: inDays(7) });
  const change = dietFields(options, d);
  const continueBox = h('label', { class: 'field' }, 'Next review', next);
  const changeBox = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'The current diet is kept in the history and the new one replaces it.'), change.body());
  const sync = () => { continueBox.hidden = outcome.value !== 'CONTINUE'; changeBox.hidden = outcome.value !== 'CHANGED'; };
  outcome.addEventListener('change', sync);
  dialog(`Review ${d.patient}'s diet`, h('div', { class: 'stack' },
    d.concern ? h('p', { class: 'notice' }, h('b', {}, `${d.concern.toleranceLabel} at ${d.concern.mealLabel.toLowerCase()}: `), d.concern.note ?? '') : null,
    h('label', { class: 'field' }, 'Finding', finding),
    h('label', { class: 'field' }, 'Decision', outcome),
    continueBox, changeBox,
  ), 'Save review', async () => {
    const body = { outcome: outcome.value, finding: finding.value };
    await post(`/api/work/diets/${d.id}/review`, outcome.value === 'CHANGED' ? { ...change.values(), ...body } : { ...body, reviewDate: next.value });
    toast({ CONTINUE: 'Review saved.', CHANGED: 'Diet changed.', STOPPED: 'Diet stopped.' }[outcome.value]);
    reload();
  });
  sync();
}

function mealCell(m) {
  const r = m.record;
  if (!r) return h('li', { class: m.due ? 'meal missing' : 'meal' }, h('b', {}, m.label), m.due ? ' Not recorded' : ` ${m.at}`);
  return h('li', { class: `meal${r.concern ? ' concern' : ''}` }, h('b', {}, m.label), ' ',
    r.outcome === 'GIVEN' ? `${r.intakeLabel}${r.tolerance !== 'FINE' ? `, ${r.toleranceLabel.toLowerCase()}` : ''}` : r.outcomeLabel);
}

export function dietCard(d, options, reload, { showPatient = true } = {}) {
  const active = d.state === 'ACTIVE';
  return h('div', { class: `tile stack${d.concern ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${d.personId}/diet`) }, h('b', {}, d.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, d.dietLabels.join(', ')), showPatient && d.location ? ` · ${d.location}` : ''),
      ),
      h('div', { class: 'row' },
        d.nbm ? h('span', { class: 'tag danger' }, 'Nil by mouth') : null,
        d.concern ? h('span', { class: 'tag danger' }, 'Swallowing concern') : null,
        d.reviewDue ? h('span', { class: 'tag warn' }, 'Review due') : null,
        active ? null : h('span', { class: 'tag muted' }, 'Stopped'),
      ),
    ),
    h('div', { class: d.modified ? 'summary texture' : 'small' }, h('b', {}, d.textureLabel), ` · drinks ${d.drinksLabel} · ${d.assistanceLabel.toLowerCase()}`),
    d.nbm ? h('div', { class: 'notice small' }, h('b', {}, 'Nil by mouth: '), d.nbm.detail, d.nbm.until ? ` Until ${fmtDateTime(d.nbm.until)}.` : '') : null,
    d.concern ? h('div', { class: 'small' }, h('b', {}, `${d.concern.toleranceLabel} at ${d.concern.mealLabel.toLowerCase()}, ${fmtDateTime(d.concern.at)}: `), d.concern.note ?? '') : null,
    d.supplements ? h('div', { class: 'small' }, h('b', {}, 'Supplements: '), d.supplements) : null,
    d.preferences ? h('div', { class: 'small' }, h('b', {}, 'Preferences: '), d.preferences) : null,
    d.assessment ? h('div', { class: 'small muted' }, h('b', {}, 'Assessment: '), d.assessment) : null,
    active ? h('ul', { class: 'meals' }, d.today.map(mealCell)) : null,
    d.recent.length ? h('details', {}, h('summary', {}, 'Recent meals'),
      h('ul', { class: 'small stack' }, d.recent.map((r) => h('li', {}, h('b', {}, `${fmtDate(r.date)} ${r.mealLabel}, ${time(r.at)} (${r.by}): `),
        r.outcome === 'GIVEN' ? `${r.intakeLabel}. ${r.toleranceLabel}.` : `${r.outcomeLabel}.`, r.note ? ` ${r.note}` : ''))))
      : null,
    d.reviews.length ? h('div', { class: 'small' }, h('b', {}, `Last review (${d.reviews[0].by}, ${fmtDateTime(d.reviews[0].at)}): `), `${d.reviews[0].outcomeLabel}. ${d.reviews[0].finding}`) : null,
    d.closeReason && !active ? h('div', { class: 'small' }, h('b', {}, `Stopped (${d.closedBy}): `), d.closeReason) : null,
    h('div', { class: 'small muted' }, [`${d.reason}`, `ordered by ${d.orderedBy} ${fmtDateTime(d.orderedAt)}`, d.reviewDate && active ? `review by ${fmtDate(d.reviewDate)}` : null].filter(Boolean).join(' · ')),
    d.canRecord || d.canOrder ? h('div', { class: 'row' },
      d.canRecord ? h('button', { class: 'btn small primary', onclick: () => mealDialog(d, options, reload) }, 'Record meal') : null,
      d.canOrder ? h('button', { class: 'btn small', onclick: () => reviewDialog(d, options, reload) }, 'Review') : null,
    ) : null,
  );
}

// The patient's Diet and meals view inside the Live Workstation.
export function dietPanel(personId, d, reload) {
  const form = () => {
    const f = dietFields(d.options);
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/diet`, f.values());
        toast('Diet ordered.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Order a diet'),
      f.body(),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Order')),
    );
  };
  return h('div', { class: 'stack' },
    d.orders.length ? d.orders.map((o) => dietCard(o, d.options, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, d.nbm ? `No diet ordered. Nil by mouth: ${d.nbm.detail}` : 'No diet ordered for this patient.'),
    d.canOrder && !d.orders.length ? form() : null,
    d.past.length ? h('details', {}, h('summary', {}, `Stopped (${d.past.length})`), h('div', { class: 'stack' }, d.past.map((o) => dietCard(o, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Diets and meals.
export async function mealsView() {
  const root = h('div');
  const load = async () => {
    const { orders, options } = await get('/api/work/meals');
    const concern = orders.filter((d) => d.concern);
    const rest = orders.filter((d) => !d.concern);
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((d) => dietCard(d, options, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Diets and meals', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Food texture and drink thickness use the IDDSI levels. Meals are withheld while nil by mouth is in force.'),
      concern.length ? section('Swallowing concerns', concern, '') : null,
      section('Diets', rest, 'No diets ordered.'),
    );
  };
  await load();
  return root;
}
