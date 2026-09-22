// Bank Records: the official passbook, transcribed line by line. Entries stay correctable,
// because a transcription typo should be fixable — every correction is tracked instead.
export function createBankView(ctx) {
  const { api, esc, cash, amountField, readAmount, today, stamp, toast, fail, openDialog, closeDialog, refresh } = ctx;
  let host = null, filters = { accountId: '', from: '', to: '', text: '' };
  // Every amount on the passbook is shown in the currency of the account it belongs to.
  const amount = (value, row) => cash(value, row.currencySymbol, row.currencyDecimals);

  const auth = () => ctx.auth;
  const boot = () => ctx.boot;

  async function render(target) {
    host = target;
    host.innerHTML = '<div class="loading">Loading bank records&hellip;</div>';
    let data;
    try {
      const params = new URLSearchParams({ limit: '300' });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      data = await api(`/bank?${params}`);
    } catch (error) { fail(error); host.innerHTML = '<div class="empty">Could not load the bank records.</div>'; return; }

    const canEncode = boot().canEncodeBankRecords;
    const usable = data.accounts.filter(a => a.active);
    const opened = usable.filter(a => a.opened);
    const unopened = usable.filter(a => !a.opened);
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Passbook</div><h1>Bank Records</h1>
        <p class="muted">${data.total} entr${data.total === 1 ? 'y' : 'ies'}${data.totals.map(t => ` &middot; ${esc(t.currency)}: withdrawals ${cash(t.debit, t.symbol, t.decimals)}, deposits ${cash(t.credit, t.symbol, t.decimals)}`).join('')}</p></div>
      <div class="actions">${canEncode ? `<button id="import"${data.accounts.length ? '' : ' disabled title="Add a bank account first"'}>Import from Excel</button>
        <button id="open-account"${unopened.length ? '' : ' disabled title="Every account already has its beginning balance"'}>Beginning balance</button>
        <button class="primary" id="new"${opened.length ? '' : ' disabled title="Enter an account\'s beginning balance first"'}>Encode transaction</button>` : ''}</div></div>
      ${!data.accounts.length ? `<div class="notice">There are no bank accounts yet.${boot().canManageBankAccounts ? ' Add a bank and an account under <strong>Bank Accounts</strong> first.' : ' Ask an administrator to add one under Bank Accounts.'}</div>`
        : canEncode && !opened.length ? '<div class="notice">Enter an account\'s <strong>beginning balance</strong> before encoding its transactions. It is typed in by hand, and it is the only balance figure anyone ever enters - every balance after it is worked out by the system from the deposits and withdrawals.</div>'
        : canEncode && unopened.length ? `<div class="notice">${unopened.length} account${unopened.length === 1 ? '' : 's'} still ${unopened.length === 1 ? 'has' : 'have'} no beginning balance and cannot be encoded against yet: ${unopened.map(a => esc(a.account)).join(', ')}.</div>` : ''}
      ${data.rows.some(row => row.derived) ? '<div class="notice stop">A beginning balance below was worked out by the system when balances became automatic, not entered by anyone. Open it and confirm the figure against the passbook.</div>' : ''}

      ${data.balances.length ? `<div class="module-grid bank-balances">${data.balances.map(item => `<section class="module">
        <div class="module-head"><div><h2>${esc(item.account || 'Unnamed account')}</h2>
          <p class="muted sub-note">${esc(item.bankName)} &middot; balance as of ${esc(item.asOf)}</p></div>
          <div class="lead">${cash(item.balance, item.symbol, item.decimals)}<small>${esc(item.currency)} balance</small></div></div></section>`).join('')}</div>` : ''}

      <section class="panel">
        <div class="toolbar">
          <label class="grow">Search<input id="f-text" value="${esc(filters.text)}" placeholder="Particulars, check number or remarks"></label>
          <label>Account<select id="f-accountId"><option value="">All accounts</option>
            ${data.accounts.map(item => `<option value="${esc(item.id)}"${filters.accountId === item.id ? ' selected' : ''}>${esc(item.account)} (${esc(item.currency)})</option>`).join('')}</select></label>
          <label>From<input type="date" id="f-from" value="${esc(filters.from)}"></label>
          <label>To<input type="date" id="f-to" value="${esc(filters.to)}"></label>
          <button id="apply">Apply</button><button class="ghost" id="clear">Clear</button>
        </div>
        <div class="scroll">${data.rows.length ? table(data.rows) : `<div class="empty"><strong>No bank transactions encoded yet</strong>${!canEncode ? 'Entries encoded from the passbook will appear here.' : opened.length ? 'Use Encode transaction to copy the first passbook line in.' : 'Start with Beginning balance, then encode the passbook lines that follow it.'}</div>`}</div>
        <div class="module-foot"><span>Entries are never deleted. A wrong line is voided and stays on file.</span>
          <span>Every correction records who changed what, and when.</span></div>
      </section>`;

    host.querySelector('#new')?.addEventListener('click', () => form(null, data.accounts));
    host.querySelector('#open-account')?.addEventListener('click', () => openingForm(null, data.accounts));
    host.querySelector('#import')?.addEventListener('click', () => importDialog());
    host.querySelector('#apply').addEventListener('click', () => {
      for (const key of Object.keys(filters)) filters[key] = host.querySelector(`#f-${key}`).value;
      render(host);
    });
    host.querySelector('#clear').addEventListener('click', () => { filters = { accountId: '', from: '', to: '', text: '' }; render(host); });
    host.querySelector('#f-text').addEventListener('keydown', event => { if (event.key === 'Enter') host.querySelector('#apply').click(); });
    host.querySelectorAll('[data-record]').forEach(row => row.addEventListener('click', () => detail(row.dataset.record, data.accounts)));
  }

  const table = rows => `<table><thead><tr><th>Date</th><th>Check No.</th><th>Particulars</th>
      <th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead><tbody>
    ${rows.map(row => `<tr class="clickable${row.voided ? ' voided' : ''}" data-record="${row.id}">
      <td>${esc(row.entryDate)}</td>
      <td><span class="ref">${esc(row.reference || '\u2014')}</span></td>
      <td>${esc(row.description)}
        <small>${esc(row.opening ? (row.derived ? 'Beginning balance - worked out by the system, confirm it' : 'Beginning balance') : row.type)} &middot; ${esc(row.account)} (${esc(row.currency)}) &middot; encoded by ${esc(row.encodedBy)} ${esc(stamp(row.encodedAt))}${row.updatedBy ? ` &middot; corrected by ${esc(row.updatedBy)}` : ''}</small>
        ${row.voided ? `<small class="has-comments">VOIDED: ${esc(row.voidReason)}</small>` : ''}${row.remarks ? `<small>${esc(row.remarks)}</small>` : ''}</td>
      <td class="right">${row.debit ? amount(row.debit, row) : ''}</td>
      <td class="right">${row.credit ? amount(row.credit, row) : ''}</td>
      <td class="right">${row.voided ? '—' : `<strong>${amount(row.balance, row)}</strong>`}</td></tr>`).join('')}
  </tbody></table>`;

  const accountOptions = accounts => accounts.map(item => ({ value: item.id, label: `${item.account} (${item.currency})` }));

  const FIELDS = (record, accounts) => [
    ['accountId', 'Bank account', 'select', accountOptions(accounts), record?.accountId || accounts[0]?.id],
    ['entryDate', 'Transaction date', 'date', null, record?.entryDate || today()],
    ['type', 'Transaction type', 'select', (boot().bankTypes || []).map(value => ({ value, label: value })), record?.type || 'Deposit'],
    ['reference', 'Check No.', 'text', null, record?.reference || ''],
    ['description', 'Particulars', 'particulars', null, record?.description || ''],
    ['debit', 'Debit', 'amount', null, record?.debit ?? 0],
    ['credit', 'Credit', 'amount', null, record?.credit ?? 0],
    ['remarks', 'Remarks / notes', 'textarea', null, record?.remarks || ''],
  ];
  const OPENING_FIELDS = (record, accounts) => [
    ['accountId', 'Bank account', 'select', accountOptions(accounts), record?.accountId || accounts[0]?.id],
    ['entryDate', 'As of date', 'date', null, record?.entryDate || today()],
    ['balance', 'Beginning balance', 'amount', null, record?.balance ?? 0],
    ['remarks', 'Remarks / notes', 'textarea', null, record?.remarks || ''],
  ];

  const field = ([id, label, type, options, value]) => {
    if (type === 'textarea' || type === 'particulars') {
      return `<label class="field full${type === 'particulars' ? ' particulars' : ''}">${esc(label)}<textarea id="${id}">${esc(value || '')}</textarea></label>`;
    }
    if (type === 'amount') return `<label class="field">${esc(label)}${amountField(id, value)}</label>`;
    if (type === 'select') return `<label class="field">${esc(label)}<select id="${id}">${(options || [])
      .map(option => `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label>`;
    return `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value ?? '')}"></label>`;
  };
  const collect = async (fields, url, done) => {
    const body = {};
    for (const [id, label, type] of fields) {
      const element = document.querySelector(`#${id}`);
      if (type === 'amount') {
        const value = readAmount(element.value);
        // Said here rather than by the server, so the figure is still on screen to correct.
        if (Number.isNaN(value)) { toast(`${label}: enter the amount in figures, such as 1250.00`, true); element.focus(); return; }
        body[id] = value;
        continue;
      }
      body[id] = element.value.trim();
    }
    try {
      await api(url, body);
      closeDialog(); toast(done);
      await refresh({ silent: true });
      await render(host);
    } catch (error) { fail(error); }
  };

  // The beginning balance: typed in by hand, once per account, before anything can be
  // encoded against it.
  function openingForm(record = null, accounts = []) {
    const choices = record
      ? [{ id: record.accountId, account: record.account, currency: record.currency }]
      : accounts.filter(a => a.active && !a.opened);
    if (!choices.length) { toast('Every account already has a beginning balance.', true); return; }
    const fields = OPENING_FIELDS(record, choices);
    openDialog(record ? `Beginning balance of ${record.account}` : 'Beginning balance',
      `<div class="notice">The balance the passbook shows before the first transaction you are encoding. It is entered by hand, and it is the only balance anyone enters: every later balance is worked out from it.${record ? ' Correcting it re-works every balance after it.' : ''}${record?.derived ? ' <strong>This figure was worked out by the system, not entered by anyone - check it against the passbook and save it.</strong>' : ''}</div>
       <div class="form-grid">${fields.map(field).join('')}</div>`,
      `<button id="cancel">Cancel</button><button class="primary" id="save">${record ? 'Save beginning balance' : 'Set beginning balance'}</button>`);
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#save').addEventListener('click', () => collect(fields, record ? `/bank/${record.id}` : '/bank/open',
      record ? 'Beginning balance corrected. Later balances have been re-worked.' : 'Beginning balance set. You can now encode transactions.'));
  }

  function form(record, accounts = []) {
    if (record?.opening) { openingForm(record, accounts); return; }
    const choices = accounts.filter(a => a.active && a.opened);
    if (!choices.length) { toast('Enter an account\'s beginning balance first.', true); return; }
    const fields = FIELDS(record, choices);
    openDialog(record ? `Correct bank entry ${record.reference || record.entryDate}` : 'Encode bank transaction',
      `<div class="notice">Copy the line as the passbook shows it. A line is either a withdrawal or a deposit; the running balance is worked out for you.${record ? ' Every correction is recorded against this entry with the old and new values, and later balances are re-worked.' : ''}</div>
       <div class="form-grid">${fields.map(field).join('')}</div>`,
      `<button id="cancel">Cancel</button><button class="primary" id="save">${record ? 'Save correction' : 'Encode entry'}</button>`);
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#save').addEventListener('click', () => collect(fields, record ? `/bank/${record.id}` : '/bank',
      `Bank entry ${record ? 'corrected' : 'encoded'}.`));
  }

  async function detail(id, accounts) {
    let record;
    try { record = await api(`/bank/${id}`); } catch (error) { fail(error); return; }
    openDialog(`Bank entry · ${record.entryDate}${record.reference ? ` · ${record.reference}` : ''}`, `
      ${record.voided ? `<div class="notice stop"><span class="stamp">VOIDED</span> &nbsp; ${esc(record.voidReason)}</div>` : ''}
      <dl class="detail-grid">
        <div><dt>Transaction date</dt><dd>${esc(record.entryDate)}</dd></div>
        <div><dt>Check No.</dt><dd>${esc(record.reference || '—')}</dd></div>
        <div><dt>Transaction type</dt><dd>${esc(record.type)}</dd></div>
        <div><dt>Bank account</dt><dd>${esc(record.account || '—')}<small>${esc(record.bankName)} &middot; ${esc(record.accountName)}</small></dd></div>
        <div><dt>Currency</dt><dd>${esc(record.currency)}</dd></div>
        <div><dt>Debit</dt><dd>${record.debit ? amount(record.debit, record) : '—'}</dd></div>
        <div><dt>Credit</dt><dd>${record.credit ? amount(record.credit, record) : '—'}</dd></div>
        <div><dt>${record.opening ? 'Beginning balance' : 'Running balance'}</dt><dd>${record.voided ? '—<small class="muted"> a voided line is out of the running balance</small>'
          : `${amount(record.balance, record)}${record.opening ? (record.derived ? '<small class="muted"> worked out by the system - confirm it</small>' : '<small class="muted"> entered by hand</small>') : '<small class="muted"> worked out by the system</small>'}`}</dd></div>
        <div><dt>Encoded by</dt><dd>${esc(record.encodedBy)}</dd></div>
        <div><dt>Date and time encoded</dt><dd>${esc(stamp(record.encodedAt))}</dd></div>
        <div><dt>Particulars</dt><dd>${esc(record.description)}</dd></div>
        <div><dt>Remarks / notes</dt><dd>${esc(record.remarks || '—')}</dd></div>
        ${record.updatedBy ? `<div><dt>Last corrected</dt><dd>${esc(record.updatedBy)} &middot; ${esc(stamp(record.updatedAt))}</dd></div>` : ''}
      </dl>
      <h3 class="section-gap">Change history</h3>
      <ul class="history">${record.history.map(entry => `<li><strong>${esc(entry.detail)}</strong>
        <time>${esc(stamp(entry.at))} &middot; ${esc(entry.actor)}</time></li>`).join('')}</ul>`,
    `${boot().canEncodeBankRecords && !record.voided ? '<button id="edit">Correct entry</button>' : ''}
      ${boot().canVoidBankRecords && !record.voided ? '<button class="danger" id="void">Void entry</button>' : ''}
      <button id="close">Close</button>`);
    document.querySelector('#close').addEventListener('click', closeDialog);
    document.querySelector('#edit')?.addEventListener('click', () => form(record, accounts));
    document.querySelector('#void')?.addEventListener('click', () => voidEntry(record));
  }

  function voidEntry(record) {
    openDialog('Void bank entry',
      '<div class="notice">The entry stays on file, marked VOIDED, and drops out of the balances and totals. Nothing is deleted.</div><div class="form-grid"><label class="field full">Reason<textarea id="reason"></textarea></label></div>',
      '<button id="back">Back</button><button class="primary danger" id="confirm">Void entry</button>');
    document.querySelector('#back').addEventListener('click', () => detail(record.id, []));
    document.querySelector('#confirm').addEventListener('click', async () => {
      try {
        await api(`/bank/${record.id}/void`, { reason: document.querySelector('#reason').value.trim() });
        closeDialog(); toast('Entry voided.');
        await refresh({ silent: true });
        await render(host);
      } catch (error) { fail(error); }
    });
  }

  // ---------------------------------------------------------------- bulk import
  //
  // Three steps, deliberately: take the template, upload the filled file, then confirm what
  // the preview says would happen. Nothing is written by the first two.

  const readFile = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });

  function importDialog() {
    openDialog('Import bank records from Excel',
      `<div class="notice">For encoding a passbook you already hold on paper. Take the template, fill in the
        <strong>${esc('Beginning Balances')}</strong> and <strong>Transactions</strong> sheets, then upload it here.
        There is no Balance column: the running balance is worked out from the movements, and the only balance
        you enter is the beginning one.</div>
      <div class="form-grid">
        <label class="field full">Step 1 - the template
          <button id="template" class="ghost">Download the Excel template</button></label>
        <label class="field full">Step 2 - the filled file
          <input type="file" id="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      </div>
      <p class="muted sub-note">The template's dropdowns list the bank accounts this system actually holds, so an
        account cannot be mistyped. Nothing is imported until you have seen what would be added.</p>`,
      '<button id="cancel">Cancel</button><button class="primary" id="check" disabled>Check the file</button>');
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#template').addEventListener('click', () => window.open('/api/bank/template', '_blank', 'noopener'));
    const picker = document.querySelector('#file');
    const check = document.querySelector('#check');
    picker.addEventListener('change', () => { check.disabled = !picker.files.length; });
    check.addEventListener('click', async () => {
      const file = picker.files[0];
      if (!file) return;
      check.disabled = true; check.textContent = 'Reading\u2026';
      try {
        const content = await readFile(file);
        const plan = await api('/bank/import/preview', { name: file.name, content });
        previewDialog(plan, { name: file.name, content });
      } catch (error) { fail(error); check.disabled = false; check.textContent = 'Check the file'; }
    });
  }

  function previewDialog(plan, payload) {
    const totals = plan.summary.map(item => `<tr>
      <td><strong>${esc(item.account)}</strong><small>${esc(item.bankName)} &middot; ${esc(item.currency)}</small></td>
      <td>${item.opening === null ? `<small class="muted">${item.alreadyOpen ? 'already open' : 'no beginning balance'}</small>`
        : `<strong>${cash(item.opening, item.symbol, item.decimals)}</strong><small>as of ${esc(item.openingDate)}</small>`}</td>
      <td class="right">${item.lines}</td>
      <td>${item.from ? `${esc(item.from)}<small>to ${esc(item.to)}</small>` : '\u2014'}</td>
      <td class="right">${cash(item.debit, item.symbol, item.decimals)}</td>
      <td class="right">${cash(item.credit, item.symbol, item.decimals)}</td></tr>`).join('');

    openDialog(`Import ${esc(plan.fileName)}`,
      `${plan.ready
        ? `<div class="notice">Nothing has been written yet. This is what the file would add.</div>`
        : `<div class="notice stop"><strong>${plan.problemCount} row${plan.problemCount === 1 ? '' : 's'} cannot be read, so nothing will be imported.</strong>
            Fix them in the spreadsheet and upload it again. A file is imported whole or not at all.</div>`}

      ${plan.summary.length ? `<table><thead><tr><th>Account</th><th>Beginning balance</th>
          <th class="right">Lines</th><th>Dates</th><th class="right">Debits</th><th class="right">Credits</th></tr></thead>
        <tbody>${totals}</tbody></table>` : ''}

      ${plan.problems.length ? `<h3 class="section-gap">Problems</h3>
        <ul class="history">${plan.problems.map(problem => `<li><strong>${esc(problem.message)}</strong>
          <time>${esc(problem.sheet)} &middot; row ${problem.row}</time></li>`).join('')}
        </ul>${plan.problemCount > plan.problems.length ? `<p class="muted sub-note">and ${plan.problemCount - plan.problems.length} more.</p>` : ''}` : ''}

      ${plan.duplicates.length ? `<h3 class="section-gap">Already on file</h3>
        <div class="notice">${plan.duplicates.length} row${plan.duplicates.length === 1 ? '' : 's'} match an entry this account
          already holds on the same date, for the same amount and reference. A passbook can legitimately repeat a line, so
          these are not refused - but if you have imported this file before, importing it again will duplicate them.</div>
        <ul class="history">${plan.duplicates.slice(0, 20).map(item => `<li><strong>${esc(item.description)}</strong>
          <time>row ${item.row} &middot; ${esc(item.entryDate)} &middot; ${esc(item.account)}</time></li>`).join('')}</ul>` : ''}`,
      `<button id="back">Back</button>${plan.ready
        ? `<button class="primary" id="commit">Import ${plan.lines} transaction${plan.lines === 1 ? '' : 's'}</button>` : ''}`);

    document.querySelector('#back').addEventListener('click', () => importDialog());
    document.querySelector('#commit')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true; button.textContent = 'Importing\u2026';
      try {
        const result = await api('/bank/import', payload);
        closeDialog();
        toast(`Imported ${result.lines} transaction${result.lines === 1 ? '' : 's'}${result.openings ? ` and ${result.openings} beginning balance${result.openings === 1 ? '' : 's'}` : ''}.`);
        await refresh({ silent: true });
        await render(host);
      } catch (error) { fail(error); button.disabled = false; button.textContent = 'Import'; }
    });
  }

  return { render };
}
