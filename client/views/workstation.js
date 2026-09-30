import { h, icon, mount } from '../lib/dom.js';
import { get, post, put, requestKey } from '../lib/api.js';
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
import { communicationsPanel } from './communications.js';
import { monitoringPanel } from './monitoring.js';
import { restrictionsPanel } from './restrictions.js';
import { dietPanel } from './diets.js';
import { equipmentPanel } from './equipment.js';
import { locationPanel } from './locations.js';
import { leavePanel } from './leave.js';
import { preferencesPanel } from './preferences.js';
import { capacityPanel } from './capacity.js';
import { supportPanel } from './whanau.js';
import { accessPanel } from './access.js';
import { externalPanel } from './external.js';
import { codingPanel } from './coding.js';
import { reportsPanel } from './reports.js';
import { questionnairesPanel } from './questionnaires.js';
import { functionPanel } from './function.js';
import { usualPanel } from './usual.js';
import { acuityPanel } from './acuity.js';
import { deteriorationPanel } from './deterioration.js';
import { incidentsPanel } from './incidents.js';
import { deathPanel } from './death.js';
import { problemsPanel } from './problems.js';
import { symptomsPanel } from './symptoms.js';
import { interventionsPanel } from './interventions.js';
import { treatmentPlansPanel } from './treatmentplans.js';
import { pathwaysPanel } from './pathways.js';
import { checklistsPanel } from './checklists.js';
import { recommendationsPanel } from './recommendations.js';
import { requirementsPanel } from './requirements.js';
import { careDuePanel } from './caredue.js';
import { recallsPanel } from './recalls.js';
import { followupsPanel } from './followups.js';
import { surveillancePanel } from './surveillance.js';
import { screeningPanel } from './screening.js';
import { infectionsPanel } from './infections.js';
import { antimicrobialsPanel } from './antimicrobials.js';
import { sitechecksPanel } from './sitechecks.js';
import { readinessPanel } from './readiness.js';
import { variancesPanel } from './variances.js';
import { declinedPanel } from './declined.js';
import { prioritiesPanel } from './priorities.js';
import { identityPanel } from './identity.js';
import { endBreakGlass } from './breakglass.js';
import { teamPanel } from './team.js';
import { state, go } from '../app.js';
import { groupViews } from '../lib/groups.js';

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
    embeds: [],          // screens shown inside this one ({ code, label, data })
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

  // Entering records made on paper while SHIFT was down: each one goes in at the time on the paper,
  // with who wrote it, and is marked as coming from paper.
  const paper = state.backEntry?.personId === personId ? state.backEntry : null;
  const localTime = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const paperBy = h('input', { type: 'text', 'aria-label': 'Who wrote it on paper', placeholder: 'e.g. Kate Morgan, RN' });
  const paperRef = h('input', { type: 'text', 'aria-label': 'Paper sheet', placeholder: 'e.g. Obs chart 2 of 3 (optional)' });
  const paperStrip = paper ? h('div', { class: 'paper-entry stack' },
    h('div', { class: 'small' }, h('b', {}, 'Entering from paper. '), `SHIFT was down ${fmtDateTime(paper.startedAt)} to ${fmtDateTime(paper.restoredAt)}. Type the .key, set From to the time written on the paper, and say who wrote it.`),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Who wrote it on paper', paperBy), h('label', { class: 'field' }, 'Paper sheet', paperRef)),
    h('div', {}, h('button', { class: 'btn small', onclick: () => { state.backEntry = null; go('/work/downtime'); } }, 'Finished entering from paper')),
  ) : null;
  if (paper) {
    ws.showPeriod = true;
    from.value = localTime(paper.startedAt);
  }

  // Record destinations: every record area this role may open, down the side.
  const subject = state.me.context.subjectLabel;
  // A break opportunity after '/' keeps labels like Intake/Output whole words.
  const destLabel = (v) => (v.code === 'overview' ? `${subject} Overview` : v.label.replaceAll('/', '/\u200b'));
  const drawDestinations = () => {
    mount(destCol,
      groupViews(config.views.filter((v) => v.shown || ws.view === v.code), (v) => v.code).map((g) => [
        h('div', { class: 'dest-group' }, g.title),
        g.items.map((v) => h('button', { class: `dest${ws.view === v.code ? ' active' : ''}${v.shown ? '' : ' extra'}`, onclick: () => openView(v.code) }, h('span', {}, destLabel(v)))),
      ]),
      h('button', { class: `dest${ws.view === null ? ' active' : ''}`, onclick: () => { ws.view = null; ws.data = null; ws.embeds = []; ws.form = null; ws.selected = null; draw(); input.focus(); } }, h('span', {}, 'Live Workstation')),
      config.views.some((v) => !v.shown) ? h('button', { class: 'dest dest-add', onclick: screensDialog }, h('span', {}, '+ Add a screen')) : null,
    );
  };
  // Add a screen this workstation is authorised for but the department does not show by default,
  // or take an added one away again. This only changes the side list, never authority.
  const saveScreen = async (body) => {
    const { views: order } = await put('/api/work/screens', body);
    const byCode = new Map(config.views.map((v) => [v.code, v]));
    config.views = order.flatMap(({ id, hidden }) => (byCode.has(id) ? [{ ...byCode.get(id), shown: !hidden }] : []));
    drawDestinations();
  };
  function screensDialog() {
    const list = h('div', { class: 'stack' });
    const close = () => { dlg.close(); dlg.remove(); };
    const row = (v, label, body) => h('div', { class: 'spread screen-row' }, h('span', {}, destLabel(v)),
      h('button', { class: 'btn small', onclick: async () => { try { await saveScreen(body); fill(); } catch (err) { showError(err); } } }, label));
    const fill = () => {
      const hidden = config.views.filter((v) => !v.shown);
      const added = config.views.filter((v) => v.shown && !v.own);
      mount(list,
        hidden.length ? hidden.map((v) => row(v, 'Add', { code: v.code, shown: true })) : h('div', { class: 'empty' }, 'Every screen you can use is already showing.'),
        added.length ? h('h3', {}, 'Screens you added') : null,
        added.map((v) => row(v, 'Remove', { code: v.code, shown: false })),
      );
    };
    const dlg = h('dialog', {}, h('div', { class: 'stack' },
      h('h2', {}, 'Add a screen'),
      h('p', { class: 'small muted' }, `Your ${state.me.context.roleLabel} workstation shows your department's own screens. Add any other screen you need here. You can also type ?name to open one without adding it.`),
      list,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: close }, 'Done'),
        h('button', { class: 'btn', onclick: async () => { try { await saveScreen({ reset: true }); fill(); } catch (err) { showError(err); } } }, 'Back to department default')),
    ));
    dlg.addEventListener('cancel', () => dlg.remove());
    fill();
    document.body.append(dlg);
    dlg.showModal();
  }

  const keepActiveVisible = () => {
    const active = destCol.querySelector('.active');
    if (active && destCol.scrollHeight > destCol.clientHeight) active.scrollIntoView({ block: 'nearest' });
  };

  async function openView(code) {
    if (!views.has(code)) return toast(`?${code} is not part of your workstation.`, 'error');
    try {
      const inner = (config.embeds?.[code] ?? []).filter((c) => views.has(c));
      const [data, ...embedded] = await Promise.all([code, ...inner].map((c) => get(`/api/work/patients/${personId}/views/${c}`)));
      ws.data = data;
      ws.embeds = inner.map((c, i) => ({ code: c, label: views.get(c).label, data: embedded[i] }));
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
          downtime: paper ? { id: paper.downtimeId, paperBy: paperBy.value, paperRef: paperRef.value } : null,
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
    if (ws.view && ws.data) content.push(renderView(), ws.embeds.map((x) => h('section', { class: 'stack embed' }, h('h3', { class: 'section-title' }, x.label), renderView(x.data))));
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
        e.fromPaper ? h('span', { class: 'tag warn' }, 'From paper') : null,
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
        d.event.fromPaper ? h('p', { class: 'small notice' }, `Entered afterwards from a paper record made while SHIFT was down, written by ${d.event.fromPaper.by}${d.event.fromPaper.ref ? ` (${d.event.fromPaper.ref})` : ''}.`) : null,
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

  const renderView = (d = ws.data) => {
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
        h('thead', {}, h('tr', {}, ['Type', 'Substance', 'Reaction', 'Severity', 'State', 'Where from', 'Recorded'].map((c) => h('th', {}, c)))),
        h('tbody', {}, d.allergies.map((a) => h('tr', {}, h('td', {}, titleCase(a.kind)), h('td', {}, a.substance ?? '—'), h('td', {}, a.reaction ?? ''), h('td', {}, a.severity ?? ''),
          h('td', {}, titleCase(a.state), a.certainty === 'SUSPECTED' ? h('div', { class: 'small muted' }, 'Not yet confirmed') : null), h('td', { class: 'small' }, a.source ?? ''), h('td', {}, `${fmtDate(a.recordedAt)} ${a.recordedBy ?? ''}`)))),
      )) : h('div', { class: 'empty' }, 'No allergies recorded. This is not the same as no known allergies.');
      case 'careplan': return carePlanPanel(personId, d, () => openView('careplan'));
      case 'referrals': return referralsPanel(personId, d, () => openView('referrals'));
      case 'appointments': return appointmentsPanel(personId, d, () => openView('appointments'));
      // Raising or resolving an alert changes the record banner, so the whole record redraws.
      case 'communications': return communicationsPanel(personId, d, () => openView('communications'));
      case 'monitoring': return monitoringPanel(personId, d, () => openView('monitoring'));
      case 'support': return supportPanel(personId, d, () => go(`/work/patient/${personId}/support`));
      case 'reported': return reportsPanel(personId, d, () => go(`/work/patient/${personId}/reported`));
      case 'team': return teamPanel(personId, d, () => go(`/work/patient/${personId}/team`));
      case 'incidents': return incidentsPanel(personId, d, () => go(`/work/patient/${personId}/incidents`));
      case 'interventions': return interventionsPanel(personId, d, () => go(`/work/patient/${personId}/interventions`));
      case 'treatmentplans': return treatmentPlansPanel(personId, d, () => go(`/work/patient/${personId}/treatmentplans`));
      case 'pathways': return pathwaysPanel(personId, d, () => go(`/work/patient/${personId}/pathways`));
      case 'checklists': return checklistsPanel(personId, d, () => go(`/work/patient/${personId}/checklists`));
      case 'recommendations': return recommendationsPanel(personId, d, () => go(`/work/patient/${personId}/recommendations`));
      case 'requirements': return requirementsPanel(personId, d, () => go(`/work/patient/${personId}/requirements`));
      case 'caredue': return careDuePanel(personId, d, () => go(`/work/patient/${personId}/caredue`));
      case 'recalls': return recallsPanel(personId, d, () => go(`/work/patient/${personId}/recalls`));
      case 'followups': return followupsPanel(personId, d, () => go(`/work/patient/${personId}/followups`));
      case 'surveillance': return surveillancePanel(personId, d, () => go(`/work/patient/${personId}/surveillance`));
      case 'screening': return screeningPanel(personId, d, () => go(`/work/patient/${personId}/screening`));
      case 'infections': return infectionsPanel(personId, d, () => go(`/work/patient/${personId}/infections`));
      case 'antimicrobials': return antimicrobialsPanel(personId, d, () => go(`/work/patient/${personId}/antimicrobials`));
      case 'sitechecks': return sitechecksPanel(personId, d, () => go(`/work/patient/${personId}/${ws.view}`));
      case 'readiness': return readinessPanel(personId, d, () => go(`/work/patient/${personId}/${ws.view}`));
      case 'variances': return variancesPanel(personId, d, () => go(`/work/patient/${personId}/variances`));
      case 'declined': return declinedPanel(personId, d, () => go(`/work/patient/${personId}/declined`));
      case 'priorities': return prioritiesPanel(personId, d, () => go(`/work/patient/${personId}/${ws.view}`));
      case 'identity': return identityPanel(personId, d, (to = personId) => go(`/work/patient/${to}/identity`));
      case 'symptoms': return symptomsPanel(personId, d, () => go(`/work/patient/${personId}/symptoms`));
      case 'problems': return problemsPanel(personId, d, () => go(`/work/patient/${personId}/problems`), addButton());
      case 'death': return deathPanel(personId, d, () => go(`/work/patient/${personId}/death`));
      case 'deterioration': return deteriorationPanel(personId, d, () => go(`/work/patient/${personId}/deterioration`));
      case 'acuity': return acuityPanel(personId, d, () => go(`/work/patient/${personId}/acuity`));
      case 'usual': return usualPanel(personId, d, () => go(`/work/patient/${personId}/usual`));
      case 'function': return functionPanel(personId, d, () => go(`/work/patient/${personId}/function`));
      case 'instruments': return questionnairesPanel(personId, d, () => go(`/work/patient/${personId}/instruments`));
      case 'coding': return codingPanel(personId, d, () => go(`/work/patient/${personId}/coding`));
      case 'external': return externalPanel(personId, d, () => go(`/work/patient/${personId}/external`));
      case 'access': return accessPanel(personId, d, () => go(`/work/patient/${personId}/access`));
      case 'capacity': return capacityPanel(personId, d, () => go(`/work/patient/${personId}/capacity`));
      case 'preferences': return preferencesPanel(personId, d, () => go(`/work/patient/${personId}/preferences`));
      case 'leave': return leavePanel(personId, d, () => go(`/work/patient/${personId}/absence`));
      case 'location': return locationPanel(personId, d, () => go(`/work/patient/${personId}/location`));
      case 'equipment': return equipmentPanel(personId, d, () => openView('equipment'));
      case 'diet': return dietPanel(personId, d, () => go(`/work/patient/${personId}/diet`));
      case 'restrictions': return restrictionsPanel(personId, d, () => go(`/work/patient/${personId}/restrictions`));
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
    if (patient.death) {
      const x = patient.death;
      block.append(h('button', { class: 'patient-death', onclick: () => openView('death') }, icon('death'),
        h('span', {}, h('b', {}, `DIED ${fmtDateTime(x.diedAt).toUpperCase()}`),
          x.state === 'IDENTIFIED' ? 'Not yet verified' : x.outstanding ? `${x.outstanding} thing${x.outstanding === 1 ? '' : 's'} still to do` : x.state === 'CLOSED' ? 'Stay ended' : 'Ready to end their stay')));
    }
    if (patient.deterioration) {
      const x = patient.deterioration;
      block.append(h('button', { class: `patient-deterioration det-${x.state.toLowerCase()}`, onclick: () => openView('deterioration') }, icon('deterioration'),
        h('span', {}, h('b', {}, `GETTING WORSE: ${x.stateLabel.toUpperCase()}`), x.change)));
    }
    if (patient.acuity) {
      const a = patient.acuity;
      block.append(h('button', { class: `patient-acuity acuity-${a.level.toLowerCase()}`, onclick: () => openView('acuity') }, icon('acuity'),
        h('span', {}, h('b', {}, `STATUS: ${a.label.toUpperCase()}`),
          `${a.changeLabel} · ${a.overdue ? `look again was due ${fmtDateTime(a.reviewDue)}` : `look again by ${fmtDateTime(a.reviewDue)}`}`)));
    }
    if (patient.alerts?.length) {
      block.append(h('button', { class: 'patient-alert', onclick: () => openView('alerts') }, icon('alerts'),
        h('span', {}, h('b', {}, patient.alerts.length === 1 ? patient.alerts[0].categoryLabel.toUpperCase() : `${patient.alerts.length} ALERTS`),
          patient.alerts.map((a) => a.title).join(' · '))));
    }
    if (patient.checkExceptions?.length) {
      block.append(h('button', { class: 'patient-checks', onclick: () => openView('checklists') }, icon('checklists'),
        h('span', {}, h('b', {}, 'CHECK NOT MET'), patient.checkExceptions.join(' · '))));
    }
    if (patient.precautions?.length) {
      block.append(h('div', { class: 'patient-isolation' }, icon('infections'),
        h('span', {}, h('b', {}, 'ISOLATION'), patient.precautions.join(' · '))));
    }
    if (patient.resistantOrganisms?.length) {
      block.append(h('button', { class: 'patient-resistant', onclick: () => openView('infections') }, icon('infections'),
        h('span', {}, h('b', {}, 'RESISTANT ORGANISM'), patient.resistantOrganisms.join(' · '))));
    }
    if (patient.siteDiscrepancies?.length) {
      block.append(h('button', { class: 'patient-site', onclick: () => openView('sitechecks') }, icon('sitechecks'),
        h('span', {}, h('b', {}, 'SITE DOES NOT MATCH'), patient.siteDiscrepancies.join(' · '))));
    }
    if (patient.declinedCare?.length) {
      block.append(h('button', { class: 'patient-declined', onclick: () => openView('declined') }, icon('declined'),
        h('span', {}, h('b', {}, 'DECLINED CARE'), patient.declinedCare.join(' · '))));
    }
    if (patient.breakGlass) {
      block.append(h('div', { class: 'patient-identity patient-breakglass' }, icon('breakglass'),
        h('span', { class: 'grow' }, h('b', {}, 'BREAK-GLASS ACCESS'), `Open until ${patient.breakGlass.until}. Everything you open is recorded and reviewed.`),
        h('button', { class: 'btn small danger', onclick: () => endBreakGlass(patient.breakGlass.id) }, 'End access now')));
    }
    if (patient.mergedInto) {
      block.append(h('button', { class: 'patient-identity', onclick: () => go(`/work/patient/${patient.mergedInto.id}/identity`) }, icon('arrivals'),
        h('span', {}, h('b', {}, 'MERGED'), `This record was merged into ${patient.mergedInto.name}'s. Open their record.`)));
    }
    if (patient.possibleDuplicate) {
      block.append(h('button', { class: 'patient-identity', onclick: () => openView('identity') }, icon('duplicates'),
        h('span', {}, h('b', {}, 'POSSIBLE DUPLICATE RECORD'), 'Another record may be the same person. Check both before relying on either.')));
    }
    if (patient.identityUnresolved) {
      block.append(h('button', { class: 'patient-identity', onclick: () => openView('identity') }, icon('arrivals'),
        h('span', {}, h('b', {}, 'IDENTITY NOT CONFIRMED'), 'Temporary identity. Check any details you record, and identify them as soon as you can.')));
    }
    if (patient.careOverdue?.length) {
      block.append(h('button', { class: 'patient-caredue', onclick: () => openView('caredue') }, icon('caredue'),
        h('span', {}, h('b', {}, 'CARE OVERDUE'), patient.careOverdue.join(' · '))));
    }
    if (patient.pathwaysDue?.length) {
      block.append(h('button', { class: 'patient-pathways', onclick: () => openView('pathways') }, icon('pathways'),
        h('span', {}, h('b', {}, 'PATHWAY STEP OVERDUE'), patient.pathwaysDue.join(' · '))));
    }
    if (patient.interventionsDue?.length) {
      block.append(h('button', { class: 'patient-interventions', onclick: () => openView('interventions') }, icon('interventions'),
        h('span', {}, h('b', {}, 'DUE NOW'), patient.interventionsDue.join(' · '))));
    }
    if (patient.symptoms?.length) {
      const high = patient.symptoms.some((x) => x.score >= 7 || x.overdue);
      block.append(h('button', { class: `patient-symptoms${high ? ' high' : ''}`, onclick: () => openView('symptoms') }, icon('symptoms'),
        h('span', {}, h('b', {}, patient.symptoms.some((x) => x.overdue) ? 'SYMPTOMS: LOOK AGAIN NOW' : 'SYMPTOMS'),
          patient.symptoms.map((x) => `${x.label} ${x.score ?? '?'}/10`).join(' · '))));
    }
    if (patient.problems?.length) {
      block.append(h('button', { class: 'patient-problems', onclick: () => openView('problems') }, icon('problems'),
        h('span', {}, h('b', {}, 'PROBLEMS'), patient.problems.join(' · '))));
    }
    if (patient.usual?.length) {
      block.append(h('button', { class: 'patient-usual', onclick: () => openView('usual') }, icon('usual'),
        h('span', {}, h('b', {}, 'DIFFERENT FROM USUAL'), patient.usual.join(' · '))));
    }
    if (patient.function) {
      block.append(h('button', { class: 'patient-function', onclick: () => openView('function') }, icon('function'),
        h('span', {}, h('b', {}, patient.function.overdue ? 'HELP NEEDED (REASSESSMENT OVERDUE)' : 'HELP NEEDED'), patient.function.help.join(' · '))));
    }
    if (patient.instruments?.length) {
      block.append(h('button', { class: 'patient-instrument', onclick: () => openView('instruments') }, icon('instruments'),
        h('span', {}, h('b', {}, 'QUESTIONNAIRE SAFETY FLAG: NOT YET FOLLOWED UP'), patient.instruments.map((x) => `${x.code}: ${x.flags.join(' ')}`).join(' · '))));
    }
    if (patient.external?.length) {
      block.append(h('button', { class: 'patient-external', onclick: () => openView('external') }, icon('external'),
        h('span', {}, h('b', {}, `FROM OTHER PROVIDERS: ${patient.external.length} TO REVIEW`), patient.external.map((x) => `${x.title} (${x.sourceOrg})`).join(' · '))));
    }
    if (patient.access?.length) {
      block.append(h('button', { class: 'patient-access', onclick: () => openView('access') }, icon('access'),
        h('span', {}, h('b', {}, 'COMMUNICATION'), patient.access.map((a) => a.label).join(' · '))));
    }
    if (patient.whanau?.length) {
      block.append(h('button', { class: 'patient-whanau', onclick: () => openView('support') }, icon('support'),
        h('span', {}, h('b', {}, 'WHĀNAU: LIMITS AND AUTHORITY'),
          patient.whanau.map((w) => `${w.name}: ${[w.limits, w.authority ? `${w.authority} (document seen)` : null].filter(Boolean).join('; ')}`).join(' · '))));
    }
    if (patient.capacity?.length) {
      block.append(h('button', { class: 'patient-capacity', onclick: () => openView('capacity') }, icon('capacity'),
        h('span', {}, h('b', {}, 'LACKS CAPACITY FOR A DECISION'), patient.capacity.map((c) => `${c.decision} (${fmtDate(c.assessedAt)})`).join(' · '))));
    }
    if (patient.preferences) {
      block.append(h('button', { class: 'patient-pref', onclick: () => openView('preferences') }, icon('preferences'),
        h('span', {}, h('b', {}, patient.preferences.count === 1 ? 'PREFERENCE' : `${patient.preferences.count} PREFERENCES`),
          patient.preferences.first.join(' · '))));
    }
    if (patient.leave) {
      const l = patient.leave;
      block.append(h('button', { class: `patient-leave${l.late ? ' late' : ''}`, onclick: () => openView('absence') }, icon('absence'),
        h('span', {}, h('b', {}, l.state === 'NOT_RETURNED' ? 'NOT BACK FROM LEAVE' : l.late ? 'LATE BACK FROM LEAVE' : 'AWAY ON LEAVE'),
          `${l.kindLabel}${l.destination ? ` to ${l.destination}` : ''} · due back ${fmtDateTime(l.returnBy)}`)));
    }
    if (patient.diet) {
      block.append(h('button', { class: 'patient-diet', onclick: () => openView('diet') }, icon('diet'),
        h('span', {}, h('b', {}, 'MODIFIED DIET'), `${patient.diet.texture} · drinks ${patient.diet.drinks}`)));
    }
    if (patient.restrictions?.length) {
      block.append(h('button', { class: 'patient-restriction', onclick: () => openView('restrictions') }, icon('restrictions'),
        h('span', {}, h('b', {}, patient.restrictions.length === 1 ? patient.restrictions[0].label.toUpperCase() : `${patient.restrictions.length} RESTRICTIONS`),
          patient.restrictions.map((r) => r.detail).join(' · '))));
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
        patient.team ? h('button', { class: 'team-line', onclick: () => openView('team') },
          patient.team.named.map((n) => h('span', {}, h('span', { class: 'muted' }, `${n.label} `), n.name,
            n.cover ? h('span', { class: 'muted' }, ` (covered by ${n.cover}${n.until ? ` until ${fmtDate(n.until)}` : ''})`) : null)),
          patient.team.missing.map((m) => h('span', { class: 'team-gap' }, `${m}: not named`))) : null,
        h('div', { class: 'row small' },
          patient.synthetic ? h('span', { class: 'synthetic' }, 'Synthetic record') : null,
          patient.relationship === 'EXCEPTIONAL' ? h('span', { class: 'tag danger' }, 'Break-glass access (audited)') : null,
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
          paperStrip, suggest, chips, toggles,
        ),
      ),
    ),
  );
}
