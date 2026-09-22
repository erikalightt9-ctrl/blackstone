// One renderer for every report: the server returns { title, columns, rows, totals } and the
// same shape downloads as CSV, so adding a report needs no change here.
export function createReportsView(ctx) {
  const { api, esc, money, fail } = ctx;
  let host = null, current = 'payment-register', filters = { from: '', to: '', kind: '', status: '', categoryId: '', requester: '' };

  const boot = () => ctx.boot;

  async function render(target) {
    host = target;
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Reporting</div><h1>Reports</h1>
        <p class="muted">Filter, review on screen, then print or export to CSV.</p></div>
      <div class="actions"><button id="print">Print</button><button class="primary" id="export">Export CSV</button></div></div>
      <section class="panel">
        <div class="toolbar">
          <label>Report<select id="report">${boot().reports.map(report => `<option value="${report.id}"${report.id === current ? ' selected' : ''}>${esc(report.title)}</option>`).join('')}</select></label>
          <label>Module<select id="f-kind"><option value="">Both modules</option>
            ${boot().kinds.map(item => `<option value="${item.id}"${filters.kind === item.id ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
          <label>Status<select id="f-status"><option value="">All statuses</option>
            ${boot().statuses.map(status => `<option value="${status.id}"${filters.status === status.id ? ' selected' : ''}>${esc(status.label)}</option>`).join('')}</select></label>
          <label>Requester<input id="f-requester" value="${esc(filters.requester)}"></label>
          <label>From<input type="date" id="f-from" value="${esc(filters.from)}"></label>
          <label>To<input type="date" id="f-to" value="${esc(filters.to)}"></label>
          <button id="run">Run report</button>
        </div>
        <div id="result"><div class="loading">Running the report&hellip;</div></div>
      </section>`;
    host.querySelector('#report').addEventListener('change', event => { current = event.target.value; run(); });
    host.querySelector('#run').addEventListener('click', run);
    host.querySelector('#print').addEventListener('click', () => window.print());
    host.querySelector('#export').addEventListener('click', () => window.open(`/api/reports/${current}.csv?${params()}`, '_blank', 'noopener'));
    run();
  }

  function params() {
    for (const key of Object.keys(filters)) filters[key] = host.querySelector(`#f-${key}`)?.value || '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
    return search;
  }

  async function run() {
    const result = host.querySelector('#result');
    result.innerHTML = '<div class="loading">Running the report&hellip;</div>';
    let report;
    try { report = await api(`/reports/${current}?${params()}`); } catch (error) { fail(error); result.innerHTML = '<div class="empty">The report could not be run.</div>'; return; }
    const cell = (row, column) => (column.money ? money(row[column.key]) : esc(row[column.key] ?? ''));
    result.innerHTML = `<div class="panel-head"><div><h2>${esc(report.title)}</h2>
        <p>${report.rows.length} row${report.rows.length === 1 ? '' : 's'} &middot; generated ${esc(new Date(report.generatedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))}</p></div>
        <div>${Object.entries(report.totals).map(([key, value]) => `<span class="badge">${esc(key)}: ${typeof value === 'number' && key !== 'count' ? money(value) : esc(value)}</span>`).join(' ')}</div></div>
      <div class="scroll">${report.rows.length ? `<table><thead><tr>${report.columns.map(column => `<th class="${column.money ? 'right' : ''}">${esc(column.label)}</th>`).join('')}</tr></thead>
        <tbody>${report.rows.map(row => `<tr>${report.columns.map(column => `<td class="${column.money ? 'right' : ''}">${cell(row, column)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>Nothing to report</strong>No transactions match the filters you selected.</div>'}</div>`;
  }

  return { render };
}
