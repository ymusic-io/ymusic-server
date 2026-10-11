let DATA;
const fmt = (n) => n == null ? '—' : n.toLocaleString('en-US');
const pct = (n, of) => n == null || !of ? '—' : (100 * n / of).toFixed(1) + '%';
const el = (tag, attrs = {}, text) => {
  const node = document.createElementNS(tag === 'svg' || attrs.svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs)) if (k !== 'svg') node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


// A day-indexed line/bar chart with a hover readout. series: [{key, label, color, type}]
function timeChart(target, rows, series, height = 220) {
  const box = document.getElementById(target);
  if (series.length > 1) {
    box.insertAdjacentHTML('beforeend', '<div class="legend">' +
      series.map((sr) => `<span><i style="background:var(${sr.color})"></i>${sr.label}</span>`).join('') + '</div>');
  }
  const W = Math.max(280, box.clientWidth), H = height, L = 44, R = 8, T = 8, B = 22;
  // Four gridline steps of 1/2/5 × 10^k, so every label is a round integer.
  const max = Math.max(4, ...rows.flatMap((r) => series.map((sr) => r[sr.key])));
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const tick = [1, 2, 5, 10].map((m) => m * mag).find((t) => t >= raw);
  const nice = tick * 4;
  const x = (i) => L + (rows.length <= 1 ? 0 : i * (W - L - R) / (rows.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / nice);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let k = 0; k <= 4; k++) {
    const v = nice * k / 4;
    svg.append(el('line', { svg: 1, x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)' }));
    svg.append(el('text', { svg: 1, x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v)));
  }
  const step = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(W / 90))));
  rows.forEach((r, i) => {
    const last = rows.length - 1;
    if ((i % step === 0 && last - i >= step / 2) || i === last) {
      const anchor = i === 0 ? 'start' : i === last ? 'end' : 'middle';
      svg.append(el('text', { svg: 1, x: x(i), y: H - 4, 'text-anchor': anchor }, r.day.slice(5)));
    }
  });
  const slot = (W - L - R) / Math.max(1, rows.length);
  for (const sr of series) {
    if (sr.type === 'bar') {
      rows.forEach((r, i) => {
        const h = (H - T - B) - (y(r[sr.key]) - T);
        svg.append(el('rect', { svg: 1, x: x(i) - slot * 0.35, y: y(r[sr.key]), width: slot * 0.7, height: Math.max(0, h),
          fill: `var(${sr.color})`, rx: 1.5 }));
      });
    } else {
      const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[sr.key]).toFixed(1)}`).join('');
      svg.append(el('path', { svg: 1, d, fill: 'none', stroke: `var(${sr.color})`, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    }
  }
  const cursor = el('line', { svg: 1, y1: T, y2: H - B, stroke: 'var(--muted)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
  svg.append(cursor);
  const wrap = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tip' });
  wrap.append(svg, tip);
  box.append(wrap);
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const vx = (ev.clientX - rect.left) * W / rect.width;
    const i = Math.min(rows.length - 1, Math.max(0, Math.round((vx - L) / ((W - L - R) / Math.max(1, rows.length - 1)))));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${rows[i].day}</b><br>` +
      series.map((sr) => `<span style="color:var(${sr.color})">■</span> ${sr.label}: ${fmt(rows[i][sr.key])}`).join('<br>');
    tip.style.display = 'block';
    const px = x(i) * rect.width / W;
    tip.style.left = Math.min(px + 12, rect.width - tip.offsetWidth) + 'px';
    tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cursor.setAttribute('visibility', 'hidden'); });
}

function table(target, head, body) {
  const box = document.getElementById(target);
  if (!body.length) { box.innerHTML = '<div class="empty">No data yet</div>'; return; }
  box.innerHTML = '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
    body.map((cells) => '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}

const shortDay = (iso) => new Date(Date.parse(iso + 'T00:00:00Z'))
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Firebase "User retention": share of devices active on day N after their first day.
function retentionCurve(target, days) {
  const box = document.getElementById(target);
  const points = days.filter((d) => d.eligible > 0);
  if (!points.length) { box.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const W = Math.max(280, box.clientWidth), H = 240, L = 16, R = 48, T = 8, B = 34;
  const last = days.length - 1;
  const x = (n) => L + n * (W - L - R) / last;
  const y = (share) => T + (H - T - B) * (1 - share);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let k = 0; k <= 5; k++) {
    svg.append(el('line', { svg: 1, x1: L, x2: W - R, y1: y(k / 5), y2: y(k / 5), stroke: 'var(--line)' }));
    svg.append(el('text', { svg: 1, x: W - R + 6, y: y(k / 5) + 4 }, `${k * 20}.0%`));
  }
  for (let n = 0; n <= last; n += 7) {
    svg.append(el('text', { svg: 1, x: x(n), y: H - 18, 'text-anchor': 'middle' }, 'Day'));
    svg.append(el('text', { svg: 1, x: x(n), y: H - 4, 'text-anchor': 'middle' }, n));
  }
  const share = (d) => d.active / d.eligible;
  svg.append(el('path', { svg: 1, fill: 'none', stroke: 'var(--c1)', 'stroke-width': 2, 'stroke-linejoin': 'round',
    d: points.map((d, i) => `${i ? 'L' : 'M'}${x(d.day).toFixed(1)},${y(share(d)).toFixed(1)}`).join('') }));
  const cursor = el('line', { svg: 1, y1: T, y2: H - B, stroke: 'var(--muted)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
  svg.append(cursor);
  const wrap = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tip' });
  wrap.append(svg, tip);
  box.append(wrap);
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const n = Math.round(((ev.clientX - rect.left) * W / rect.width - L) / ((W - L - R) / last));
    const d = points.find((p) => p.day === Math.min(points.at(-1).day, Math.max(0, n)));
    cursor.setAttribute('x1', x(d.day)); cursor.setAttribute('x2', x(d.day)); cursor.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>Day ${d.day}</b><br>${pct(d.active, d.eligible)} · ${fmt(d.active)} of ${fmt(d.eligible)} devices`;
    tip.style.display = 'block';
    tip.style.left = Math.min(x(d.day) * rect.width / W + 12, rect.width - tip.offsetWidth) + 'px';
    tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cursor.setAttribute('visibility', 'hidden'); });
}

// Firebase "User activity by cohort": shade = share of the cohort active in that week; hover for numbers.
function cohortGrid(target, cohorts) {
  const box = document.getElementById(target);
  if (!cohorts.some((c) => c.size)) { box.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const weeks = cohorts[0].weeks.length;
  const cell = (c, w) => {
    const n = c.weeks[w];
    if (n == null || !c.size) return '<td class="cell"></td>';
    const share = n / c.size;
    return `<td class="cell" style="background:color-mix(in srgb, var(--c1) ${Math.round(15 + 85 * share)}%, transparent)"` +
      ` title="${shortDay(c.from)} – ${shortDay(c.to)}, week ${w}: ${pct(n, c.size)} (${fmt(n)} of ${fmt(c.size)})"></td>`;
  };
  // All users: each week averaged over the cohorts that have reached it, weighted by size.
  const all = Array.from({ length: weeks }, (_, w) => {
    const reached = cohorts.filter((c) => c.weeks[w] != null);
    return pct(reached.reduce((a, c) => a + c.weeks[w], 0), reached.reduce((a, c) => a + c.size, 0));
  });
  box.innerHTML = '<table class="cohorts"><thead><tr><th></th>' +
    Array.from({ length: weeks }, (_, w) => `<th>Week ${w}</th>`).join('') + '</tr></thead><tbody>' +
    '<tr class="all"><td class="who">All users</td>' + all.map((a) => `<td>${a}</td>`).join('') + '</tr>' +
    [...cohorts].reverse().map((c) => `<tr><td class="who" title="${fmt(c.size)} devices">${shortDay(c.from)} – ${shortDay(c.to)}</td>` +
      c.weeks.map((_, w) => cell(c, w)).join('') + '</tr>').join('') +
    '</tbody></table>';
}

// label, count, share bar — for the 30-day breakdowns.
function shares(target, rows, label) {
  if (rows == null) {
    document.getElementById(target).innerHTML = '<div class="empty">Only for ranges ending today</div>';
    return;
  }
  const total = rows.reduce((sum, r) => sum + r.devices, 0);
  table(target, ['', 'Devices', 'Share', ''], rows.map((r) => [
    esc(label(r)), fmt(r.devices), pct(r.devices, total),
    `<div class="bar" style="width:${Math.max(2, 100 * r.devices / total)}px"></div>`,
  ]));
}

function drawCharts() {
  for (const id of ['active', 'new', 'launches', 'curve']) document.getElementById(id).replaceChildren();
retentionCurve('curve', DATA.retention.daily);
timeChart('active', DATA.daily, [
  { key: 'mau', label: 'Active 30 days', color: '--c2' },
  { key: 'wau', label: 'Active 7 days', color: '--c3' },
  { key: 'dau', label: 'Active 1 day', color: '--c1' },
], 260);
timeChart('new', DATA.daily, [{ key: 'new_devices', label: 'New devices', color: '--c3', type: 'bar' }]);
timeChart('launches', DATA.daily, [{ key: 'launches', label: 'Launches', color: '--c4', type: 'bar' }]);
}
function render() {
  const summary = DATA.summary;
  document.getElementById('kpis').innerHTML = [
    ['Active today', summary.dau], ['Active 7 days', summary.wau], ['Active 30 days', summary.mau],
    ['New today', summary.new_today], ['Launches today', summary.launches_today], ['Devices ever', summary.devices],
  ].map(([label, value]) => `<div class="kpi"><span class="muted">${label}</span><b>${fmt(value)}</b></div>`).join('');

  const period = DATA.period;
  const span = (Date.parse(period.to) - Date.parse(period.from)) / 86400000 + 1;
  document.getElementById('from').value = period.from;
  document.getElementById('to').value = period.to;
  const osSelect = document.getElementById('os');
  osSelect.innerHTML = '<option value="">All platforms</option>' +
    DATA.oses.map((os) => `<option${os === DATA.os ? ' selected' : ''}>${esc(os)}</option>`).join('');
  const osParam = DATA.os ? `&os=${encodeURIComponent(DATA.os)}` : '';
  const before = (days) => new Date(Date.parse(summary.today) - (days - 1) * 86400000).toISOString().slice(0, 10);
  document.getElementById('presets').innerHTML = [[7, '7d'], [30, '30d'], [90, '90d'], [365, '1y']].map(([days, label]) => {
    const on = period.to === summary.today && period.from === before(days) ? ' class="on"' : '';
    return `<a${on} href="?from=${before(days)}&to=${summary.today}${osParam}">${label}</a>`;
  }).join(' ');
  document.getElementById('period').innerHTML = [
    [`Active ${period.from} – ${period.to}${period.active == null ? ' · ranges ending today only' : ''}`, period.active], ['New in range', period.new_devices], ['Launches in range', period.launches],
    ['Days', span],
  ].map(([label, value]) => `<div class="kpi"><span class="muted">${label}</span><b>${fmt(value)}</b></div>`).join('');

  drawCharts();

  cohortGrid('cohorts', DATA.retention.cohorts);
  document.getElementById('curveFoot').textContent =
    `Last ${DATA.retention.daily.length} days ending ${shortDay(DATA.retention.end)}`;
  document.getElementById('cohortFoot').textContent =
    `${DATA.retention.cohorts.length} weeks ending ${shortDay(DATA.retention.end)}`;
  shares('platforms', DATA.platforms, (r) => r.os || '—');
  shares('versions', DATA.versions, (r) => `${r.os || '—'} ${r.version}`);
  shares('countries', DATA.countries, (r) => r.country);
}

// The query string is the state: ?from=&to=&os=, as the API takes it.
async function load() {
  const error = document.getElementById('error');
  let res;
  try {
    // From origin, not relative: a page opened as user:pass@host would pass the credentials on,
    // and fetch refuses a URL that carries them.
    res = await fetch(new URL('/api/analytics' + location.search, location.origin));
  } catch (failure) {
    error.textContent = `Could not load analytics: ${failure.message}`;
    error.hidden = false;
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    error.textContent = `Could not load analytics: ${body.error ?? body.message ?? res.status}`;
    error.hidden = false;
    return;
  }
  error.hidden = true;
  DATA = await res.json();
  render();
}

function navigate(search) {
  history.pushState(null, '', search);
  load();
}

const form = document.getElementById('range');
form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) if (value) params.set(key, value);
  navigate('?' + params);
});
document.getElementById('os').addEventListener('change', () => form.requestSubmit());
document.getElementById('presets').addEventListener('click', (ev) => {
  const link = ev.target.closest('a');
  if (!link) return;
  ev.preventDefault();
  navigate(link.getAttribute('href'));
});
addEventListener('popstate', load);

// ---- App config: append-only versions, the newest is live ----

async function api(path, options = {}) {
  const res = await fetch(new URL(path, location.origin), options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body;
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let configState; // { live, history }
const configBodies = new Map(); // version id → config
// Postgres stores jsonb keys in its own order; show the top level in the documented one.
const KEY_ORDER = ['flags', 'flagsByOs', 'releases', 'engineJs', 'playerJs'];
const pretty = (config) => JSON.stringify(
  Object.fromEntries(Object.entries(config).sort(([a], [b]) => KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b))), null, 2);
const when = (iso) => new Date(iso.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toLocaleString();

function configMessage(text, ok) {
  const box = document.getElementById('configMsg');
  box.textContent = text;
  box.className = 'msg ' + (ok ? 'ok' : 'bad');
}

async function loadConfig() {
  try {
    configState = await api('/api/config');
  } catch (failure) {
    configMessage(`Could not load the config: ${failure.message}`, false);
    return;
  }
  const { live, history } = configState;
  configBodies.set(live.id, live.config);
  document.getElementById('liveMeta').textContent =
    `· v${live.id} · ${when(live.created_at)}${live.author ? ' · ' + live.author : ''}`;
  document.getElementById('configText').value = pretty(live.config);
  renderHistory();
}

function renderHistory() {
  const { live, history } = configState;
  table('history', ['Version', 'Saved', 'By', 'Note', ''], history.map((v, i) => [
    `v${v.id}${v.id === live.id ? '<span class="badge">live</span>' : ''}`,
    esc(when(v.created_at)),
    esc(v.author ?? '—'),
    esc(v.note ?? '') + (v.reverted_from ? ` <span class="muted">(restores v${v.reverted_from})</span>` : ''),
    `<button data-diff="${v.id}" data-prev="${history[i + 1]?.id ?? ''}">Diff</button>` +
      (v.id === live.id ? '' : ` <button data-revert="${v.id}">Revert to v${v.id}</button>`),
  ]));
  document.querySelector('#history table')?.classList.add('history');
}

async function versionConfig(id) {
  if (!configBodies.has(id)) configBodies.set(id, (await api(`/api/config/${id}`)).config);
  return configBodies.get(id);
}

// Line diff of the pretty-printed JSON (LCS; configs are small).
function lineDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push([' ', a[i]]); i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) lines.push(['-', a[i++]]);
    else lines.push(['+', b[j++]]);
  }
  return lines;
}

function showDiff(title, before, after) {
  const lines = lineDiff(before, after);
  document.getElementById('diffTitle').textContent = title;
  document.getElementById('diffBody').innerHTML = lines.some(([kind]) => kind !== ' ')
    ? lines.map(([kind, text]) => `<span class="${kind === '+' ? 'add' : kind === '-' ? 'del' : ''}">${kind} ${esc(text)}</span>`).join('')
    : '<span class="muted">No differences.</span>';
  const card = document.getElementById('diffCard');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function editedConfig() {
  try {
    return JSON.parse(document.getElementById('configText').value);
  } catch (failure) {
    configMessage(`Not valid JSON: ${failure.message}`, false);
    return undefined;
  }
}

document.getElementById('configDiffEdit').addEventListener('click', () => {
  const edited = editedConfig();
  if (edited === undefined) return;
  configMessage('', true);
  showDiff(`Your edit vs live v${configState.live.id}`, pretty(configState.live.config), pretty(edited));
});

document.getElementById('configSave').addEventListener('click', async () => {
  const edited = editedConfig();
  if (edited === undefined) return;
  const note = document.getElementById('configNote').value;
  try {
    const saved = await postJson('/api/config', { config: edited, note, baseId: configState.live.id });
    document.getElementById('configNote').value = '';
    document.getElementById('diffCard').hidden = true;
    await loadConfig();
    configMessage(`Saved as v${saved.id}. The API serves it within a minute.`, true);
  } catch (failure) {
    const details = failure.body?.errors ? '\n• ' + failure.body.errors.join('\n• ') : '';
    const hint = failure.status === 409 ? '\nReload the page to see the newer version; your edit is still in the box.' : '';
    configMessage(`Not saved: ${failure.message}${details}${hint}`, false);
  }
});

document.getElementById('history').addEventListener('click', async (ev) => {
  const button = ev.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.diff) {
      const id = Number(button.dataset.diff), prev = button.dataset.prev ? Number(button.dataset.prev) : null;
      const after = pretty(await versionConfig(id));
      const before = prev ? pretty(await versionConfig(prev)) : '';
      showDiff(prev ? `v${prev} → v${id}` : `v${id} (first version)`, before, after);
      return;
    }
    // Revert takes two clicks: the first arms the button, the second appends the old version.
    if (!button.classList.contains('armed')) {
      for (const other of document.querySelectorAll('#history button.armed')) {
        other.classList.remove('armed');
        other.textContent = `Revert to v${other.dataset.revert}`;
      }
      button.classList.add('armed');
      button.textContent = `Confirm revert to v${button.dataset.revert}`;
      return;
    }
    const saved = await postJson(`/api/config/${button.dataset.revert}/revert`, { baseId: configState.live.id });
    await loadConfig();
    configMessage(`Reverted: v${saved.id} restores v${saved.reverted_from}. The API serves it within a minute.`, true);
  } catch (failure) {
    configMessage(`${failure.message}${failure.status === 409 ? ' — reload the page.' : ''}`, false);
  }
});

// One page for every path; the path picks the view.
const VIEWS = { '/': 'home', '/analytics': 'analytics', '/config': 'config' };
const view = VIEWS[location.pathname] ?? 'home';
for (const name of Object.values(VIEWS)) document.getElementById('view-' + name).hidden = name !== view;

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => DATA && drawCharts(), 150); });

if (view === 'analytics') load();
if (view === 'config') loadConfig();
