// Bank Account Management: the company's banks, the accounts held with them, and the
// currencies those accounts are kept in. Nothing here is fixed by the system - a bank, an
// account or a currency is added, renamed and retired by whoever is authorised to.
export function createAccountsView(ctx) {
  const { api, esc, cash, stamp, toast, fail, openDialog, closeDialog, refresh } = ctx;
  let host = null, tab = 'accounts';

  const boot = () => ctx.boot;

  async function render(target) {
    host = target;
    host.innerHTML = '<div class="loading">Loading bank accounts&hellip;</div>';
    let accounts, banks, currencies;
    try {
      [accounts, banks, currencies] = await Promise.all([api('/bank-accounts'), api('/banks'), api('/currencies')]);
    } catch (error) { fail(error); host.innerHTML = '<div class="empty">Could not load the bank accounts.</div>'; return; }

    const counts = { accounts: accounts.length, banks: banks.length, currencies: currencies.length };
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Reference data</div><h1>Bank Accounts</h1>
        <p class="muted">${counts.accounts} account${counts.accounts === 1 ? '' : 's'} across ${counts.banks} bank${counts.banks === 1 ? '' : 's'} in ${new Set(accounts.map(a => a.currency)).size || 0} currenc${new Set(accounts.map(a => a.currency)).size === 1 ? 'y' : 'ies'}</p></div>
      <div class="actions">
        <button id="new-currency">Add currency</button>
        <button id="new-bank">Add bank</button>
        <button class="primary" id="new-account"${banks.length ? '' : ' disabled title="Add a bank first"'}>Add bank account</button>
      </div></div>
      ${banks.length ? '' : '<div class="notice">Start by adding a <strong>bank</strong>. Then add the accounts held with it, each with its own number, currency and account type.</div>'}

      <section class="panel">
        <div class="tabs">
          ${['accounts', 'banks', 'currencies'].map(id => `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${id[0].toUpperCase()}${id.slice(1)} <span class="count">${counts[id]}</span></button>`).join('')}
        </div>
        <div class="scroll">${tab === 'accounts' ? accountTable(accounts) : tab === 'banks' ? bankTable(banks) : currencyTable(currencies)}</div>
        <div class="module-foot"><span>An account holding passbook entries is deactivated, never deleted - its records are permanent.</span>
          <span>Every change is recorded with who made it and when.</span></div>
      </section>`;

    host.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab; render(host); }));
    host.querySelector('#new-account')?.addEventListener('click', () => accountForm(null, banks, currencies));
    host.querySelector('#new-bank').addEventListener('click', () => bankForm(null));
    host.querySelector('#new-currency').addEventListener('click', () => currencyForm(null));
    host.querySelectorAll('[data-account]').forEach(row => row.addEventListener('click', () => {
      accountForm(accounts.find(a => a.id === row.dataset.account), banks, currencies);
    }));
    host.querySelectorAll('[data-bank]').forEach(row => row.addEventListener('click', () => bankForm(banks.find(b => b.id === row.dataset.bank))));
    host.querySelectorAll('[data-currency]').forEach(row => row.addEventListener('click', () => currencyForm(currencies.find(c => c.code === row.dataset.currency))));
  }

  const state = item => item.active ? '' : '<span class="chip muted">Not in use</span>';

  const accountTable = rows => rows.length ? `<table><thead><tr><th>Bank</th><th>Account name</th><th>Account number</th>
      <th>Currency</th><th>Type</th><th class="right">Balance</th></tr></thead><tbody>
    ${rows.map(row => `<tr class="clickable${row.active ? '' : ' voided'}" data-account="${row.id}">
      <td><strong>${esc(row.bankName)}</strong>${row.bankActive ? '' : '<small class="muted">bank not in use</small>'}</td>
      <td>${esc(row.accountName)}${row.description ? `<small>${esc(row.description)}</small>` : ''} ${state(row)}</td>
      <td><span class="ref">${esc(row.accountNumber || '—')}</span></td>
      <td>${esc(row.currency)}<small>${esc(row.currencyName)}</small></td>
      <td>${esc(row.accountType || '—')}</td>
      <td class="right">${row.opened ? `<strong>${cash(row.balance, row.currencySymbol, row.currencyDecimals)}</strong><small>${row.entries} entr${row.entries === 1 ? 'y' : 'ies'}</small>`
        : '<small class="muted">no beginning balance yet</small>'}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><strong>No bank accounts yet</strong>Add a bank, then the accounts held with it.</div>';

  const bankTable = rows => rows.length ? `<table><thead><tr><th>Bank</th><th>Short name</th><th>Country</th><th class="right">Accounts</th></tr></thead><tbody>
    ${rows.map(row => `<tr class="clickable${row.active ? '' : ' voided'}" data-bank="${row.id}">
      <td><strong>${esc(row.name)}</strong> ${state(row)}</td>
      <td>${esc(row.shortName || '—')}</td>
      <td>${esc(row.country || '—')}</td>
      <td class="right">${row.accounts}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><strong>No banks yet</strong>Add the first one to start recording accounts.</div>';

  const currencyTable = rows => rows.length ? `<table><thead><tr><th>Code</th><th>Currency</th><th>Symbol</th>
      <th class="right">Decimal places</th><th class="right">Accounts</th></tr></thead><tbody>
    ${rows.map(row => `<tr class="clickable${row.active ? '' : ' voided'}" data-currency="${row.code}">
      <td><strong>${esc(row.code)}</strong> ${state(row)}</td>
      <td>${esc(row.name)}</td>
      <td>${esc(row.symbol || '—')}</td>
      <td class="right">${row.decimals}</td>
      <td class="right">${row.accounts}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty"><strong>No currencies on the list</strong>Add the currencies the company holds accounts in.</div>';

  // ---------------------------------------------------------------- forms

  const field = ([id, label, type, options, value, locked]) => {
    const off = locked ? ' disabled' : '';
    if (type === 'textarea') return `<label class="field full">${esc(label)}<textarea id="${id}"${off}>${esc(value || '')}</textarea></label>`;
    if (type === 'checkbox') return `<label class="field check"><input type="checkbox" id="${id}"${value ? ' checked' : ''}${off}> ${esc(label)}</label>`;
    if (type === 'select') return `<label class="field">${esc(label)}<select id="${id}"${off}>${(options || [])
      .map(option => `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label>`;
    return `<label class="field">${esc(label)}<input id="${id}" type="${type === 'number' ? 'number' : 'text'}"${type === 'number' ? ' step="1" min="0" max="6"' : ''} value="${esc(value ?? '')}"${options?.list ? ` list="${options.list}"` : ''}${off}></label>`;
  };

  const collect = fields => {
    const body = {};
    for (const [id, , type, , fallback, locked] of fields) {
      const element = document.querySelector(`#${id}`);
      if (locked) { body[id] = fallback; continue; }
      body[id] = type === 'checkbox' ? element.checked : type === 'number' ? Number(element.value) : element.value.trim();
    }
    return body;
  };

  async function submit(fields, url, done, method) {
    try {
      await api(url, method === 'DELETE' ? undefined : collect(fields), method);
      closeDialog(); toast(done);
      await refresh({ silent: true });
      await render(host);
    } catch (error) { fail(error); }
  }

  function dialog({ title, notice, fields, save, url, done, remove }) {
    openDialog(title,
      `${notice ? `<div class="notice">${notice}</div>` : ''}<div class="form-grid">${fields.map(field).join('')}</div>`,
      `${remove ? `<button class="danger" id="remove">${esc(remove.label)}</button>` : ''}
       <button id="cancel">Cancel</button><button class="primary" id="save">${esc(save)}</button>`);
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#save').addEventListener('click', () => submit(fields, url, done));
    document.querySelector('#remove')?.addEventListener('click', () => confirmRemove(remove));
  }

  // Removal is only ever offered; whether it is allowed is the server's decision, and it
  // refuses anything that already holds records.
  function confirmRemove({ url, done, warning }) {
    openDialog('Remove permanently',
      `<div class="notice stop">${warning}</div>`,
      '<button id="back">Back</button><button class="primary danger" id="confirm">Remove</button>');
    document.querySelector('#back').addEventListener('click', closeDialog);
    document.querySelector('#confirm').addEventListener('click', () => submit([], url, done, 'DELETE'));
  }

  function accountForm(account, banks, currencies) {
    const usable = banks.filter(bank => bank.active || bank.id === account?.bankId);
    const offered = currencies.filter(currency => currency.active || currency.code === account?.currency);
    const fields = [
      ['bankId', 'Bank', 'select', usable.map(bank => ({ value: bank.id, label: bank.active ? bank.name : `${bank.name} (not in use)` })), account?.bankId || usable[0]?.id],
      ['accountName', 'Account name', 'text', null, account?.accountName || ''],
      ['accountNumber', 'Account number', 'text', null, account?.accountNumber || ''],
      ['currency', account?.entries ? 'Currency (fixed - the account holds entries)' : 'Currency', 'select',
        offered.map(currency => ({ value: currency.code, label: `${currency.code} - ${currency.name}` })),
        account?.currency || boot().config.baseCurrency || offered[0]?.code, !!account?.entries],
      ['accountType', 'Account type', 'text', { list: 'account-types' }, account?.accountType || ''],
      ['description', 'Description / label', 'text', null, account?.description || ''],
      ['active', 'In use - new entries may be encoded against this account', 'checkbox', null, account ? account.active : true],
    ];
    const types = boot().config.accountTypes || [];
    openDialog(account ? `${account.bankName} · ${account.accountName}` : 'Add bank account',
      `<div class="notice">${account
        ? `Renaming the bank or correcting the number changes how this account reads everywhere at once.${account.entries ? ` This account holds ${account.entries} passbook entr${account.entries === 1 ? 'y' : 'ies'}, so its currency is now fixed at ${esc(account.currency)}.` : ''}`
        : 'The account number is what the passbook prints. The currency decides how amounts on this account are entered and shown, and cannot be changed once entries exist.'}</div>
       <div class="form-grid">${fields.map(field).join('')}</div>
       <datalist id="account-types">${types.map(type => `<option value="${esc(type)}"></option>`).join('')}</datalist>
       ${account ? `<p class="muted sub-note">Added by ${esc(account.createdBy)} ${esc(stamp(account.createdAt))}${account.updatedBy ? ` &middot; last changed by ${esc(account.updatedBy)} ${esc(stamp(account.updatedAt))}` : ''}</p>` : ''}`,
      `${account ? '<button class="danger" id="remove">Remove</button>' : ''}
       <button id="cancel">Cancel</button><button class="primary" id="save">${account ? 'Save account' : 'Add account'}</button>`);
    document.querySelector('#cancel').addEventListener('click', closeDialog);
    document.querySelector('#save').addEventListener('click', () => submit(fields, account ? `/bank-accounts/${account.id}` : '/bank-accounts',
      account ? 'Bank account updated.' : 'Bank account added.'));
    document.querySelector('#remove')?.addEventListener('click', () => confirmRemove({
      url: `/bank-accounts/${account.id}`,
      done: 'Bank account removed.',
      warning: account.entries
        ? `<strong>${esc(account.display)}</strong> holds ${account.entries} passbook entr${account.entries === 1 ? 'y' : 'ies'}. Those records are permanent, so this will be refused. Untick <strong>In use</strong> instead - the history stays readable and nothing new can be encoded against it.`
        : `<strong>${esc(account.display)}</strong> is still empty, so it can be removed outright. The removal itself stays in the history.`,
    }));
  }

  function bankForm(bank) {
    const fields = [
      ['name', 'Bank name', 'text', null, bank?.name || ''],
      ['shortName', 'Short name', 'text', null, bank?.shortName || ''],
      ['country', 'Country', 'text', null, bank?.country || ''],
      ['active', 'In use - accounts at this bank may be used', 'checkbox', null, bank ? bank.active : true],
    ];
    dialog({
      title: bank ? `Bank · ${bank.name}` : 'Add bank',
      notice: bank
        ? `Renaming this bank renames it on every account and every passbook entry at once.${bank.accounts ? ` It holds ${bank.accounts} account${bank.accounts === 1 ? '' : 's'}.` : ''}`
        : 'A bank can be local or international. Add its accounts next.',
      fields,
      save: bank ? 'Save bank' : 'Add bank',
      url: bank ? `/banks/${bank.id}` : '/banks',
      done: bank ? 'Bank updated.' : 'Bank added.',
      remove: bank ? {
        url: `/banks/${bank.id}`,
        done: 'Bank removed.',
        warning: bank.accounts
          ? `<strong>${esc(bank.name)}</strong> still holds ${bank.accounts} account${bank.accounts === 1 ? '' : 's'}. Remove or move those first, or untick <strong>In use</strong> instead.`
          : `<strong>${esc(bank.name)}</strong> holds no accounts, so it can be removed outright.`,
      } : null,
    });
  }

  function currencyForm(currency) {
    const fields = [
      ...(currency ? [] : [['code', 'Currency code', 'text', null, '']]),
      ['name', 'Currency name', 'text', null, currency?.name || ''],
      ['symbol', 'Symbol', 'text', null, currency?.symbol || ''],
      ['decimals', currency?.accounts ? 'Decimal places (fixed - the currency is in use)' : 'Decimal places', 'number', null, currency?.decimals ?? 2, !!currency?.accounts],
      ['active', 'In use - accounts may be recorded in this currency', 'checkbox', null, currency ? currency.active : true],
    ];
    dialog({
      title: currency ? `Currency · ${currency.code}` : 'Add currency',
      notice: currency
        ? `Decimal places decide how amounts in ${esc(currency.code)} are entered and shown.${currency.accounts ? ` ${esc(currency.code)} is used by ${currency.accounts} account${currency.accounts === 1 ? '' : 's'}, so that figure is now fixed.` : ''}`
        : 'Any currency the company holds an account in. Decimal places are usually 2, but some currencies have none - the yen, for one - and amounts are then entered as whole numbers.',
      fields,
      save: currency ? 'Save currency' : 'Add currency',
      url: currency ? `/currencies/${currency.code}` : '/currencies',
      done: currency ? 'Currency updated.' : 'Currency added.',
      remove: currency ? {
        url: `/currencies/${currency.code}`,
        done: 'Currency removed.',
        warning: currency.accounts
          ? `<strong>${esc(currency.code)}</strong> is used by ${currency.accounts} bank account${currency.accounts === 1 ? '' : 's'}. Untick <strong>In use</strong> instead, which keeps those accounts readable but offers it to nothing new.`
          : `<strong>${esc(currency.code)}</strong> is used by no accounts, so it can be removed from the list.`,
      } : null,
    });
  }

  return { render };
}
