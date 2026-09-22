// The petty cash fund: balance, ledger and replenishments. Requests themselves live on the
// Petty Cash Requests screen; this view is about the money in the box.
export function createPettyCashView(ctx) {
  const { api, esc, money, amountField, readAmount, today, stamp, badge, toast, fail, openDialog, closeDialog, refresh } = ctx;
  const TYPE_LABELS = { opening: 'Opening fund', replenishment: 'Replenishment', disbursement: 'Disbursement', return: 'Return / reversal', adjustment: 'Adjustment' };
  let host = null, filters = { from: '', to: '', type: '' };

  const auth = () => ctx.auth;
  const boot = () => ctx.boot;
  const can = (...roles) => roles.includes(auth().user.role);

  async function render(target) {
    host = target;
    host.innerHTML = '<div class="loading">Loading the petty cash fund&hellip;</div>';
    let fund;
    try {
      const params = new URLSearchParams({ limit: '300' });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      fund = await api(`/petty-cash?${params}`);
    } catch (error) { fail(error); host.innerHTML = '<div class="empty">Could not load the fund.</div>'; return; }

    const opened = fund.entries.length > 0 || fund.balance !== 0;
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Fund control</div><h1>Petty Cash Fund</h1>
        <p class="muted">Every movement is a permanent ledger entry carrying its own running balance.</p></div>
      <div class="actions">
        ${!opened && can('admin') ? '<button class="primary" id="open-fund">Open the fund</button>' : ''}
        ${can('admin', 'approver', 'maker') ? '<button id="new-replenishment">Request replenishment</button>' : ''}
        ${can('admin') && opened ? '<button id="adjust">Record adjustment</button>' : ''}
      </div></div>

    <div class="module-grid">
      <section class="module"><div class="module-head"><div><h2>Balance on hand</h2>
        <p class="muted sub-note">${opened ? `As of the last of ${fund.total} ledger entries` : 'The fund has not been opened yet'}</p></div>
        <div class="lead">${money(fund.balance)}<small>Available</small></div></div>
        <div class="tiles">
          ${tile('Disbursed to date', money(total(fund.entries, 'out', 'disbursement')))}
          ${tile('Replenished to date', money(total(fund.entries, 'in', 'replenishment')))}
          ${tile('Returned to fund', money(total(fund.entries, 'in', 'return')))}
        </div></section>
      <section class="module"><div class="module-head"><h2>Replenishments</h2></div>
        <div class="scroll scroll-short">${fund.replenishments.length ? `<table><thead><tr><th>Reference</th><th>Status</th><th class="right">Amount</th><th></th></tr></thead><tbody>
          ${fund.replenishments.map(item => `<tr><td><span class="ref">${esc(item.number)}</span><small>${esc(item.requestedBy)} &middot; ${esc(item.requestedAt.slice(0, 10))}</small></td>
            <td>${badge(statusClass(item.status), item.status.replace(/^./, c => c.toUpperCase()))}</td>
            <td class="right">${money(item.amount)}</td>
            <td class="right">${replenishmentActions(item)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No replenishments recorded.</div>'}</div></section>
    </div>

    <section class="panel"><div class="panel-head"><div><h2>Petty Cash Ledger</h2>
        <p>Entries can never be edited or deleted. Corrections are recorded as separate reversals.</p></div>
      <button class="small" id="export">Export CSV</button></div>
      <div class="toolbar">
        <label>Type<select id="f-type"><option value="">All movements</option>
          ${Object.entries(TYPE_LABELS).map(([id, label]) => `<option value="${id}"${filters.type === id ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>From<input type="date" id="f-from" value="${esc(filters.from)}"></label>
        <label>To<input type="date" id="f-to" value="${esc(filters.to)}"></label>
        <button id="apply">Apply</button><button class="ghost" id="clear">Clear</button>
      </div>
      <div class="scroll">${fund.entries.length ? `<table><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Description</th>
          <th class="right">Amount in</th><th class="right">Amount out</th><th class="right">Running balance</th><th>Recorded</th></tr></thead><tbody>
        ${fund.entries.map(entry => `<tr><td>${esc(entry.entryDate)}</td><td><span class="ref">${esc(entry.reference)}</span></td>
          <td>${esc(TYPE_LABELS[entry.type] || entry.type)}</td><td>${esc(entry.description)}</td>
          <td class="right">${entry.in ? money(entry.in) : ''}</td><td class="right">${entry.out ? money(entry.out) : ''}</td>
          <td class="right"><strong>${money(entry.balance)}</strong></td>
          <td>${esc(entry.actor)}<small>${esc(stamp(entry.at))}</small></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><strong>The ledger is empty</strong>Open the fund to record its opening balance.</div>'}</div>
    </section>`;

    host.querySelector('#open-fund')?.addEventListener('click', openFund);
    host.querySelector('#new-replenishment')?.addEventListener('click', replenishmentDialog);
    host.querySelector('#adjust')?.addEventListener('click', adjustDialog);
    host.querySelector('#apply').addEventListener('click', () => {
      for (const key of Object.keys(filters)) filters[key] = host.querySelector(`#f-${key}`).value;
      render(host);
    });
    host.querySelector('#clear').addEventListener('click', () => { filters = { from: '', to: '', type: '' }; render(host); });
    host.querySelector('#export').addEventListener('click', () => {
      const params = new URLSearchParams();
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      window.open(`/api/reports/petty-cash-ledger.csv?${params}`, '_blank', 'noopener');
    });
    host.querySelectorAll('[data-replenishment]').forEach(button => button.addEventListener('click', () => decide(button.dataset.replenishment, button.dataset.act)));
  }

  const tile = (label, value) => `<div class="tile"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
  const total = (entries, side, type) => entries.filter(entry => entry.type === type).reduce((sum, entry) => sum + entry[side], 0);
  const statusClass = status => ({ requested: 'submitted', approved: 'approved', funded: 'paid', rejected: 'rejected' }[status] || 'draft');

  function replenishmentActions(item) {
    if (item.status === 'requested' && can('admin', 'approver')) {
      return `<button class="small primary" data-replenishment="${item.id}" data-act="approve">Approve</button>
        <button class="small danger" data-replenishment="${item.id}" data-act="reject">Reject</button>`;
    }
    if (item.status === 'approved' && can('admin', 'approver')) return `<button class="small primary" data-replenishment="${item.id}" data-act="fund">Record funding</button>`;
    if (item.status === 'funded') return `<small>Funded ${esc((item.fundedAt || '').slice(0, 10))}</small>`;
    return '';
  }

  async function decide(id, action) {
    if (action === 'fund') { fundDialog(id); return; }
    try { await api(`/replenishments/${id}/${action}`, {}); toast(`Replenishment ${action === 'approve' ? 'approved' : 'rejected'}.`); await refresh({ silent: true }); render(host); } catch (error) { fail(error); }
  }

  function simpleDialog(title, note, fields, onSubmit, submitLabel = 'Save') {
    const field = ([id, label, type, value]) => (type === 'textarea'
      ? `<label class="field full">${esc(label)}<textarea id="${id}"></textarea></label>`
      : type === 'number' ? `<label class="field">${esc(label)}${amountField(id, value)}</label>`
      : `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value ?? '')}"></label>`);
    openDialog(title, `${note ? `<div class="notice">${esc(note)}</div>` : ''}<div class="form-grid">${fields.map(field).join('')}</div>`,
      `<button id="cancel">Cancel</button><button class="primary" id="confirm">${esc(submitLabel)}</button>`);
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#confirm').addEventListener('click', async () => {
      const body = {};
      for (const [id, label, type] of fields) {
        const element = document.querySelector(`#${id}`);
        if (type === 'number') {
          const amount = readAmount(element.value);
          if (Number.isNaN(amount)) { toast(`${label}: enter the amount in figures, such as 1250.00`, true); element.focus(); return; }
          body[id] = amount;
          continue;
        }
        body[id] = element.value.trim();
      }
      try { await onSubmit(body); closeDialog(); await refresh({ silent: true }); render(host); } catch (error) { fail(error); }
    });
  }

  const openFund = () => simpleDialog('Open the petty cash fund',
    'This records the opening balance as the first ledger entry. It can only be done once; afterwards the fund grows only through approved replenishments.',
    [['entryDate', 'Date', 'date', today()], ['amount', 'Opening balance', 'number', 0], ['remarks', 'Remarks', 'textarea']],
    async body => { await api('/petty-cash/open', body); toast('Petty cash fund opened.'); }, 'Open fund');

  const replenishmentDialog = () => simpleDialog('Request a replenishment',
    'The fund increases only when the funding is recorded after approval.',
    [['entryDate', 'Date', 'date', today()], ['amount', 'Amount requested', 'number', ''], ['source', 'Source', 'text', ''], ['remarks', 'Remarks', 'textarea']],
    async body => { await api('/replenishments', body); toast('Replenishment requested.'); }, 'Submit request');

  const fundDialog = id => simpleDialog('Record the funding',
    'Recording the funding increases the available petty cash balance immediately.',
    [['entryDate', 'Date funded', 'date', today()], ['remarks', 'Remarks', 'textarea']],
    async body => { await api(`/replenishments/${id}/fund`, body); toast('Funding recorded. The fund balance has increased.'); }, 'Record funding');

  const adjustDialog = () => {
    simpleDialog('Record a fund adjustment',
      'An adjustment is a separate ledger entry. Historical balances are never rewritten.',
      [['entryDate', 'Date', 'date', today()], ['amount', 'Amount', 'number', ''], ['reason', 'Reason', 'textarea']],
      async body => {
        const direction = document.querySelector('#direction')?.value || 'in';
        await api('/petty-cash/adjust', { ...body, direction });
        toast('Adjustment recorded.');
      }, 'Record adjustment');
    const anchor = document.querySelector('#amount').closest('.field');
    anchor.insertAdjacentHTML('afterend', '<label class="field">Direction<select id="direction"><option value="in">Cash into the fund</option><option value="out">Cash out of the fund</option></select></label>');
  };

  return { render };
}
