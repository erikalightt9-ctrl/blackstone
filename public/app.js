import { createRequestsView } from './requests.js';
import { createPettyCashView } from './pettycash.js';
import { createReportsView } from './reports.js';
import { createBankView } from './bank.js';
import { createAccountsView } from './accounts.js';

const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastBox = document.querySelector('#toast');

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(Number(value) || 0);
// A bank account carries its own currency and its own number of decimal places, so amounts
// on the passbook are formatted from the account rather than assumed to be pesos.
// Amounts are typed, never stepped. A number input puts arrows on a money field and changes
// the figure if the wheel is scrolled over it, which is the last thing a ledger wants; and it
// silently rejects a pasted "1,250.00". This takes the text as written and reads the number
// from it, so separators, spaces and a currency symbol are all allowed.
export const amountField = (id, value) =>
  `<input id="${id}" type="text" inputmode="decimal" autocomplete="off" class="amount" value="${esc(value ?? '')}">`;

export const readAmount = text => {
  const cleaned = String(text ?? '').replace(/[\s,\u00a0\u20b1$\u20ac\u00a3\u00a5]/g, '');
  if (!cleaned) return 0;
  return /^\d*\.?\d*$/.test(cleaned) ? Number(cleaned) : NaN;
};

export const cash = (value, symbol = '', decimals = 2) =>
  `${symbol}${new Intl.NumberFormat('en-PH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number(value) || 0)}`;
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
export const longDate = () => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full' }).format(new Date());
export const stamp = value => (value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : '');
export const badge = (status, label) => `<span class="badge ${esc(status)}">${esc(label)}</span>`;
// The logo is optional: if public/brand/logo.png is absent the image removes itself and the
// wordmark beside it carries the branding. A CSP with no inline handlers means this is wired
// up in script rather than with an onerror attribute.
const hideMissingLogos = scope => scope.querySelectorAll('img[data-logo]').forEach(img => img.addEventListener('error', () => img.remove()));

let auth = null, boot = null, page = 'overview', stream = null;
const views = {};

export async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth?.csrf || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') { auth = null; renderLogin(); }
    throw new Error(data.error || 'The request could not be completed.');
  }
  return data;
}

export function toast(message, isError = false) {
  toastBox.textContent = message;
  toastBox.classList.toggle('stop', isError);
  toastBox.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastBox.classList.remove('visible'), 5200);
}
export const fail = error => toast(error.message || String(error), true);

export function openDialog(title, bodyHtml, footerHtml = '') {
  dialog.innerHTML = `<form method="dialog"><div class="dialog-head"><h2>${esc(title)}</h2><button class="ghost" value="cancel" aria-label="Close">&#10005;</button></div></form>
    <div class="dialog-body">${bodyHtml}</div><div class="dialog-foot">${footerHtml}</div>`;
  if (!dialog.open) dialog.showModal();
  return dialog;
}
export const closeDialog = () => dialog.close();
// Getters, not snapshots: a view is built once and must always read the live session and
// bootstrap data, which every committed change refreshes underneath it.
export const context = () => ({
  get auth() { return auth; },
  get boot() { return boot; },
  api, esc, money, cash, amountField, readAmount, today, stamp, badge, toast, fail, openDialog, closeDialog, refresh, setPage, categoriesFor,
});
export const categoriesFor = (selected = '') => boot.categories
  .filter(category => category.active || category.id === selected)
  .map(category => `<option value="${category.id}"${category.id === selected ? ' selected' : ''}>${esc(category.name)}${category.active ? '' : ' (inactive)'}</option>`).join('');

const can = (...roles) => roles.includes(auth.user.role);
// The Dashboard has no nav button of its own: the company logo is the way home.
const NAV = [
  { id: 'payment', label: 'Payment Requests', icon: '✉' },
  { id: 'petty_cash', label: 'Petty Cash Requests', icon: '☷' },
  { id: 'fund', label: 'Petty Cash Fund', icon: '₱', needs: b => b.canSeePettyCashFund },
  { id: 'bank', label: 'Bank Records', icon: '▤', needs: b => b.canEncodeBankRecords || b.user.role === 'viewer' },
  { id: 'accounts', label: 'Bank Accounts', icon: '⌂', needs: b => b.canManageBankAccounts },
  { id: 'reports', label: 'Reports', icon: '≡' },
];

export function setPage(next) { page = next; render(); }

export async function refresh({ silent = false } = {}) {
  try {
    boot = await api('/bootstrap');
    if (!silent) render();
    else { renderContent(); renderTopbar(); }
  } catch (error) { fail(error); }
}

function renderTopbar() {
  const bar = document.querySelector('#topbar');
  if (!bar || !boot) return;
  bar.innerHTML = `<div>${esc(boot.config.companyName)} &middot; Financial Monitoring</div>
    ${boot.dashboard.pettyCash.seesFund ? `<div class="balance">Petty cash on hand: ${money(boot.dashboard.pettyCash.balance)}</div>` : ''}`;
}

function render() {
  if (!auth?.user) { renderLogin(); return; }
  if (!boot) { root.innerHTML = '<div class="loading">Loading&hellip;</div>'; refresh(); return; }
  root.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <button class="brand" data-page="overview" title="Go to the dashboard" aria-label="${esc(boot.config.companyName)} - go to the dashboard">
        <img class="brand-logo" data-logo src="/brand/logo.png" alt="${esc(boot.config.companyName)}"><span>Financial Monitoring</span></button>
      <nav class="nav">${NAV.filter(item => !item.needs || item.needs(boot)).map(item => `<button data-page="${item.id}" class="${page === item.id ? 'active' : ''}"><span class="icon">${item.icon}</span>${item.label}</button>`).join('')}</nav>
      <div class="sidebar-foot">
        ${can('admin') ? `<button data-page="settings" class="${page === 'settings' ? 'active' : ''}">Settings</button>` : ''}
        <button id="change-password">Change password</button><button id="sign-out">Sign out</button></div>
    </aside>
    <main class="main"><div class="topbar" id="topbar"></div><div class="content" id="content"></div></main>
  </div>`;
  hideMissingLogos(root);
  root.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
  root.querySelector('#sign-out').addEventListener('click', async () => { await api('/logout', {}); auth = null; boot = null; stream?.close(); stream = null; renderLogin(); });
  root.querySelector('#change-password').addEventListener('click', passwordDialog);
  renderTopbar();
  renderContent();
  listen();
}

function renderContent() {
  const host = document.querySelector('#content');
  if (!host) return;
  if (page === 'overview') return renderOverview(host);
  if (page === 'payment' || page === 'petty_cash') return (views.requests ||= createRequestsView(context())).render(host, page);
  if (page === 'fund') return (views.fund ||= createPettyCashView(context())).render(host);
  if (page === 'bank') return (views.bank ||= createBankView(context())).render(host);
  if (page === 'accounts') return (views.accounts ||= createAccountsView(context())).render(host);
  if (page === 'reports') return (views.reports ||= createReportsView(context())).render(host);
  if (page === 'settings') return renderSettings(host);
  return undefined;
}

// Live updates: any committed change anywhere refreshes the figures without a reload.
function listen() {
  if (stream) return;
  stream = new EventSource('/api/events');
  stream.addEventListener('change', () => refresh({ silent: true }));
  stream.addEventListener('error', () => { stream.close(); stream = null; setTimeout(() => { if (auth?.user) listen(); }, 5000); });
}

function tile(label, value, note = '') {
  return `<div class="tile"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<em>${esc(note)}</em>` : ''}</div>`;
}
function renderOverview(host) {
  const { payment, pettyCash, bank } = boot.dashboard;
  host.innerHTML = `<div class="page-head dashboard-head"><div><div class="eyebrow">Stronger resources, brighter tomorrow</div><h1>Finance dashboard</h1>
      <p class="muted">Every request, approval, payment and petty cash movement in one place.</p></div>
      <div class="hello">
        <img class="hello-mascot" src="/brand/mascot.png" alt="">
        <div class="hello-copy"><strong>Hi, ${esc(auth.user.fullName)}!</strong>
          <span>${esc(boot.roles.find(role => role.id === auth.user.role)?.label || auth.user.role)} &middot; ${esc(longDate())}</span></div>
      </div></div>
    <div class="module-grid">
      <section class="module">
        <div class="module-head"><div><h2><span class="card-emoji">🧾</span>Payment Requests</h2><p class="muted sub-note">${payment.total} request${payment.total === 1 ? '' : 's'} on file</p></div>
          <div class="lead">${money(payment.totalAmount)}<small>Total filed</small></div></div>
        <div class="tiles">
          ${tile('Drafts', payment.count.draft, money(payment.amount.draft))}
          ${tile('For approval', payment.forApproval, money(payment.forApprovalAmount))}
          ${tile('Approved, for release', payment.count.approved, money(payment.amount.approved))}
          ${tile('Released', payment.count.paid, money(payment.amount.paid))}
          ${tile('Cancelled', payment.count.cancelled, money(payment.amount.cancelled))}
          ${tile('Rejected', payment.count.rejected, money(payment.amount.rejected))}
        </div>
        <div class="module-foot"><span>Maker prepares &rarr; signed on paper &rarr; releaser records and releases</span><button class="small" data-open="payment">Open module</button></div>
      </section>
      <section class="module">
        <div class="module-head"><div><h2><span class="card-emoji">💰</span>Petty Cash</h2><p class="muted sub-note">${pettyCash.seesFund ? (pettyCash.fundOpened ? 'Fund is open' : 'Fund not yet opened') : 'Your petty cash requests'}</p></div>
          ${pettyCash.seesFund ? `<div class="lead">${money(pettyCash.balance)}<small>Current balance</small></div>` : ''}</div>
        <div class="tiles">
          ${tile('Drafts', pettyCash.count.draft, money(pettyCash.amount.draft))}
          ${tile('For approval', pettyCash.forApproval, money(pettyCash.forApprovalAmount))}
          ${tile('Approved, for disbursement', pettyCash.count.approved, money(pettyCash.amount.approved))}
          ${tile('Disbursed', pettyCash.count.disbursed, money(pettyCash.amount.disbursed))}
          ${tile('Cancelled', pettyCash.count.cancelled, money(pettyCash.amount.cancelled))}
          ${pettyCash.seesFund ? tile('Replenishments funded', pettyCash.replenishments.funded?.count || 0, money(pettyCash.replenishments.funded?.amount || 0)) : tile('Rejected', pettyCash.count.rejected, money(pettyCash.amount.rejected))}
        </div>
        <div class="module-foot"><span>Maker prepares &rarr; signed on paper &rarr; releaser records and disburses</span>
          <span><button class="small" data-open="petty_cash">Requests</button>${pettyCash.seesFund ? ' <button class="small" data-open="fund">Fund &amp; ledger</button>' : ''}</span></div>
      </section>
    </div>
    ${bank ? `<section class="module">
      <div class="module-head"><div><h2><span class="card-emoji">🏦</span>Bank Records</h2><p class="muted sub-note">${bank.entries} passbook entr${bank.entries === 1 ? 'y' : 'ies'} encoded</p></div>
        ${bank.balances.length === 1 ? `<div class="lead">${cash(bank.balances[0].balance, bank.balances[0].symbol, bank.balances[0].decimals)}<small>${esc(bank.balances[0].currency)} balance</small></div>` : ''}</div>
      <div class="tiles">
        ${bank.balances.length ? bank.balances.slice(0, 4).map(item => tile(item.account, cash(item.balance, item.symbol, item.decimals), `${item.currency} &middot; as of ${item.asOf}`)).join('')
          : tile('Accounts opened', 0, 'enter a beginning balance to start')}
        ${bank.balances.length > 4 ? tile('Other accounts', bank.balances.length - 4, 'see Bank Records') : ''}
      </div>
      <div class="module-foot"><span>Transactions copied from the official passbook, every correction tracked</span>
        <button class="small" data-open="bank">Open module</button></div>
    </section>` : ''}`;
  host.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.open)));
}

function passwordDialog() {
  openDialog('Change password', `<div class="form-grid">
      <label class="field full">Current password<input type="password" id="current" autocomplete="current-password"></label>
      <label class="field full">New password<input type="password" id="next" autocomplete="new-password"><small>At least 12 characters. You will be signed out afterwards.</small></label>
    </div>`, '<button id="cancel">Cancel</button><button class="primary" id="save">Change password</button>');
  dialog.querySelector('#cancel').addEventListener('click', closeDialog);
  dialog.querySelector('#save').addEventListener('click', async () => {
    try {
      await api('/password', { currentPassword: dialog.querySelector('#current').value, newPassword: dialog.querySelector('#next').value });
      closeDialog(); auth = null; boot = null; renderLogin();
      toast('Password changed. Please sign in again.');
    } catch (error) { fail(error); }
  });
}

// ---------------------------------------------------------------- settings
async function renderSettings(host) {
  host.innerHTML = '<div class="loading">Loading settings&hellip;</div>';
  const [categories, users, config] = await Promise.all([api('/categories?all=1'), api('/users'), api('/config')]);
  host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Administration</div><h1>Settings</h1></div></div>
    <section class="panel"><div class="panel-head"><div><h2>Accounting Category Master List</h2>
        <p>Categories are internal. They stay off the standard request copy and appear only on the Accounting / Internal copy.</p></div>
      <button class="primary small" id="new-category">Add category</button></div>
      <div class="scroll"><table><thead><tr><th>Code</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>
        ${categories.map(category => `<tr><td><strong>${esc(category.code)}</strong></td><td>${esc(category.name)}</td>
          <td>${badge(category.active ? 'approved' : 'cancelled', category.active ? 'Active' : 'Deactivated')}</td>
          <td class="right"><button class="small" data-category="${category.id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div></section>

    <section class="panel"><div class="panel-head"><div><h2>Numbering, approvers and company</h2>
      <p>Reference number formats accept {YYYY}, {YY}, {MM} and {SEQ:n}.</p></div></div>
      <div class="panel-body"><div class="form-grid">
        <label class="field">Company name<input id="companyName" value="${esc(config.companyName)}"></label>
        <label class="field">Currency symbol<input id="currencySymbol" value="${esc(config.currencySymbol)}"></label>
        <label class="field">Payment Request numbering<input id="paymentNumberFormat" value="${esc(config.paymentNumberFormat)}"></label>
        <label class="field">Petty Cash numbering<input id="pettyCashNumberFormat" value="${esc(config.pettyCashNumberFormat)}"></label>
        <label class="field">Replenishment numbering<input id="replenishmentNumberFormat" value="${esc(config.replenishmentNumberFormat)}"></label>
        <label class="field">Default approver<select id="defaultFinalApprover">
          ${config.finalApprovers.map(name => `<option${name === config.defaultFinalApprover ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
        <label class="field full">Authorized approvers<input id="finalApprovers" value="${esc(config.finalApprovers.join(', '))}">
          <small>Comma separated. These are the choices in the Approved By dropdown, and the name printed on the Approved By line of the PDF.</small></label>
        <label class="field">Default currency for a new bank account<input id="baseCurrency" value="${esc(config.baseCurrency || '')}">
          <small>A code from the currency list. It only decides which one a new account is offered first.</small></label>
        <label class="field full">Bank account types<input id="accountTypes" value="${esc((config.accountTypes || []).join(', '))}">
          <small>Comma separated. Offered when adding a bank account; any other wording can still be typed in.</small></label>
      </div></div>
      <div class="dialog-foot"><button class="primary" id="save-config">Save configuration</button></div></section>

    <section class="panel"><div class="panel-head"><div><h2>Registered accounts</h2>
      <p>Only an address registered here can open the system: there is no self sign-up. People sign in with their email or username. Approval itself happens on paper, so Demry Cheng and Vicente Cheng hold no account.</p></div>
      <button class="primary small" id="new-user">Register account</button></div>
      ${boot.mailConfigured ? '' : '<div class="notice">Email is not configured, so reset links cannot be sent. Use <strong>Send reset link</strong> and the system will show you the one-time link to hand over instead. See DEPLOY.md to set up sending.</div>'}
      <div class="scroll"><table><thead><tr><th>Registered email</th><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map(user => `<tr><td><strong>${esc(user.email || '\u2014 not registered')}</strong></td>
          <td>${esc(user.fullName)}</td><td>${esc(user.username)}</td>
          <td>${esc(boot.roles.find(r => r.id === user.role)?.label || user.role)}</td>
          <td>${badge(user.disabled ? 'cancelled' : 'approved', user.disabled ? 'Disabled' : 'Active')}</td>
          <td class="right"><button class="small" data-edit-user="${user.id}">Edit</button>
            <button class="small" data-reset="${user.id}">Send reset link</button>
            <button class="small ${user.disabled ? '' : 'danger'}" data-access="${user.id}" data-disabled="${user.disabled}">${user.disabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('')}
      </tbody></table></div></section>`;

  host.querySelector('#new-category').addEventListener('click', () => categoryDialog());
  host.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => categoryDialog(categories.find(c => c.id === button.dataset.category))));
  host.querySelector('#new-user').addEventListener('click', userDialog);
  host.querySelector('#save-config').addEventListener('click', async () => {
    const value = id => host.querySelector(`#${id}`).value.trim();
    try {
      await api('/config', {
        companyName: value('companyName'), currencySymbol: value('currencySymbol'),
        paymentNumberFormat: value('paymentNumberFormat'), pettyCashNumberFormat: value('pettyCashNumberFormat'),
        replenishmentNumberFormat: value('replenishmentNumberFormat'),
        finalApprovers: value('finalApprovers').split(',').map(name => name.trim()).filter(Boolean),
        defaultFinalApprover: value('defaultFinalApprover'),
        accountTypes: value('accountTypes').split(',').map(name => name.trim()).filter(Boolean),
        baseCurrency: value('baseCurrency'),
      });
      toast('Configuration saved.');
      await refresh();
    } catch (error) { fail(error); }
  });
  host.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', async () => {
    try {
      const result = await api(`/users/${button.dataset.reset}/send-reset`, {});
      if (result.sent) { toast(result.message); return; }
      // Nothing was sent, so the administrator is shown the link rather than misled.
      openDialog('Reset link', `<div class="notice">${esc(result.message)}</div>
        <div class="field full"><span>One-time link</span><input id="reset-link" value="${esc(result.link)}" readonly></div>`,
      '<button id="copy">Copy link</button><button class="primary" id="done">Done</button>');
      dialog.querySelector('#done').addEventListener('click', closeDialog);
      dialog.querySelector('#copy').addEventListener('click', async () => {
        const field = dialog.querySelector('#reset-link');
        field.select();
        try { await navigator.clipboard.writeText(field.value); toast('Link copied.'); } catch { toast('Select the link and copy it.', true); }
      });
    } catch (error) { fail(error); }
  }));
  host.querySelectorAll('[data-edit-user]').forEach(button => button.addEventListener('click', () => userDialog(users.find(u => u.id === button.dataset.editUser))));
  host.querySelectorAll('[data-access]').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/users/${button.dataset.access}/access`, { disabled: button.dataset.disabled !== 'true' }); renderSettings(host); } catch (error) { fail(error); }
  }));
}

function categoryDialog(category = null) {
  openDialog(category ? 'Edit accounting category' : 'Add accounting category', `<div class="form-grid">
      <label class="field">Code<input id="code" value="${esc(category?.code || '')}"></label>
      <label class="field">Category name<input id="name" value="${esc(category?.name || '')}"></label>
      <label class="field full"><span><input type="checkbox" id="active"${category?.active !== false ? ' checked' : ''}> Active</span>
        <small>Deactivating keeps the category on existing records but removes it from new expense lines.</small></label>
    </div>`, '<button id="cancel">Cancel</button><button class="primary" id="save">Save category</button>');
  dialog.querySelector('#cancel').addEventListener('click', closeDialog);
  dialog.querySelector('#save').addEventListener('click', async () => {
    const body = { code: dialog.querySelector('#code').value.trim(), name: dialog.querySelector('#name').value.trim(), active: dialog.querySelector('#active').checked };
    try {
      await api(category ? `/categories/${category.id}` : '/categories', body);
      closeDialog(); toast('Accounting category saved.');
      await refresh();
      renderSettings(document.querySelector('#content'));
    } catch (error) { fail(error); }
  });
}

function userDialog(user = null) {
  openDialog(user ? `Edit ${user.username}` : 'Register an account', `
    <div class="notice">Registering an address is what grants access: nobody can sign up on their own, and an unregistered address matches no account.</div>
    <div class="form-grid">
      <label class="field full">Registered email<input id="email" type="email" autocomplete="off" value="${esc(user?.email || '')}">
        <small>Used to sign in and to receive password reset links.</small></label>
      <label class="field">Full name<input id="fullName" autocomplete="off" value="${esc(user?.fullName || '')}"><small>Printed on the request as Maker or Releaser.</small></label>
      <label class="field">Role<select id="role">${boot.roles.map(role => `<option value="${role.id}"${role.id === user?.role ? ' selected' : ''}>${esc(role.label)}</option>`).join('')}</select></label>
      ${user ? '' : `<label class="field">Username<input id="username" autocomplete="off"><small>A short name they may sign in with instead of the email.</small></label>
      <label class="field">First password<input type="password" id="password" autocomplete="new-password"><small>At least 12 characters. They can change it, or use a reset link.</small></label>`}
    </div>`, `<button id="cancel">Cancel</button><button class="primary" id="save">${user ? 'Save account' : 'Register account'}</button>`);
  dialog.querySelector('#cancel').addEventListener('click', closeDialog);
  dialog.querySelector('#save').addEventListener('click', async () => {
    const value = id => dialog.querySelector(`#${id}`)?.value.trim() || '';
    try {
      if (user) await api(`/users/${user.id}`, { fullName: value('fullName'), email: value('email'), role: value('role') });
      else {
        await api('/users', {
          username: value('username'), fullName: value('fullName'), email: value('email'),
          role: value('role'), password: dialog.querySelector('#password').value,
        });
      }
      closeDialog(); toast(user ? 'Account updated.' : 'Account registered.');
      renderSettings(document.querySelector('#content'));
    } catch (error) { fail(error); }
  });
}

// ---------------------------------------------------------------- sign in
function renderLogin(setup = false, message = '') {
  root.innerHTML = `<div class="login">
    <div class="login-story">
      <div><img class="login-logo" data-logo src="/brand/logo.png" alt=""><h1>Financial Monitoring</h1>
        <p>Every request, approval, disbursement and replenishment is recorded, numbered and permanently traceable.</p></div>
      <div class="login-card"><span>Petty cash ledger</span><strong>Traceable to the centavo</strong>
        <div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div>
      <p class="fine-print">Authorized users only. All actions are logged.</p>
    </div>
    <div class="login-form"><form id="form">
      <h2>${setup ? 'First-time setup' : 'Sign in'}</h2>
      <p class="muted lede">${setup ? 'Create the first administrator account using the setup code printed in the server console.' : 'Use the account issued to you by your administrator.'}</p>
      ${message ? `<div class="notice stop">${esc(message)}</div>` : ''}
      ${setup ? '<label>Setup code<input id="token" autocomplete="off"></label><label>Full name<input id="fullName" autocomplete="name"></label>' : ''}
      <label>${setup ? 'Email' : 'Email or username'}<input id="username" autocomplete="username"></label>
      ${setup ? '<label>Email<input id="email" type="email" autocomplete="email"></label>' : ''}
      <label>Password<input type="password" id="password" autocomplete="current-password"></label>
      <button class="primary" type="submit">${setup ? 'Create administrator' : 'Sign in'}</button>
      ${setup ? '' : '<p class="footnote"><button type="button" class="ghost small" id="forgot">Forgotten your password?</button><br>A reset link is emailed to your registered address. Nobody, including your administrator, can read your existing password.</p>'}
    </form></div></div>`;
  hideMissingLogos(root);
  root.querySelector('#forgot')?.addEventListener('click', forgotPassword);
  const form = root.querySelector('#form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const username = root.querySelector('#username').value.trim(), password = root.querySelector('#password').value;
    try {
      if (setup) {
        await api('/setup', { token: root.querySelector('#token').value.trim(), username, fullName: root.querySelector('#fullName').value.trim(), email: root.querySelector('#email').value.trim(), password });
      }
      auth = await api('/login', { username, password });
      boot = null; page = 'overview';
      render();
    } catch (error) { renderLogin(setup, error.message); }
  });
}

function forgotPassword() {
  openDialog('Forgotten password', `<div class="notice">Enter your registered email address. If it is registered, a one-time reset link is sent to it. The reply is the same either way, so nobody can use this to discover which addresses exist.</div>
    <div class="form-grid"><label class="field full">Registered email<input id="identifier" type="email" autocomplete="email"></label></div>`,
  '<button id="cancel">Cancel</button><button class="primary" id="send">Send reset link</button>');
  dialog.querySelector('#cancel').addEventListener('click', closeDialog);
  dialog.querySelector('#send').addEventListener('click', async () => {
    try {
      const result = await api('/password-reset/request', { identifier: dialog.querySelector('#identifier').value.trim() });
      closeDialog(); toast(result.message);
    } catch (error) { fail(error); }
  });
}

// Opened from the emailed link: /?reset=<token>
function renderReset(token) {
  root.innerHTML = `<div class="login">
    <div class="login-story">
      <div><img class="login-logo" data-logo src="/brand/logo.png" alt=""><h1>Choose a new password</h1>
        <p>The link works once. Setting a new password ends every other session on your account.</p></div>
      <p class="fine-print">Authorized users only. All actions are logged.</p>
    </div>
    <div class="login-form"><form id="reset-form">
      <h2>New password</h2>
      <p class="muted lede">At least 12 characters. Choose something you do not use anywhere else.</p>
      <div id="reset-error"></div>
      <label>New password<input type="password" id="new-password" autocomplete="new-password"></label>
      <label>Repeat it<input type="password" id="again" autocomplete="new-password"></label>
      <button class="primary" type="submit">Set password and sign in</button>
    </form></div></div>`;
  hideMissingLogos(root);
  root.querySelector('#reset-form').addEventListener('submit', async event => {
    event.preventDefault();
    const password = root.querySelector('#new-password').value, again = root.querySelector('#again').value;
    const problem = root.querySelector('#reset-error');
    if (password !== again) { problem.innerHTML = '<div class="notice stop">Those two passwords are different.</div>'; return; }
    try {
      await api('/password-reset/redeem', { token, password });
      history.replaceState(null, '', '/');
      renderLogin(false, '');
      toast('Password set. Sign in with your new password.');
    } catch (error) { problem.innerHTML = `<div class="notice stop">${esc(error.message)}</div>`; }
  });
}

(async function start() {
  const token = new URLSearchParams(location.search).get('reset');
  if (token) { renderReset(token); return; }
  try {
    const current = await api('/session');
    if (current.user) { auth = current; render(); } else renderLogin(current.setup);
  } catch (error) { renderLogin(false, error.message); }
}());
