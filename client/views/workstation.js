import { h, icon, mount } from '../lib/dom.js';
import { get, post, requestKey } from '../lib/api.js';
import { showError, toast, ask, fmtDate, fmtDateTime, stateTag, titleCase } from '../lib/ui.js';
import { transfersPanel } from './transfers.js';
import { dischargePanel } from './discharges.js';
import { escalationsPanel } from './escalations.js';
import { consultationsPanel } from './consultations.js';
import { woundsPanel } from './wounds.js';
import { carePlanPanel } from './careplans.js';
import { referralsPanel } from './referrals.js';
import { appointmentsPanel } from './appointments.js';
import { alertsPanel } from './alerts.js';
import { state, go } from '../app.js';

// Live Workstation: the primary surface after opening a record. It stays uncluttered;
// information appears only when invoked, by touch (left column) or by command:
//   .key   records a concise entry (blank fields stay blank and are left out)
//   ?view  retrieves existing authorised information from its source (no copy is made)
//   +dest  routes existing canonical information to a registered destination
export async function workstationView(personId, initialView) {
  const [patient, config] = await Promise.all([get(`/api/work/patients/${personId}`), get('/api/work/config')]);
  const keys = new Map(config.keys.map((k) => [k.code, k]));
  const views = new Map(config.views.map((v) => [v.code, v]));
  const dests = config.destinations;

  const ws = {
    view: null,          // current retrieve code
    data: null,          // current retrieve payload
    form: null,          // { template, values, amendOf, idem }
    selected: null,      // selected canonical event
    handover: false,
    urgent: false,
    showPeriod: false,
  };

  const title = h('h2', {}, 'Live Workstation');
  const body = h('div', { class: 'live-body' });
  const destCol = h('nav', { class: 'destinations', 'aria-label': 'Workstation destinations' });
  const input = h('input', { type: 'text', placeholder: 'Type .key, ?view or +destination', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Command' });
  const suggest = h('div', { class: 'suggest' });
  const chips = h('div', { class: 'chips' });
  const from = h('input', { type: 'datetime-local' });
  const to = h('input', { type: 'datetime-local' });
  const toggles = h('div', { class: 'toggles' });

  // Record destinations: every record area this role may open, down the side.
  const subject = state.me.context.subjectLabel;
  // A break opportunity after '/' keeps labels like Intake/Output whole words.
  const destLabel = (v) => (v.code === 'overview' ? `${subject} Overview` : v.label.replaceAll('/', '/\u200b'));
  const drawDestinations = () => {
    mount(destCol,
      config.views.map((v) => h('button', { class: `dest${ws.view === v.code ? ' active' : ''}`, onclick: () => openView(v.code) }, h('span', {}, destLabel(v)))),
      h('button', { class: `dest${ws.view === null ? ' active' : ''}`, onclick: () => { ws.view = null; ws.data = null; ws.form = null; ws.selected = null; draw(); input.focus(); } }, h('span', {}, 'Live Workstation')),
    );
  };
  const keepActiveVisible = () => {
    const active = destCol.querySelector('.active');
    if (active && destCol.scrollHeight > destCol.clientHeight) active.scrollIntoView({ block: 'nearest' });
  };

  async function openView(code) {
    if (!views.has(code)) return toast(`?${code} is not part of your workstation.`, 'error');
    try {
      ws.data = await get(`/api/work/patients/${personId}/views/${code}`);
      ws.view = code;
      ws.selected = null;
      history.replaceState(null, '', `#/work/patient/${personId}/${code}`);
      draw();
    } catch (err) { showError(err); }
  }

  function openKey(code, amend) {
    const template = keys.get(code);
    if (!template) return toast(`${code} is not part of your workstation.`, 'error');
    ws.form = { template, values: amend ? { ...amend.fields } : {}, amendOf: amend ?? null, idem: requestKey() };
    draw();
    body.querySelector('.keyform input, .keyform select, .keyform textarea')?.focus();
  }

  // Command parsing -----------------------------------------------------------------------
  const parse = () => {
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    return {
      key: tokens.find((t) => t.startsWith('.')) ?? null,
      view: tokens.find((t) => t.startsWith('?'))?.slice(1) ?? null,
      dests: tokens.filter((t) => t.startsWith('+') && t.length > 1).map((t) => t.slice(1).toLowerCase()),
      last: tokens.at(-1) ?? '',
      text: input.value,
    };
  };

  const drawSuggest = () => {
    const { last } = parse();
    const typing = input.value.length && !input.value.endsWith(' ') ? last : '';
    let options = [];
    if (typing.startsWith('.')) options = config.keys.filter((k) => k.code.startsWith(typing)).map((k) => [k.code, k.label]);
    else if (typing.startsWith('?')) options = config.views.filter((v) => `?${v.code}`.startsWith(typing)).map((v) => [`?${v.code}`, v.label]);
    else if (typing.startsWith('+')) options = dests.filter((d) => `+${d.alias}`.startsWith(typing)).map((d) => [`+${d.alias}`, d.label]);
    else if (!input.value) options = [...config.keys.slice(0, 6).map((k) => [k.code, k.label]), ...config.views.slice(0, 4).map((v) => [`?${v.code}`, v.label])];
    mount(suggest, options.slice(0, 14).map(([code, label]) =>
      h('button', { type: 'button', title: label, onclick: () => complete(code) }, code),
    ));
  };

  const complete = (code) => {
    const parts = input.value.split(/\s+/);
    if (input.value && !input.value.endsWith(' ')) parts.pop();
    input.value = [...parts.filter(Boolean), code].join(' ') + ' ';
    onInput();
    input.focus();
  };

  const onInput = () => {
    const { key, dests: d } = parse();
    if (key && keys.has(key) && ws.form?.template.code !== key && !ws.form?.amendOf) openKey(key);
    drawChips(d);
    drawSuggest();
  };

  const drawChips = (d) => mount(chips, d.map((alias) => {
    const dest = dests.find((x) => x.alias === alias);
    return h('span', { class: 'chip' }, dest ? `→ ${dest.label}` : `+${alias} is not a registered destination`);
  }));

  async function run() {
    const cmd = parse();
    if (cmd.view) {
      if (!views.has(cmd.view)) return toast(`?${cmd.view} is not part of your workstation.`, 'error');
      input.value = '';
      onInput();
      return openView(cmd.view);
    }
    if (ws.form) return submitForm();
    if (cmd.key && !keys.has(cmd.key)) return toast(`${cmd.key} is not part of your workstation.`, 'error');
    if (cmd.dests.length || ws.handover) {
      if (!ws.selected) return toast('Choose an entry first (tap it), then +destination to route it.', 'error');
      return routeSelected(cmd.dests);
    }
    toast('Type .key to record, ?view to retrieve, or tap an entry and type +destination to route it.');
  }

  async function submitForm() {
    const f = ws.form;
    const cmd = parse();
    try {
      if (f.amendOf) {
        const reason = await ask({ title: 'Reason for amendment', message: 'The original stays in the record history.', label: 'Reason', minLength: 3, confirm: 'Amend' });
        if (!reason) return;
        await post(`/api/work/events/${f.amendOf.id}/amend`, { fields: f.values, reason });
        toast('Amended. The original version is kept in history.');
      } else {
        const result = await post('/api/work/commands', {
          personId, key: f.template.code, fields: f.values, destinations: cmd.dests,
          handover: ws.handover, urgent: ws.urgent,
          from: ws.showPeriod && from.value ? new Date(from.value).toISOString() : null,
          to: ws.showPeriod && to.value ? new Date(to.value).toISOString() : null,
          idempotencyKey: f.idem,
        });
        toast(receipt(f.template, result));
      }
      const back = [...views.values()].find((v) => v.key === f.template.code)?.code;
      ws.form = null;
      ws.handover = ws.urgent = false;
      input.value = '';
      onInput();
      if (back) await openView(back); else draw();
    } catch (err) { showError(err); }
  }

  async function routeSelected(aliases) {
    try {
      const result = await post('/api/work/commands', {
        personId, eventId: ws.selected.id, destinations: aliases, handover: ws.handover, idempotencyKey: requestKey(),
      });
      const parts = [];
      if (result.routes.length) parts.push(`Sent to ${result.routes.map((r) => r.destination).join(', ')}. Delivered, not yet received.`);
      if (result.handover) parts.push('Marked for handover.');
      toast(parts.join(' '));
      input.value = '';
      ws.handover = false;
      onInput();
      if (ws.view) await openView(ws.view);
    } catch (err) { showError(err); }
  }

  const receipt = (template, r) => {
    const parts = [template.createsTask ? 'Task created.' : `${template.label} recorded.`];
    if (r.routes?.length) parts.push(`Sent to ${r.routes.map((x) => x.destination).join(', ')} (delivered, not yet received).`);
    if (r.handover) parts.push('Marked for handover.');
    if (r.replayed) parts.push('This was already saved; nothing was duplicated.');
    return parts.join(' ');
  };

  // Drawing ---------------------------------------------------------------------------------
  const drawToggles = () => mount(toggles,
    h('button', { type: 'button', class: 'toggle', 'aria-pressed': String(ws.handover), onclick: () => { ws.handover = !ws.handover; drawToggles(); } }, 'Handover'),
    h('button', { type: 'button', class: 'toggle urgent', 'aria-pressed': String(ws.urgent), onclick: () => { ws.urgent = !ws.urgent; drawToggles(); } }, 'Urgent'),
    h('button', { type: 'button', class: 'toggle', 'aria-pressed': String(ws.showPeriod), onclick: () => { ws.showPeriod = !ws.showPeriod; drawToggles(); } }, 'From / To'),
    ws.showPeriod ? h('span', { class: 'period' }, h('label', {}, 'From', from), h('label', {}, 'To', to)) : null,
  );

  const draw = () => {
    drawDestinations();
    requestAnimationFrame(keepActiveVisible);
    title.textContent = ws.form ? (ws.form.amendOf ? `Amend ${ws.form.template.label}` : ws.form.template.label) : ws.view ? views.get(ws.view).label : 'Live Workstation';
    const content = [];
    if (ws.form) content.push(keyForm());
    if (ws.view && ws.data) content.push(renderView());
    if (!content.length) content.push(h('div', { class: 'live-hint' }, 'Choose a destination, or type a command below.'));
    mount(body, content);
  };

  const keyForm = () => {
    const f = ws.form;
    const t = f.template;
    const slot = (field) => {
      const set = (e) => { f.values[field.id] = e.target.value; };
      let control;
      if (field.type === 'choice') {
        control = h('select', { onchange: set }, h('option', { value: '' }, ' '), field.options.map((o) => h('option', { value: o, selected: f.values[field.id] === o }, o)));
      } else if (field.type === 'longtext') {
        return h('textarea', { oninput: set, value: f.values[field.id] ?? '', 'aria-label': field.label });
      } else {
        control = h('input', {
          type: 'text', inputmode: field.type === 'number' ? 'decimal' : field.type === 'bp' ? 'numeric' : 'text',
          class: field.type === 'text' ? 'wide' : '', size: field.type === 'number' ? 5 : field.type === 'bp' ? 7 : 20,
          placeholder: field.type === 'bp' ? 'sys/dia' : '', value: f.values[field.id] ?? '', oninput: set, 'aria-label': field.label,
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitForm(); } },
        });
      }
      return h('span', { class: 'slot' }, h('b', {}, field.label), h('span', { class: 'paren' }, '('), control, field.unit ? h('span', { class: 'unit' }, field.unit) : null, h('span', { class: 'paren' }, ')'));
    };
    return h('div', { class: 'keyform' },
      h('div', { class: 'title' },
        h('span', {}, t.code, ' · ', f.amendOf ? `amending your entry from ${fmtDateTime(f.amendOf.effectiveAt)}` : 'fill in what you have; blanks are left out'),
        h('button', { class: 'link-btn', onclick: () => { ws.form = null; input.value = ''; onInput(); draw(); } }, 'Discard'),
      ),
      h('div', { class: 'sentence' }, t.fields.map(slot)),
      h('div', { class: 'row', }, h('button', { class: 'btn primary', onclick: submitForm }, f.amendOf ? 'Amend' : t.createsTask ? 'Create task' : 'Record')),
    );
  };

  const entryItem = (e) => {
    const selected = ws.selected?.id === e.id;
    return h('div', {
      class: `entry-item${selected ? ' selected' : ''}${e.urgent ? ' urgent' : ''}${e.state === 'ENTERED_IN_ERROR' ? ' error' : ''}`,
      role: 'button', tabindex: '0',
      onclick: (ev) => { if (ev.target.closest('button')) return; ws.selected = selected ? null : e; draw(); },
    },
      h('div', { class: 'text' }, e.text),
      h('div', { class: 'meta' }, [fmtDateTime(e.effectiveAt) + (e.effectiveEnd ? `–${fmtDateTime(e.effectiveEnd)}` : ''), e.author, e.authorRole].filter(Boolean).join(' · ')),
      h('div', { class: 'row small' },
        e.urgent ? h('span', { class: 'tag danger' }, 'Urgent') : null,
        e.handover ? h('span', { class: 'tag' }, 'Handover') : null,
        e.version > 1 ? h('span', { class: 'tag muted' }, `Amended (v${e.version})`) : null,
        e.state === 'ENTERED_IN_ERROR' ? h('span', { class: 'tag danger' }, 'Entered in error') : null,
        e.routes.map((r) => h('span', { class: 'tag muted' }, `→ ${r.label}: ${titleCase(r.state)}`)),
      ),
      selected && e.state === 'CURRENT' ? h('div', { class: 'entry-actions' },
        config.destinations.length ? h('button', { class: 'btn small', onclick: () => { input.value = '+'; onInput(); input.focus(); } }, 'Route +') : null,
        e.handover ? null : h('button', { class: 'btn small', onclick: () => { ws.handover = true; routeSelected([]); } }, 'Mark for handover'),
        h('button', { class: 'btn small', onclick: () => details(e.id) }, 'Details'),
      ) : null,
    );
  };

  async function details(eventId) {
    try {
      const d = await get(`/api/work/events/${eventId}`);
      const dlg = h('dialog', {},
        h('h2', {}, d.template?.label ?? d.event.category),
        h('p', {}, d.event.text),
        h('p', { class: 'small muted' }, `Recorded ${fmtDateTime(d.event.recordedAt)} by ${d.event.author} (${d.event.authorRole}). Source: ${d.event.collection === 'DIRECT' ? 'direct' : 'indirect'} collection.`),
        d.versions.length > 1 ? h('div', {}, h('h3', {}, 'Versions'), d.versions.map((v) => h('p', { class: 'small' }, `v${v.version} · ${titleCase(v.state)} · ${fmtDateTime(v.recordedAt)} · ${v.author}${v.amendmentReason ? ` · Reason: ${v.amendmentReason}` : ''}`, h('br'), v.text))) : null,
        d.routeHistory.length ? h('div', {}, h('h3', {}, 'Routing'), d.routeHistory.map((r, i) => h('p', { class: 'small' }, `${d.event.routes[i]?.label ?? 'Route'}: `, r.transitions.map((t) => `${titleCase(t.to_state)} ${fmtDateTime(t.at)}${t.actor ? ` (${t.actor})` : ''}`).join(' → ')))) : null,
        h('div', { class: 'row' },
          d.canAmend ? h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); openKey(d.event.key, d.event); } }, 'Amend') : null,
          d.canAmend ? h('button', { class: 'btn danger', onclick: async () => {
            const reason = await ask({ title: 'Mark entered in error', message: 'The entry stays visible in history, struck through.', label: 'Reason', minLength: 3, confirm: 'Mark in error' });
            if (!reason) return;
            try { await post(`/api/work/events/${eventId}/amend`, { enteredInError: true, reason }); dlg.close(); dlg.remove(); toast('Marked entered in error.'); if (ws.view) openView(ws.view); } catch (err) { showError(err); }
          } }, 'Entered in error') : null,
          h('button', { class: 'btn primary', onclick: () => { dlg.close(); dlg.remove(); } }, 'Close'),
        ),
      );
      document.body.append(dlg);
      dlg.showModal();
    } catch (err) { showError(err); }
  }

  const addButton = () => ws.data.canAdd && !ws.form
    ? h('button', { class: 'btn', onclick: () => { input.value = `${ws.data.canAdd} `; onInput(); } }, `Add with ${ws.data.canAdd}`)
    : null;

  const renderView = () => {
    const d = ws.data;
    switch (d.view.kind) {
      case 'events':
      case 'history':
      case 'handover':
        return h('div', { class: 'stack' }, addButton(),
          d.events.length ? d.events.map(entryItem) : h('div', { class: 'empty' }, `Nothing recorded in ${d.view.label} yet.`));
      case 'overview': return overview(d);
      case 'meds': return h('div', { class: 'stack' },
        restriction(d.prescribing, 'Prescribing'), restriction(d.administration, 'Administration recording'),
        d.medicines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Medicine', 'Dose', 'Route', 'Frequency', 'Indication', 'State', 'Prescriber'].map((c) => h('th', {}, c)))),
          h('tbody', {}, d.medicines.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.medicine)), h('td', {}, m.dose), h('td', {}, m.route), h('td', {}, m.frequency), h('td', {}, m.indication), h('td', {}, stateTag(m.state)), h('td', {}, m.prescriber)))),
        )) : h('div', { class: 'empty' }, 'No medicines recorded.'));
      case 'results': return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Test', 'Result', 'Range', 'Taken', 'State', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, d.results.map((r) => h('tr', {},
          h('td', {}, h('b', {}, r.test)),
          h('td', { class: r.flag ? `flag-${r.flag}` : '' }, `${r.value} ${r.units ?? ''}${r.flag ? ` ${r.flag}` : ''}`),
          h('td', {}, r.referenceRange),
          h('td', {}, fmtDateTime(r.performedAt)),
          h('td', {}, stateTag(r.state), r.reviewedBy ? h('div', { class: 'small muted' }, `${r.reviewedBy}`) : null),
          h('td', {}, d.canReview && r.state === 'AVAILABLE' ? h('button', { class: 'btn small', onclick: async () => {
            try { await post(`/api/work/results/${r.id}/review`); toast('Marked reviewed.'); openView('results'); } catch (err) { showError(err); }
          } }, 'Mark reviewed') : null),
        ))),
      ));
      case 'allergies': return d.allergies.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Type', 'Substance', 'Reaction', 'Severity', 'State', 'Recorded'].map((c) => h('th', {}, c)))),
        h('tbody', {}, d.allergies.map((a) => h('tr', {}, h('td', {}, titleCase(a.kind)), h('td', {}, a.substance ?? '—'), h('td', {}, a.reaction ?? ''), h('td', {}, a.severity ?? ''), h('td', {}, titleCase(a.state)), h('td', {}, `${fmtDate(a.recordedAt)} ${a.recordedBy ?? ''}`)))),
      )) : h('div', { class: 'empty' }, 'No allergies recorded. This is not the same as no known allergies.');
      case 'careplan': return carePlanPanel(personId, d, () => openView('careplan'));
      case 'referrals': return referralsPanel(personId, d, () => openView('referrals'));
      case 'appointments': return appointmentsPanel(personId, d, () => openView('appointments'));
      // Raising or resolving an alert changes the record banner, so the whole record redraws.
      case 'alerts': return alertsPanel(personId, d, () => go(`/work/patient/${personId}/alerts`));
      case 'tasks': return h('div', { class: 'stack' }, addButton(), d.tasks.length ? d.tasks.map((t) => h('div', { class: 'tile' },
        h('div', { class: 'spread' }, h('b', {}, t.description), stateTag(t.state)),
        h('div', { class: 'small muted' }, [t.dueAt ? `Due ${t.dueAt}` : null, `Assigned: ${t.assignedTo}`, `Created by ${t.createdBy}`].filter(Boolean).join(' · ')),
        t.outcome ? h('div', { class: 'small' }, `Outcome: ${t.outcome}`) : null,
      )) : h('div', { class: 'empty' }, 'No tasks.'), h('button', { class: 'link-btn', onclick: () => go('/work/tasks') }, 'Open all tasks'));
      case 'transfers': return transfersPanel(personId, d, () => openView('transfers'));
      case 'discharge': return dischargePanel(personId, d, () => openView('discharge'));
      case 'escalations': return escalationsPanel(personId, d, () => openView('escalations'));
      case 'consults': return consultationsPanel(personId, d, () => openView('consults'));
      case 'wounds': return woundsPanel(personId, d, () => openView('wounds'));
      case 'routes': return h('div', { class: 'stack' }, d.routes.length ? d.routes.map((r) => h('div', { class: 'tile' },
        h('div', { class: 'spread' }, h('b', {}, `→ ${r.destination}`), stateTag(r.state)),
        h('div', {}, r.text),
        r.amended ? h('span', { class: 'tag warn' }, 'Amended since it was sent') : null,
        h('div', { class: 'small muted' }, `${r.sender} · ${fmtDateTime(r.createdAt)}${r.requiresAcceptance ? ' · needs explicit acceptance' : ''}`),
      )) : h('div', { class: 'empty' }, 'Nothing has been routed from this record.'));
      default: return h('div');
    }
  };

  const restriction = (r, label) => r.decision === 'ALLOW' ? null
    : h('div', { class: 'notice' }, `${label}: ${r.decision}. ${r.reasons.join(' ')} (${r.ruleRefs.join(', ')})`);

  const overview = (d) => h('div', { class: 'stack' },
    h('div', { class: 'tiles' },
      d.latestObs ? h('div', { class: 'tile' }, h('h3', {}, 'Latest observations'), h('div', {}, d.latestObs.text), h('div', { class: 'small muted' }, `${fmtDateTime(d.latestObs.effectiveAt)} · ${d.latestObs.author}`)) : null,
      d.latestWeight ? h('div', { class: 'tile' }, h('h3', {}, 'Latest weight'), h('div', { class: 'big' }, d.latestWeight.text), h('div', { class: 'small muted' }, fmtDateTime(d.latestWeight.effectiveAt))) : null,
      d.activeMedicines !== null ? h('button', { class: 'tile', onclick: () => openView('meds') }, h('h3', {}, 'Active medicines'), h('div', { class: 'big' }, String(d.activeMedicines))) : null,
      d.unreviewedResults !== null ? h('button', { class: 'tile', onclick: () => openView('results') }, h('h3', {}, 'Results not yet reviewed'), h('div', { class: 'big' }, String(d.unreviewedResults))) : null,
      h('div', { class: 'tile' }, h('h3', {}, 'Open tasks'), h('div', { class: 'big' }, String(d.openTasks))),
      h('div', { class: 'tile' }, h('h3', {}, 'Marked for handover'), h('div', { class: 'big' }, String(d.handover))),
    ),
    d.carePlan.length ? h('div', { class: 'tile' }, h('h3', {}, 'Care plan'), d.carePlan.map((c) => h('div', {}, h('b', {}, `${c.need}: `), c.intervention))) : null,
    restriction(d.earlyWarning, 'Early-warning score'),
  );

  // Header with persistent allergy/safety banner ----------------------------------------
  const allergyBlock = () => {
    if (patient.allergyStatus === 'RECORDED') {
      const [first, ...rest] = patient.allergies;
      return h('div', { class: 'allergy' },
        h('button', { class: 'allergy-alert', onclick: () => openView('allergies') }, icon('alert'),
          h('span', {}, h('b', {}, first.kind === 'INTOLERANCE' ? 'INTOLERANCE' : 'ALLERGY'), first.substance, first.reaction ? ` (${first.reaction})` : '')),
        h('div', { class: 'allergy-note' }, rest.length ? `Also: ${rest.map((a) => a.substance).join(', ')}` : 'No other allergies recorded'),
      );
    }
    if (patient.allergyStatus === 'NO_KNOWN_ALLERGIES') return h('div', { class: 'allergy' }, h('div', { class: 'allergy-nka' }, 'No known allergies'));
    return h('div', { class: 'allergy' }, h('div', { class: 'allergy-none' }, 'Allergies not recorded'));
  };

  // Alerts staff have raised stay in view with the allergies, on every page of the record.
  const flags = () => {
    const block = allergyBlock();
    if (patient.alerts?.length) {
      block.append(h('button', { class: 'patient-alert', onclick: () => openView('alerts') }, icon('alerts'),
        h('span', {}, h('b', {}, patient.alerts.length === 1 ? patient.alerts[0].categoryLabel.toUpperCase() : `${patient.alerts.length} ALERTS`),
          patient.alerts.map((a) => a.title).join(' · '))));
    }
    return block;
  };

  const header = h('div', { class: 'card patient-header' },
    h('div', { class: 'who' },
      h('div', { class: 'logo' }, 'S'),
      h('div', {},
        h('h1', {}, patient.name, patient.preferredName ? ` (${patient.preferredName})` : ''),
        h('div', { class: 'ids' },
          patient.localId ? h('span', {}, patient.localId) : null,
          patient.nhi ? h('span', {}, `NHI ${patient.nhi.value}`) : null,
          patient.dateOfBirth ? h('span', {}, `DOB ${fmtDate(patient.dateOfBirth)} (${patient.age}y)`) : null,
        ),
        h('div', { class: 'ids' },
          patient.gender ? h('span', {}, patient.gender) : null,
          patient.ethnicity ? h('span', {}, patient.iwi ? `${patient.ethnicity} (${patient.iwi})` : patient.ethnicity) : null,
          patient.location ? h('span', {}, patient.location) : null,
        ),
        h('div', { class: 'row small' },
          patient.synthetic ? h('span', { class: 'synthetic' }, 'Synthetic record') : null,
          patient.relationship === 'EXCEPTIONAL' ? h('span', { class: 'tag danger' }, 'Exceptional access (audited)') : null,
          state.me.context.authority && !state.me.context.authority.current ? h('span', { class: 'tag danger' }, `Practising authority ${state.me.context.authority.status.toLowerCase()}: entries blocked`) : null,
        ),
      ),
    ),
    flags(),
  );

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Escape') { input.value = ''; onInput(); }
  });

  drawToggles();
  draw();
  drawSuggest();
  if (initialView && views.has(initialView)) openView(initialView);

  return h('div', {},
    header,
    h('div', { class: 'workstation' },
      destCol,
      h('section', { class: 'live', 'aria-label': 'Live Workstation' },
        h('div', { class: 'live-title paua' }, title, h('button', { class: 'btn small', onclick: () => go('/work/records') }, 'Close record')),
        body,
        h('div', { class: 'command' },
          h('div', { class: 'command-line' }, input, h('button', { class: 'btn primary', onclick: run }, 'Enter')),
          suggest, chips, toggles,
        ),
      ),
    ),
  );
}
