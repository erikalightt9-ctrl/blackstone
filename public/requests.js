// Payment Requests and Petty Cash Requests share this screen: the same list, the same
// form and the same detail view, differing only in the actions the workflow allows.
export function createRequestsView(ctx) {
  const { api, esc, money, amountField, readAmount, today, stamp, badge, toast, fail, openDialog, closeDialog, refresh, categoriesFor } = ctx;
  const KIND = { payment: { title: 'Payment Requests', eyebrow: 'Disbursement by check or transfer' }, petty_cash: { title: 'Petty Cash Requests', eyebrow: 'Cash released from the petty cash fund' } };
  const ACTION_LABELS = { submit: 'Submit for approval', approve: 'Record approval', reject: 'Reject', cancel: 'Cancel request', release: 'Release payment', disburse: 'Disburse cash', return: 'Record return to fund' };
  const PRIMARY = new Set(['submit', 'approve', 'release', 'disburse']);

  let kind = 'payment', filters = { text: '', status: '', from: '', to: '', categoryId: '' }, host = null, lines = [];

  const auth = () => ctx.auth;
  const boot = () => ctx.boot;
  const canCreate = () => ['admin', 'maker'].includes(auth().user.role);

  async function load() {
    const params = new URLSearchParams({ kind, limit: '200' });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return api(`/requests?${params}`);
  }

  async function render(target, nextKind) {
    host = target; kind = nextKind;
    host.innerHTML = '<div class="loading">Loading requests&hellip;</div>';
    let data;
    try { data = await load(); } catch (error) { fail(error); host.innerHTML = '<div class="empty">Could not load requests.</div>'; return; }
    const card = boot().dashboard[kind === 'payment' ? 'payment' : 'pettyCash'];
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">${esc(KIND[kind].eyebrow)}</div><h1>${esc(KIND[kind].title)}</h1>
        <p class="muted">${data.total} shown &middot; ${money(data.amount)} total${kind === 'petty_cash' ? ` &middot; fund on hand ${money(boot().dashboard.pettyCash.balance)}` : ''}</p></div>
      <div class="actions">${canCreate() ? `<button class="primary" id="new">New ${kind === 'payment' ? 'payment request' : 'petty cash request'}</button>` : ''}</div></div>
      <section class="panel">
        <div class="toolbar">
          <label class="grow">Search<input id="f-text" value="${esc(filters.text)}" placeholder="Reference, requester, payee or particulars"></label>
          <label>Status<select id="f-status"><option value="">All statuses</option>
            ${boot().statuses.map(status => `<option value="${status.id}"${filters.status === status.id ? ' selected' : ''}>${esc(status.label)}</option>`).join('')}</select></label>
          <label>Category<select id="f-categoryId"><option value="">All categories</option>${categoriesFor(filters.categoryId)}</select></label>
          <label>From<input type="date" id="f-from" value="${esc(filters.from)}"></label>
          <label>To<input type="date" id="f-to" value="${esc(filters.to)}"></label>
          <button id="apply">Apply</button><button id="clear" class="ghost">Clear</button>
        </div>
        <div class="scroll">${data.rows.length ? table(data.rows) : `<div class="empty"><strong>No requests yet</strong>${canCreate() ? 'Use the New request button to prepare the first one.' : 'Requests prepared by makers will appear here.'}</div>`}</div>
        <div class="module-foot"><span>${esc(card.total)} on file in this module</span><span>Approved figures are permanently locked.</span></div>
      </section>`;
    host.querySelector('#new')?.addEventListener('click', () => form(null));
    host.querySelector('#apply').addEventListener('click', apply);
    host.querySelector('#clear').addEventListener('click', () => { filters = { text: '', status: '', from: '', to: '', categoryId: '' }; render(host, kind); });
    host.querySelectorAll('[data-id]').forEach(row => row.addEventListener('click', () => detail(row.dataset.id)));
    host.querySelector('#f-text').addEventListener('keydown', event => { if (event.key === 'Enter') apply(); });
  }
  function apply() {
    for (const key of Object.keys(filters)) filters[key] = host.querySelector(`#f-${key}`)?.value || '';
    render(host, kind);
  }

  const table = rows => `<table><thead><tr><th>Reference</th><th>Date</th><th>Requested by / Payee</th><th>Purpose</th>
      ${kind === 'payment' ? '<th>Check</th>' : ''}<th>Status</th><th class="right">Amount</th></tr></thead><tbody>
    ${rows.map(row => `<tr class="clickable" data-id="${row.id}">
      <td><span class="ref">${esc(row.number)}</span><small>Maker: ${esc(row.maker)}</small></td>
      <td>${esc(row.dateRequested)}</td>
      <td>${esc(row.requestedBy)}${row.payee && row.payee !== row.requestedBy ? `<small>Payee: ${esc(row.payee)}</small>` : ''}</td>
      <td>${esc((row.purpose || '').slice(0, 70))}${row.comments ? `<small class="has-comments">${row.comments} comment${row.comments === 1 ? '' : 's'} for your attention</small>` : ''}${row.cancelled ? `<small>Cancelled: ${esc(row.cancelReason)}</small>` : ''}</td>
      ${kind === 'payment' ? `<td>${esc(row.checkNumber || '')}${row.dateReleased ? `<small>Released ${esc(row.dateReleased)}</small>` : ''}</td>` : ''}
      <td>${badge(row.status, row.statusLabel)}</td>
      <td class="right">${money(row.total)}</td></tr>`).join('')}
  </tbody></table>`;

  // ------------------------------------------------------------- create / edit
  function lineRows() {
    return lines.map((line, index) => `<tr>
      <td><input data-line="${index}" data-field="particulars" value="${esc(line.particulars)}" placeholder="Describe the expense"></td>
      <td><select data-line="${index}" data-field="categoryId">${categoriesFor(line.categoryId)}</select></td>
      <td class="col-qty"><input data-line="${index}" data-field="quantity" type="number" step="0.001" min="0" value="${esc(line.quantity)}"></td>
      <td class="col-unit"><input data-line="${index}" data-field="unitAmount" type="number" step="0.01" min="0" value="${esc(line.unitAmount)}"></td>
      <td class="amount right">${money((Number(line.quantity) || 0) * (Number(line.unitAmount) || 0))}</td>
      <td><button class="small ghost danger" data-remove="${index}" title="Remove line">&#10005;</button></td></tr>`).join('');
  }
  function paintLines() {
    const body = document.querySelector('#lines');
    if (!body) return;
    body.innerHTML = lineRows();
    const total = lines.reduce((sum, line) => sum + Math.round((Number(line.quantity) || 0) * (Number(line.unitAmount) || 0) * 100) / 100, 0);
    document.querySelector('#total').textContent = money(total);
    body.querySelectorAll('[data-line]').forEach(input => {
      input.addEventListener('input', () => {
        lines[Number(input.dataset.line)][input.dataset.field] = input.dataset.field === 'particulars' || input.dataset.field === 'categoryId' ? input.value : Number(input.value);
        if (input.dataset.field !== 'particulars') paintLines();
      });
      input.addEventListener('change', () => { if (input.dataset.field === 'categoryId') lines[Number(input.dataset.line)].categoryId = input.value; });
    });
    body.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { lines.splice(Number(button.dataset.remove), 1); paintLines(); }));
  }

  function form(request) {
    const config = boot().config;
    lines = request ? request.lines.map(line => ({ particulars: line.particulars, categoryId: line.categoryId, quantity: line.quantity, unitAmount: line.unitAmount }))
      : [{ particulars: '', categoryId: boot().categories.find(c => c.active)?.id || '', quantity: 1, unitAmount: 0 }];
    openDialog(request ? `Edit draft ${request.number}` : `New ${KIND[kind].title.replace(/s$/, '')}`, `
      <div class="form-grid">
        <label class="field">Date requested<input type="date" id="dateRequested" value="${esc(request?.dateRequested || today())}"></label>
        <label class="field">Requested by<input id="requestedBy" value="${esc(request?.requestedBy || auth().user.fullName)}"></label>
        <label class="field">Payee <small>Leave blank if the same as the requester.</small><input id="payee" value="${esc(request?.payee || '')}"></label>
        <label class="field">Approved by (signs the form)<select id="finalApprover">
          ${config.finalApprovers.map(name => `<option${name === (request?.finalApprover || config.defaultFinalApprover) ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
          <small>Signs the Approved By line of the printed form.</small></label>
        <label class="field full">Purpose / remarks<textarea id="purpose">${esc(request?.purpose || '')}</textarea></label>
      </div>
      <h3 class="gap-lg">Expense details</h3>
      <table class="line-table"><thead><tr><th>Particulars</th><th>Accounting category</th><th>Qty.</th><th>Unit amount</th><th class="right">Amount</th><th></th></tr></thead>
        <tbody id="lines"></tbody></table>
      <button class="small" id="add-line" class="gap-sm">Add expense line</button>
      <div class="total-strip"><span>Total amount</span><strong id="total">${money(0)}</strong></div>`,
    `<button id="cancel">Cancel</button><button class="primary" id="save">${request ? 'Save draft' : 'Create draft'}</button>`);
    paintLines();
    document.querySelector('#add-line').addEventListener('click', () => { lines.push({ particulars: '', categoryId: boot().categories.find(c => c.active)?.id || '', quantity: 1, unitAmount: 0 }); paintLines(); });
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#save').addEventListener('click', async () => {
      const value = id => document.querySelector(`#${id}`).value.trim();
      const body = {
        dateRequested: value('dateRequested'), requestedBy: value('requestedBy'), payee: value('payee'),
        purpose: value('purpose'), finalApprover: value('finalApprover'),
        lines: lines.filter(line => line.particulars.trim()).map(line => ({ particulars: line.particulars.trim(), categoryId: line.categoryId, quantity: Number(line.quantity), unitAmount: Number(line.unitAmount) })),
      };
      try {
        const saved = request ? await api(`/requests/${request.id}`, body) : await api('/requests', { ...body, kind });
        closeDialog(); toast(`${saved.number} saved as a draft.`);
        await refresh({ silent: true });
        render(host, kind);
        detail(saved.id);
      } catch (error) { fail(error); }
    });
  }

  // ------------------------------------------------------------- detail
  async function detail(id) {
    let request;
    try { request = await api(`/requests/${id}`); } catch (error) { fail(error); return; }
    const accounting = boot().canPrintAccountingCopy;
    const actions = request.actions || [];
    const editable = request.canEdit === true;
    openDialog(`${request.number} · ${request.kindLabel}`, `
      ${request.cancelled ? `<div class="notice stop"><span class="stamp">CANCELLED</span> &nbsp; ${esc(request.cancelReason)}<br><small>By ${esc(request.cancelledBy)} on ${esc(stamp(request.cancelledAt))} &mdash; previous status: ${esc(request.previousStatus || '')}</small></div>` : ''}
      ${request.status === 'rejected' ? `<div class="notice stop">Rejected by ${esc(request.approver?.name || '')}. ${esc(request.decisionRemarks)}</div>` : ''}
      <dl class="detail-grid">
        <div><dt>Status</dt><dd>${badge(request.status, request.statusLabel)}</dd></div>
        <div><dt>Date requested</dt><dd>${esc(request.dateRequested)}</dd></div>
        <div><dt>Total amount</dt><dd>${money(request.total)}</dd></div>
        <div><dt>Requested by</dt><dd>${esc(request.requestedBy)}</dd></div>
        <div><dt>Payee</dt><dd>${esc(request.payee || request.requestedBy)}</dd></div>
        <div><dt>Prepared by (Maker)</dt><dd>${esc(request.maker.name)}</dd></div>
        <div><dt>Approved by</dt><dd>${esc(request.finalApprover)}</dd></div>
        <div><dt>Approval recorded by</dt><dd>${esc(request.approver?.name || 'Pending')}</dd></div>
        <div><dt>Purpose / remarks</dt><dd>${esc(request.purpose || '—')}</dd></div>
      </dl>
      <h3 class="section-gap">Expense details</h3>
      <table><thead><tr><th>Particulars</th><th>Accounting category</th><th class="right">Qty.</th><th class="right">Unit amount</th><th class="right">Amount</th></tr></thead>
        <tbody>${request.lines.map(line => `<tr><td>${esc(line.particulars)}</td><td>${esc(line.categoryName)}</td>
          <td class="right">${esc(line.quantity)}</td><td class="right">${money(line.unitAmount)}</td><td class="right">${money(line.amount)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total</td><td class="right">${money(request.total)}</td></tr></tfoot></table>

      ${request.payment ? `<h3 class="section-gap">Check / payment details</h3><dl class="detail-grid">
        <div><dt>Method</dt><dd>${esc(request.payment.method)}</dd></div>
        <div><dt>Bank</dt><dd>${esc(request.payment.bank || '—')}</dd></div>
        <div><dt>Check number</dt><dd>${esc(request.payment.checkNumber || '—')}</dd></div>
        <div><dt>Check date</dt><dd>${esc(request.payment.checkDate || '—')}</dd></div>
        <div><dt>Check amount</dt><dd>${money(request.payment.amount)}</dd></div>
        <div><dt>Date prepared</dt><dd>${esc(request.payment.datePrepared)}</dd></div>
        <div><dt>Date released</dt><dd>${esc(request.payment.dateReleased || 'Not yet released')}</dd></div>
        <div><dt>Released by</dt><dd>${esc(request.payment.releasedBy || '—')}</dd></div>
        <div><dt>Received by</dt><dd>${esc(request.payment.receivedBy || '—')}</dd></div>
        <div><dt>Remarks</dt><dd>${esc(request.payment.remarks || '—')}</dd></div>
        <div><dt>Recorded by</dt><dd>${esc(request.payment.recordedBy)}</dd></div>
      </dl>` : ''}

      ${request.ledger ? `<h3 class="section-gap">Petty cash movements</h3><table><thead><tr><th>Date</th><th>Type</th><th>Description</th>
        <th class="right">In</th><th class="right">Out</th><th class="right">Balance</th></tr></thead><tbody>
        ${request.ledger.map(entry => `<tr><td>${esc(entry.entryDate)}</td><td>${esc(entry.type)}</td><td>${esc(entry.description)}</td>
          <td class="right">${entry.in ? money(entry.in) : ''}</td><td class="right">${entry.out ? money(entry.out) : ''}</td>
          <td class="right">${money(entry.balance)}</td></tr>`).join('')}</tbody></table>` : ''}

      <h3 class="section-gap">Supporting documents</h3>
      ${request.documents.length ? `<ul class="history">${request.documents.map(document => `<li><a href="/api/documents/${document.id}/content">${esc(document.name)}</a>
        <time>${esc(document.uploadedBy)} &middot; ${esc(stamp(document.uploadedAt))} &middot; ${Math.ceil(document.size / 1024)} KB</time></li>`).join('')}</ul>`
        : '<p class="muted small-text">No documents attached.</p>'}
      <input type="file" id="file" accept=".pdf,image/*" class="file-input">

      <h3 class="section-gap">Review comments</h3>
      <p class="muted small-text">Comments are permanent and visible to the maker. Reviewing never changes the request: if a correction is needed, the maker edits the draft, or the request is cancelled and re-filed.</p>
      ${request.comments.length ? `<ul class="history">${request.comments.map(comment => `<li><strong>${esc(comment.text)}</strong>
        <time>${esc(comment.actor)} &middot; ${esc(stamp(comment.at))}</time></li>`).join('')}</ul>` : '<p class="muted small-text">No comments yet.</p>'}
      ${canComment() ? `<div class="comment-box"><textarea id="comment-text" placeholder="Raise a discrepancy, ask for a clarification, or note your review"></textarea>
        <button class="small" id="add-comment">Add comment</button></div>` : ''}

      <h3 class="section-gap">Transaction history</h3>
      <ul class="history">${request.history.map(entry => `<li><strong>${esc(entry.detail || entry.action)}</strong>
        <time>${esc(stamp(entry.at))} &middot; ${esc(entry.actor)} &middot; ${esc(entry.status ? (boot().statuses.find(s => s.id === entry.status)?.label || entry.status) : '')}</time></li>`).join('')}</ul>`,
    `<button data-pdf="">Standard copy (PDF)</button>
      ${accounting ? '<button data-pdf="?copy=accounting">Accounting copy (PDF)</button>' : ''}
      ${editable ? '<button id="edit">Edit draft</button>' : ''}
      ${actions.map(action => `<button class="${PRIMARY.has(action) ? 'primary' : action === 'cancel' || action === 'reject' ? 'danger' : ''}" data-action="${action}">${esc(ACTION_LABELS[action] || action)}</button>`).join('')}
      <button id="close">Close</button>`);

    document.querySelector('#close').addEventListener('click', closeDialog);
    document.querySelectorAll('[data-pdf]').forEach(button => button.addEventListener('click', () => window.open(`/api/requests/${request.id}/pdf${button.dataset.pdf}`, '_blank', 'noopener')));
    document.querySelector('#edit')?.addEventListener('click', () => form(request));
    document.querySelector('#file').addEventListener('change', event => upload(request.id, event.target.files[0]));
    document.querySelector('#add-comment')?.addEventListener('click', () => comment(request.id));
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => act(request, button.dataset.action)));
  }

  const canComment = () => ['admin', 'approver', 'maker'].includes(auth().user.role);

  async function comment(id) {
    const text = document.querySelector('#comment-text').value.trim();
    if (!text) { toast('Write a comment first.', true); return; }
    try {
      await api(`/requests/${id}/comment`, { text });
      toast('Comment added. The maker will see it on the request.');
      await refresh({ silent: true });
      await render(host, kind);
      detail(id);
    } catch (error) { fail(error); }
  }

  async function upload(id, file) {
    if (!file) return;
    if (file.size > 7_000_000) { toast('Attachments are limited to 7 MB.', true); return; }
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of buffer) binary += String.fromCharCode(byte);
    try {
      await api(`/requests/${id}/documents`, { name: file.name, mime: file.type || 'application/pdf', content: btoa(binary) });
      toast('Document attached.');
      detail(id);
    } catch (error) { fail(error); }
  }

  // Each action collects exactly the fields the server will require for it.
  const FORMS = {
    approve: request => ({
      title: 'Record approval',
      note: `Record that the printed form has been signed by ${request.finalApprover}. The approver signs on paper and holds no account here, so this entry is the system's record of that signature.`,
      fields: [['remarks', 'Notes on the signed approval (optional)', 'textarea']],
    }),
    reject: () => ({ title: 'Reject request', note: 'Use this when the request will not be sent for signature, or comes back unsigned.', fields: [['remarks', 'Reason for rejection', 'textarea']] }),
    cancel: () => ({ title: 'Cancel request', fields: [['reason', 'Reason for cancellation', 'textarea']], note: 'The transaction is never deleted. It stays searchable and is marked CANCELLED. If petty cash was already released, record a separate return to restore the fund.' }),
    release: request => ({
      title: 'Release payment',
      note: 'This records the check or transfer details and the release together, as a payment record attached to the approved request. The approved request itself is not modified.',
      fields: [['method', 'Payment method', 'select', boot().paymentMethods], ['bank', 'Bank', 'text'], ['checkNumber', 'Check number', 'text'],
        ['checkDate', 'Check date', 'date'], ['amount', 'Amount', 'number', null, request.total],
        ['payee', 'Payee', 'text', null, request.payee || request.requestedBy],
        ['datePrepared', 'Date prepared', 'date', null, today()], ['dateReleased', 'Date released', 'date', null, today()],
        ['receivedBy', 'Received by', 'text'], ['remarks', 'Remarks', 'textarea']],
    }),
    disburse: () => ({ title: 'Disburse petty cash', note: `The petty cash fund will be reduced immediately. Balance on hand: ${money(boot().dashboard.pettyCash.balance)}.`, fields: [['entryDate', 'Date disbursed', 'date', null, today()], ['receivedBy', 'Received by', 'text'], ['remarks', 'Remarks', 'textarea']] }),
    return: request => ({ title: 'Record return to the fund', note: 'A return is recorded as its own ledger entry. The original disbursement is never altered.', fields: [['entryDate', 'Date returned', 'date', null, today()], ['amount', 'Amount returned', 'number', null, request.total], ['reason', 'Reason', 'textarea']] }),
  };

  function act(request, action) {
    const build = FORMS[action];
    if (!build) { send(request, action, {}); return; }
    const spec = build(request);
    const field = ([id, label, type, options, value]) => {
      if (type === 'textarea') return `<label class="field full">${esc(label)}<textarea id="${id}"></textarea></label>`;
      if (type === 'select') return `<label class="field">${esc(label)}<select id="${id}">${options.map(option => `<option>${esc(option)}</option>`).join('')}</select></label>`;
      if (type === 'number') return `<label class="field">${esc(label)}${amountField(id, value)}</label>`;
      return `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value ?? '')}"></label>`;
    };
    openDialog(spec.title, `${spec.note ? `<div class="notice">${esc(spec.note)}</div>` : ''}<div class="form-grid">${spec.fields.map(field).join('')}</div>`,
      `<button id="back">Back</button><button class="primary" id="confirm">${esc(spec.title)}</button>`);
    document.querySelector('#back').addEventListener('click', () => detail(request.id));
    document.querySelector('#confirm').addEventListener('click', () => {
      const body = {};
      for (const [id, label, type] of spec.fields) {
        const element = document.querySelector(`#${id}`);
        if (type === 'number') {
          const amount = readAmount(element.value);
          if (Number.isNaN(amount)) { toast(`${label}: enter the amount in figures, such as 1250.00`, true); element.focus(); return; }
          body[id] = amount;
          continue;
        }
        body[id] = element.value.trim();
      }
      send(request, action, body);
    });
  }

  async function send(request, action, body) {
    try {
      const updated = await api(`/requests/${request.id}/${action}`, body);
      toast(`${updated.number}: ${updated.statusLabel}.`);
      await refresh({ silent: true });
      await render(host, kind);
      detail(request.id);
    } catch (error) { fail(error); }
  }

  return { render };
}
