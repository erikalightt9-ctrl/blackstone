import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fork } from 'node:child_process';
import { z } from 'zod';
import { loadEnvFile } from './env.mjs';
import { Store } from './store.mjs';
import { AppError, permit } from './errors.mjs';
import { loginSchema, passwordSchema, configSchema, cancelSchema, zodMessage } from './schema.mjs';
import { DEFAULT_CONFIG, ROLES, ROLE_LABELS, PAYMENT_METHODS, ACCOUNTING_COPY_ROLES, BANK_TRANSACTION_TYPES, PETTY_CASH_FUND_ROLES, BANK_RECORD_ROLES } from './defaults.mjs';
import { addUser, login, session, logout, changePassword, setDisabled, listUsers, checkLimit, updateUser, requestPasswordReset, sendPasswordReset, redeemPasswordReset, mailConfigured, SESSION_COOKIE } from './auth.mjs';
import { listCategories, createCategory, updateCategory } from './categories.mjs';
import { createRequest, updateRequest, submitRequest, decideRequest, cancelRequest, getRequest, addComment } from './requests.mjs';
import { releasePayment } from './payments.mjs';
import { setOpeningBalance, disburse, recordReturn, recordAdjustment, ledger, createReplenishment, decideReplenishment, fundReplenishment, listReplenishments, getReplenishment } from './pettycash.mjs';
import { listRequests, dashboard } from './search.mjs';
import { runReport, toCsv, reportsFor } from './reports.mjs';
import { uploadDocument, getDocument } from './documents.mjs';
import { requestPdf } from './pdf.mjs';
import { listBankRecords, getBankRecord, createBankRecord, updateBankRecord, voidBankRecord, openBankAccount, ensureBankOpenings } from './bank.mjs';
import { bankImportTemplate, previewBankImport, commitBankImport } from './bank-import.mjs';
import {
  listCurrencies, createCurrency, updateCurrency, removeCurrency,
  listBanks, createBank, updateBank, removeBank,
  listBankAccounts, getBankAccount, createBankAccount, updateBankAccount, removeBankAccount, BANK_ADMIN_ROLES,
} from './accounts.mjs';
import { validateFormat } from './numbering.mjs';
import { loadLogo } from './brand.mjs';
import { STATUSES, STATUS_LABELS, KIND_LABELS } from './workflow.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const STATIC = { '/': ['index.html', 'text/html'], '/brand/logo.png': ['brand/logo.png', 'image/png'], '/brand/mascot.png': ['brand/mascot.png', 'image/png'], '/app.js': ['app.js', 'text/javascript'], '/requests.js': ['requests.js', 'text/javascript'], '/pettycash.js': ['pettycash.js', 'text/javascript'], '/bank.js': ['bank.js', 'text/javascript'], '/accounts.js': ['accounts.js', 'text/javascript'], '/reports.js': ['reports.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

async function readBody(req, maximum = 512_000) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('Use application/json.', 415);
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximum) throw new AppError('The request is too large.', 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Invalid JSON.'); }
}
function constantEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
const numeric = value => (value === null || value === undefined || value === '' ? undefined : Number(value));
function query(url) {
  const get = key => url.searchParams.get(key) || undefined;
  return Object.fromEntries(Object.entries({
    kind: get('kind'), status: get('status'), number: get('number'), requester: get('requester'), payee: get('payee'),
    categoryId: get('categoryId'), approver: get('approver'), checkNumber: get('checkNumber'), paymentStatus: get('paymentStatus'),
    from: get('from'), to: get('to'), text: get('text'),
    minAmount: numeric(get('minAmount')), maxAmount: numeric(get('maxAmount')),
    limit: numeric(get('limit')), offset: numeric(get('offset')),
  }).filter(([, value]) => value !== undefined));
}

const REQUEST_ACTIONS = {
  submit: (store, actor, id) => submitRequest(store, actor, id),
  approve: (store, actor, id, body) => decideRequest(store, actor, id, 'approve', body),
  reject: (store, actor, id, body) => decideRequest(store, actor, id, 'reject', body),
  cancel: (store, actor, id, body) => cancelRequest(store, actor, id, body),
  release: (store, actor, id, body) => releasePayment(store, actor, id, body),
  disburse: (store, actor, id, body) => disburse(store, actor, id, body),
  return: (store, actor, id, body) => recordReturn(store, actor, id, body),
};

// 127.0.0.1 and localhost are the same machine, and a browser will send whichever one the
// address bar holds. Both spellings of the configured loopback origin are accepted; every
// other origin is still refused, which is what stops a cross-site request.
export function loopbackOrigins(origin, extra = '') {
  const allowed = new Set([origin]);
  const match = origin.match(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
  if (match) for (const host of ['127.0.0.1', 'localhost', '[::1]']) allowed.add(`http://${host}${match[2] || ''}`);
  // On a local network the same server is reached by more than one name - its hostname and
  // its address. Each is a distinct origin to the browser, so every one the office actually
  // uses must be listed, or a form posted from the other name is refused as cross-site.
  for (const value of String(extra).split(',').map(v => v.trim()).filter(Boolean)) {
    if (!/^https?:\/\/[^/\s]+$/.test(value)) throw new Error(`FR_EXTRA_ORIGINS must be scheme://host[:port] values, got "${value}"`);
    allowed.add(value);
  }
  return allowed;
}

// Behind a tunnel or reverse proxy every request arrives from the loopback address, which
// would make the per-client login throttle behave as one shared bucket for the whole office.
// The forwarded address is used only when the deployment says a proxy is really in front,
// because a client can otherwise set these headers itself.
// A forwarded address is only worth anything if the thing that forwarded it is the proxy and
// not the visitor. Caddy and the Cloudflare tunnel both connect from this machine, so a header
// is honoured only when the connection itself came from the loopback address. Without that
// check, anyone who could reach the port directly would set their own address on every request
// and walk straight through the per-source limits.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientAddress(req, trustProxy = false) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (trustProxy && LOOPBACK.has(peer)) {
    const cloudflare = req.headers['cf-connecting-ip'];
    if (typeof cloudflare === 'string' && cloudflare.trim()) return cloudflare.trim().slice(0, 64);
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return peer;
}

export function createApp({ store, origin, setupToken, logo = null, extraOrigins = '', trustProxy = false }) {
  const secure = origin.startsWith('https:');
  const allowedOrigins = loopbackOrigins(origin, extraOrigins);
  return http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin), pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        const file = STATIC[pathname];
        if (req.method !== 'GET' || !file) throw new AppError('Not found.', 404);
        const body = await readFile(path.join(directory, '../public', file[0]));
        res.writeHead(200, { 'Content-Type': file[1].startsWith('text/') ? `${file[1]}; charset=utf-8` : file[1] }); res.end(body); return;
      }
      const mutation = req.method !== 'GET';
      if (mutation && !allowedOrigins.has(req.headers.origin)) throw new AppError('Request origin is not allowed.', 403);
      const client = clientAddress(req, trustProxy);

      if (pathname === '/api/session' && req.method === 'GET') {
        const auth = session(store, req.headers.cookie);
        send(200, { user: auth?.user || null, csrf: auth?.csrf || null, setup: store.get('SELECT COUNT(*) AS n FROM users').n === 0 });
        return;
      }
      if (pathname === '/api/setup' && req.method === 'POST') {
        checkLimit(store, `setup:${client}`);
        const { token, ...body } = await readBody(req);
        if (typeof token !== 'string' || !setupToken || !constantEqual(token, setupToken)) throw new AppError('The setup code is incorrect.', 403);
        send(201, { user: await addUser(store, { ...body, role: 'admin' }) });
        return;
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        const body = loginSchema.parse(await readBody(req));
        const auth = await login(store, body.username, body.password, `login:${client}`);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${auth.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
        send(200, { user: auth.user, csrf: auth.csrf });
        return;
      }

      // Password reset is reachable without a session, and deliberately says the same thing
      // whether or not the address is registered.
      if (pathname === '/api/password-reset/request' && req.method === 'POST') {
        checkLimit(store, `reset-request:${client}`, 20);
        send(200, await requestPasswordReset(store, await readBody(req)));
        return;
      }
      if (pathname === '/api/password-reset/redeem' && req.method === 'POST') {
        checkLimit(store, `reset-redeem:${client}`, 20);
        send(200, await redeemPasswordReset(store, await readBody(req)));
        return;
      }

      const auth = session(store, req.headers.cookie);
      if (!auth) throw new AppError('Please sign in.', 401);
      const actor = auth.user;
      if (mutation && !constantEqual(String(req.headers['x-csrf-token'] || ''), auth.csrf)) throw new AppError('Your session token is invalid. Reload the page and try again.', 403);

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const alive = () => !!session(store, req.headers.cookie);
        res.write('event: ready\ndata: {}\n\n');
        const stop = store.onChange(() => { if (!alive()) { res.end(); return; } res.write(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`); });
        const beat = setInterval(() => { if (!alive()) res.end(); else res.write(': heartbeat\n\n'); }, 15000);
        res.on('close', () => { clearInterval(beat); stop(); });
        return;
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        logout(store, auth.tokenHash);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
        send(200, { ok: true }); return;
      }
      if (pathname === '/api/password' && req.method === 'POST') {
        checkLimit(store, `password:${actor.id}`);
        const body = passwordSchema.parse(await readBody(req));
        send(200, await changePassword(store, actor, body.currentPassword, body.newPassword)); return;
      }
      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const seesBank = [...BANK_RECORD_ROLES, 'viewer'].includes(actor.role);
        send(200, {
          user: actor, config: store.config(), categories: listCategories(store, { includeInactive: actor.role === 'admin' }),
          dashboard: dashboard(store, actor), reports: reportsFor(actor), statuses: STATUSES.map(id => ({ id, label: STATUS_LABELS[id] })),
          kinds: Object.entries(KIND_LABELS).map(([id, label]) => ({ id, label })), paymentMethods: PAYMENT_METHODS,
          roles: ROLES.map(id => ({ id, label: ROLE_LABELS[id] })), canPrintAccountingCopy: ACCOUNTING_COPY_ROLES.includes(actor.role),
          bankTypes: BANK_TRANSACTION_TYPES,
          // The company's bank accounts are not sent to somebody who may not see them. A
          // requester files requests and has no business knowing which accounts exist, so the
          // list is absent from their payload rather than merely hidden on their screen.
          ...(seesBank ? { bankAccounts: listBankAccounts(store, actor), banks: listBanks(store, actor), currencies: listCurrencies(store, actor) }
            : { bankAccounts: [], banks: [], currencies: [] }),
          canSeePettyCashFund: PETTY_CASH_FUND_ROLES.includes(actor.role),
          canEncodeBankRecords: BANK_RECORD_ROLES.includes(actor.role),
          canVoidBankRecords: ['admin', 'approver'].includes(actor.role),
          canManageBankAccounts: BANK_ADMIN_ROLES.includes(actor.role),
          mailConfigured: mailConfigured(),
        });
        return;
      }
      if (pathname === '/api/dashboard' && req.method === 'GET') { send(200, dashboard(store, actor)); return; }
      if (pathname === '/api/audit' && req.method === 'GET') { permit(actor, ['admin', 'approver']); send(200, store.auditTrail(Number(url.searchParams.get('limit')) || 300)); return; }

      if (pathname === '/api/categories') {
        if (req.method === 'GET') { send(200, listCategories(store, { includeInactive: url.searchParams.get('all') === '1' })); return; }
        if (req.method === 'POST') { send(201, createCategory(store, actor, await readBody(req))); return; }
      }
      const categoryRoute = pathname.match(/^\/api\/categories\/([0-9a-f-]{36})$/);
      if (categoryRoute && req.method === 'POST') { send(200, updateCategory(store, actor, categoryRoute[1], await readBody(req))); return; }

      if (pathname === '/api/requests') {
        if (req.method === 'GET') { send(200, listRequests(store, actor, query(url))); return; }
        if (req.method === 'POST') { send(201, createRequest(store, actor, await readBody(req))); return; }
      }
      const requestRoute = pathname.match(/^\/api\/requests\/([0-9a-f-]{36})(?:\/([a-z-]+))?$/);
      if (requestRoute) {
        const [, id, segment] = requestRoute;
        if (req.method === 'GET' && !segment) { send(200, getRequest(store, actor, id)); return; }
        if (req.method === 'GET' && segment === 'pdf') {
          const accounting = url.searchParams.get('copy') === 'accounting';
          if (accounting) permit(actor, ACCOUNTING_COPY_ROLES);
          const request = getRequest(store, actor, id);
          const pdf = requestPdf(request, store.config(), { accounting, logo });
          store.log(actor, 'print', 'request', id, { status: request.status, detail: `${accounting ? 'Accounting / Internal' : 'Standard'} copy printed` });
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${request.number}${accounting ? '-accounting' : ''}.pdf"` });
          res.end(pdf); return;
        }
        if (req.method === 'POST' && !segment) { send(200, updateRequest(store, actor, id, await readBody(req))); return; }
        if (req.method === 'POST' && segment === 'documents') { send(201, uploadDocument(store, actor, id, await readBody(req, 9_800_000))); return; }
        if (req.method === 'POST' && segment === 'comment') { send(201, addComment(store, actor, id, await readBody(req))); return; }
        if (req.method === 'POST' && REQUEST_ACTIONS[segment]) { send(200, REQUEST_ACTIONS[segment](store, actor, id, await readBody(req))); return; }
      }
      const documentRoute = pathname.match(/^\/api\/documents\/([0-9a-f-]{36})\/content$/);
      if (documentRoute && req.method === 'GET') {
        const document = getDocument(store, actor, documentRoute[1]);
        res.writeHead(200, { 'Content-Type': document.mime, 'Content-Disposition': `attachment; filename="supporting-document"; filename*=UTF-8''${encodeURIComponent(document.name)}` });
        res.end(Buffer.from(document.content)); return;
      }

      if (pathname.startsWith('/api/petty-cash') || pathname.startsWith('/api/replenishments')) permit(actor, PETTY_CASH_FUND_ROLES);
      if (pathname === '/api/petty-cash' && req.method === 'GET') {
        send(200, { ...ledger(store, { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '', type: url.searchParams.get('type') || '', limit: Number(url.searchParams.get('limit')) || 200 }), replenishments: listReplenishments(store) });
        return;
      }
      if (pathname === '/api/petty-cash/open' && req.method === 'POST') { send(201, setOpeningBalance(store, actor, await readBody(req))); return; }
      if (pathname === '/api/petty-cash/adjust' && req.method === 'POST') { send(201, recordAdjustment(store, actor, await readBody(req))); return; }
      if (pathname === '/api/replenishments') {
        if (req.method === 'GET') { send(200, listReplenishments(store)); return; }
        if (req.method === 'POST') { send(201, createReplenishment(store, actor, await readBody(req))); return; }
      }
      const replenishmentRoute = pathname.match(/^\/api\/replenishments\/([0-9a-f-]{36})\/(approve|reject|fund)$/);
      if (replenishmentRoute && req.method === 'POST') {
        const [, id, action] = replenishmentRoute;
        const body = await readBody(req);
        if (action === 'fund') { send(200, fundReplenishment(store, actor, id, body)); return; }
        send(200, decideReplenishment(store, actor, id, action === 'approve', String(body.remarks || '').slice(0, 2000))); return;
      }
      const replenishmentDetail = pathname.match(/^\/api\/replenishments\/([0-9a-f-]{36})$/);
      if (replenishmentDetail && req.method === 'GET') { send(200, getReplenishment(store, replenishmentDetail[1])); return; }

      if (pathname === '/api/bank') {
        if (req.method === 'GET') {
          send(200, listBankRecords(store, actor, {
            accountId: url.searchParams.get('accountId') || '', from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '',
            text: url.searchParams.get('text') || '', includeVoided: url.searchParams.get('voided') !== '0',
            limit: Number(url.searchParams.get('limit')) || 200,
          }));
          return;
        }
        if (req.method === 'POST') { send(201, createBankRecord(store, actor, await readBody(req))); return; }
      }
      if (pathname === '/api/currencies') {
        if (req.method === 'GET') { send(200, listCurrencies(store, actor)); return; }
        if (req.method === 'POST') { send(201, createCurrency(store, actor, await readBody(req))); return; }
      }
      const currencyRoute = pathname.match(/^\/api\/currencies\/([A-Za-z]{2,6})$/);
      if (currencyRoute) {
        if (req.method === 'POST') { send(200, updateCurrency(store, actor, currencyRoute[1].toUpperCase(), await readBody(req))); return; }
        if (req.method === 'DELETE') { send(200, removeCurrency(store, actor, currencyRoute[1].toUpperCase())); return; }
      }

      if (pathname === '/api/banks') {
        if (req.method === 'GET') { send(200, listBanks(store, actor)); return; }
        if (req.method === 'POST') { send(201, createBank(store, actor, await readBody(req))); return; }
      }
      const bankOrgRoute = pathname.match(/^\/api\/banks\/([0-9a-f-]{36})$/);
      if (bankOrgRoute) {
        if (req.method === 'POST') { send(200, updateBank(store, actor, bankOrgRoute[1], await readBody(req))); return; }
        if (req.method === 'DELETE') { send(200, removeBank(store, actor, bankOrgRoute[1])); return; }
      }

      if (pathname === '/api/bank-accounts') {
        if (req.method === 'GET') { send(200, listBankAccounts(store, actor)); return; }
        if (req.method === 'POST') { send(201, createBankAccount(store, actor, await readBody(req))); return; }
      }
      const accountRoute = pathname.match(/^\/api\/bank-accounts\/([0-9a-f-]{36})$/);
      if (accountRoute) {
        if (req.method === 'GET') { send(200, getBankAccount(store, actor, accountRoute[1])); return; }
        if (req.method === 'POST') { send(200, updateBankAccount(store, actor, accountRoute[1], await readBody(req))); return; }
        if (req.method === 'DELETE') { send(200, removeBankAccount(store, actor, accountRoute[1])); return; }
      }

      // The template is generated from this database, so its dropdowns can only offer
      // accounts and types that actually exist.
      if (pathname === '/api/bank/template' && req.method === 'GET') {
        const workbook = bankImportTemplate(store, actor);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="bank-records-template.xlsx"',
          'Content-Length': workbook.length,
        });
        res.end(workbook); return;
      }
      // Two steps on purpose: a preview writes nothing, and the commit refuses the whole
      // file if any row in it cannot be read.
      if (pathname === '/api/bank/import/preview' && req.method === 'POST') {
        send(200, previewBankImport(store, actor, await readBody(req, 8_400_000))); return;
      }
      if (pathname === '/api/bank/import' && req.method === 'POST') {
        send(201, commitBankImport(store, actor, await readBody(req, 8_400_000))); return;
      }

      if (pathname === '/api/bank/open' && req.method === 'POST') {
        send(201, openBankAccount(store, actor, await readBody(req)));
        return;
      }
      const bankRoute = pathname.match(/^\/api\/bank\/([0-9a-f-]{36})(?:\/(void))?$/);
      if (bankRoute) {
        const [, bankId, action] = bankRoute;
        if (req.method === 'GET' && !action) { send(200, getBankRecord(store, actor, bankId)); return; }
        if (req.method === 'POST' && !action) { send(200, updateBankRecord(store, actor, bankId, await readBody(req))); return; }
        if (req.method === 'POST' && action === 'void') { send(200, voidBankRecord(store, actor, bankId, await readBody(req))); return; }
      }

      const reportRoute = pathname.match(/^\/api\/reports\/([a-z-]+?)(\.csv)?$/);
      if (reportRoute && req.method === 'GET') {
        const result = runReport(store, actor, reportRoute[1], query(url));
        if (reportRoute[2]) {
          store.log(actor, 'export', 'report', reportRoute[1], { detail: `${result.title} exported to CSV` });
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${reportRoute[1]}.csv"` });
          res.end(`﻿${toCsv(result)}`); return;
        }
        send(200, result); return;
      }

      if (pathname === '/api/config') {
        if (req.method === 'GET') { send(200, store.config()); return; }
        if (req.method === 'POST') {
          permit(actor, ['admin']);
          const body = configSchema.parse(await readBody(req));
          store.transaction(() => {
            const before = store.config();
            for (const [key, value] of Object.entries(body)) {
              if (key.endsWith('NumberFormat')) validateFormat(value);
              store.setConfig(key, value);
            }
            const after = store.config();
            if (!after.finalApprovers.includes(after.defaultFinalApprover)) throw new AppError('The default final approver must be one of the authorized final approvers.');
            store.log(actor, 'update', 'config', 'config', { detail: `Configuration updated: ${Object.keys(body).join(', ')}`, before, after });
          });
          send(200, store.config()); return;
        }
      }

      if (pathname === '/api/users') {
        if (req.method === 'GET') { send(200, listUsers(store, actor)); return; }
        if (req.method === 'POST') { send(201, await addUser(store, await readBody(req), actor)); return; }
      }
      const userRoute = pathname.match(/^\/api\/users\/([0-9a-f-]{36})(?:\/(send-reset|access))?$/);
      if (userRoute && req.method === 'POST') {
        permit(actor, ['admin']);
        const [, userId, action] = userRoute;
        if (action === 'send-reset') { send(200, await sendPasswordReset(store, actor, userId)); return; }
        if (action === 'access') { send(200, setDisabled(store, actor, userId, z.boolean().parse((await readBody(req)).disabled))); return; }
        send(200, updateUser(store, actor, userId, await readBody(req))); return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof z.ZodError) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: zodMessage(error) })); return; }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status === 500) console.error('Request failed:', error);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'The request could not be completed. Check the server log and try again.' : error.message }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Read before anything looks at the environment, so a local .env can supply the mail
  // settings. Only the names are printed: the mail password must never reach a log.
  const fromFile = loadEnvFile(path.join(directory, '../.env'));
  if (fromFile.length) console.log(`Loaded from .env: ${fromFile.join(', ')}`);

  // PORT is what a container host injects; FR_PORT still wins so an office install is unaffected.
  const host = process.env.FR_HOST || '127.0.0.1', port = Number(process.env.FR_PORT || process.env.PORT || 3403);
  const origin = process.env.FR_ORIGIN || `http://127.0.0.1:${port}`;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !origin.startsWith('https://')) throw new Error('Remote hosting requires an HTTPS FR_ORIGIN behind a TLS reverse proxy.');
  const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
  await mkdir(dataDirectory, { recursive: true });
  const store = new Store(path.join(dataDirectory, 'finance.sqlite'));
  for (const opened of ensureBankOpenings(store)) {
    console.log(`Bank Records: ${opened.account} given a beginning balance of ${opened.opening.toFixed(2)} from its first encoded line; balance now ${opened.balance.toFixed(2)}.`);
  }
  const setupToken = process.env.FR_SETUP_TOKEN || randomBytes(24).toString('hex');
  // The address in a reset email is the one people actually open, not the loopback bind.
  if (store.config().appUrl !== origin) store.setConfig('appUrl', origin);
  const app = createApp({ store, origin, setupToken, logo: await loadLogo(), extraOrigins: process.env.FR_EXTRA_ORIGINS || '', trustProxy: process.env.FR_TRUST_PROXY === '1' });
  app.requestTimeout = 20000; app.headersTimeout = 10000;
  app.listen(port, host, () => {
    console.log(`${store.config().companyName || DEFAULT_CONFIG.companyName} - Financial Monitoring is running at ${origin}`);
    if (!store.get('SELECT COUNT(*) AS n FROM users').n) console.log(`One-time setup code: ${setupToken}\nOpen the application to create the first administrator account.`);
  });
  // On a machine with a task scheduler, backups are a scheduled task and this stays off. On a
  // container host there is no scheduler, so the service takes its own - as a separate child
  // process, so a failed backup can never take the service down with it.
  const everyMinutes = Number(process.env.FR_BACKUP_EVERY_MINUTES || 0);
  let backupTimer = null;
  if (everyMinutes > 0) {
    const script = path.join(directory, '../scripts/backup.mjs');
    const runBackup = () => {
      const child = fork(script, { stdio: 'inherit' });
      child.on('error', error => console.error('Backup could not start:', error.message));
      child.on('exit', code => { if (code) console.error(`Backup exited with code ${code}.`); });
    };
    backupTimer = setInterval(runBackup, everyMinutes * 60_000);
    backupTimer.unref();
    console.log(`Backups every ${everyMinutes} minute(s), keeping ${process.env.FR_KEEP_BACKUPS || 240}.`);
    runBackup();
  }

  const close = () => {
    if (backupTimer) clearInterval(backupTimer);
    app.closeAllConnections();
    app.close(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
