# Financial Monitoring

**BLACK STONE MINERAL RESOURCES INC**

A controlled, traceable and audit-ready financial request system. Every request, approval,
payment, cancellation, petty cash movement and replenishment can be traced from creation
through final settlement without altering the historical financial record.

Two modules share one Maker–Approver control structure:

| Module | Numbering | Settles by |
| --- | --- | --- |
| **Payment Request** | `PR-2026-000001` | Check or transfer, recorded then released |
| **Petty Cash Request** | `PCR-2026-000001` | Cash disbursed from the petty cash fund |

A third module, **Bank Records**, transcribes the official bank passbook.

## Running it

Requires **Node.js 24.14 or later**. No build step and two dependencies: Zod for validation, nodemailer for the reset emails.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:3403>. On first run the terminal prints a one-time setup code; enter it
to create the first administrator. Setup stops accepting new initial administrators once that
account exists. Records live in `data/finance.sqlite`, which is Git-ignored and must never be
copied into a public folder.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the service on port 3403 |
| `npm test` | Run the whole test suite |
| `npm run coverage` | Run the suite and fail below 80% lines, branches and functions |
| `npm run seed:demo` | Fill an **empty** database with fictional demo data for review |

Environment: `FR_PORT`, `FR_HOST`, `FR_ORIGIN`, `FR_DATA_DIR`, `FR_SETUP_TOKEN`. Hosting the
service anywhere other than loopback requires an HTTPS `FR_ORIGIN` behind a TLS reverse proxy;
the server refuses to start otherwise.

## Roles

Two kinds of people use this system, and a third approves without ever signing in.

| Role | Can do |
| --- | --- |
| **Maker** | Create and edit drafts, submit them, attach documents, follow their own requests through to the payment details, and encode and correct Bank Records |
| **Releaser** | Record the signed approval, reject or cancel any request, then release the payment or disburse the cash; approve and fund replenishments; review, correct and void Bank Records |
| **Administrator / Releaser** | Everything above, plus accounts, configuration, the category master list, opening the fund and documented fund adjustments |
| **Viewer** | Read-only access to every request and to Bank Records |

**The petty cash fund balance is restricted.** A maker files petty cash requests but is never
shown what is in the box: the balance, the ledger, the replenishments and every figure derived
from them are left out of the payload a maker receives, and the fund routes refuse them
outright. The restriction is in the API, not just the screen. It extends to reporting — the
**Petty Cash Ledger** and **Petty Cash Replenishment History** reports are neither offered to
a maker nor runnable by one, so the figure cannot be read out through the back door.

**Maker–Approver separation is enforced:** whoever prepared a request can never approve it,
administrators included. Makers see only the requests they prepared; approvers and viewers see
them all.

**A request belongs to its maker.** Full visibility does not carry the right to rewrite someone
else's figures: only the maker who prepared a draft may edit or submit it, and an administrator
is no exception. A reviewer who spots a discrepancy leaves a **comment** instead — permanent,
attributed, visible to the maker on the request and flagged in their list — and the maker
corrects their own draft. After approval nothing is editable by anyone; a correction means
cancelling and re-filing. This keeps the integrity of the original request intact while the
reviewer still validates it before release.

**The approvers hold no account.** `Demry Cheng` and `Vicente Cheng` approve by signing the
printed form. They never sign in, and the system holds no login for either of them — they
exist only as the two choices in the **Approved By** dropdown, and as the name printed on the
Approved By line of the PDF.

What the system records is that signature. A releaser opens the returned, signed form and uses
**Record approval**, which files who signed it, who recorded it, and when. The request's own
history keeps the two apart:

> *Approval recorded — printed form signed by Demry Cheng* — Erika Hernando, 21 Sep 2026

So the request carries both the authority (the signatory on the paper) and the accountability
(the member of staff who entered it). A maker can never record the approval of their own
request.

## Workflow

```
              Maker            on paper              Releaser          Releaser
Payment   Draft → For Approval → signed by Cheng → Approved → Released
Petty cash Draft → For Approval → signed by Cheng → Approved → Disbursed
                       ↘ Rejected                      ↘ Cancelled (from any live status)
```

Releasing a payment records the check or transfer details **and** the release in one step, as
a payment record attached to the approved request. Disbursing petty cash reduces the fund in
the same single step.

- A request is editable **only** while it is a Draft. This is enforced by the service *and* by
  database triggers on the expense lines.
- Once **Approved**, the financial information is permanently locked. A correction means
  cancelling the transaction and filing a new one.
- **Nothing is ever hard deleted.** Cancelled and rejected records stay searchable and are
  clearly marked `CANCELLED`, with who cancelled it, when, why, and the previous status.

## Petty cash fund

The fund balance is automatic and always the last ledger entry:

- The fund is **opened once** with its opening balance.
- A disbursement reduces the fund **on actual disbursement**, never on creation or approval.
- Funding a replenishment increases it. Requesting and approving one do not.
- The fund cannot be overdrawn; an attempt fails and leaves no partial entry.
- Cancelling an already-disbursed request does **not** silently restore the balance. Restoring
  it is a separate, recorded **return**, so the original disbursement stays intact.

Every movement writes one immutable ledger row: date, reference, type, description, amount in,
amount out, running balance, who recorded it and when. Ledger rows and audit rows cannot be
updated or deleted — SQLite triggers refuse both.

All money is held as **integer centavos** and converted to pesos only at the API, PDF and UI
edges, so a running balance is never the result of repeated floating-point addition.

## Accounting categories

Every expense line carries an accounting category from the **Accounting Category Master List**,
maintained in Settings. A new database starts with the standard chart of accounts:

Advertising and Promotions · Bank Charges · Communication · Event Expenses · Freight & Delivery ·
Fuel Expenses · Government Fees · Government Remittance · Meals · Miscellaneous Expense ·
Office Rent · Office Supplies · Parking Rent · Professional Fees · Repairs and Maintenance ·
Representation and Entertainment · Retainers Fee · Salaries and Wages · Sponsorship ·
Transportation · Utilities

Any of these that an existing database does not yet hold is added on the next start, matched by
code, so extending the standard list reaches an installation already in use. A category an
administrator has renamed or deactivated is left exactly as they left it. Categories can be added, renamed, activated and deactivated at runtime;
they are never deleted, because posted lines keep pointing at the classification they were
filed under. A deactivated category stays on historical records but cannot be chosen for a new
line.

The classification is an internal field:

- **Standard Request Copy** — for the requester, payee, approval and release. No categories.
- **Accounting / Internal Copy** — the same request plus the category on each line, marked
  *Internal use only*, and restricted to administrators and approvers.

Both are generated as A4 PDFs by a dependency-free writer, carry the company letterhead,
paginate with repeated table headings, stamp `CANCELLED` with its reason where applicable, and
carry the authorization block described below, with ruled space for a physical signature.

The foot of every form reads left to right in the order the work actually happens:

| Requested By | Approved By | Released By |
| --- | --- | --- |
| the requester named on the request | the approver chosen from the dropdown | whoever released the payment or disbursed the cash |

On a Petty Cash Request the third block is headed **Disbursed By**. A block whose name is not
yet known prints a dash, leaving the ruled line free to sign.

## Branding

The company logo lives at **`public/brand/logo.png`** and is the only place it needs to be
set. It appears in the sidebar, on the sign-in screen and as the letterhead of every generated
PDF. Replace that one file to change all three.

The **mascot** lives beside it at `public/brand/mascot.png` and greets whoever is signed in
from the dashboard, opposite the page title: one artwork for every role, with only the name
and role line changing. Replace that file to change the
character.

The logo must be an **8-bit, non-interlaced RGB or RGBA PNG**; it is decoded, averaged down and
compressed once at startup, so a large source file does not bloat every document. If the file
is missing or unreadable the service logs the reason, keeps running, and prints the company
name as a wordmark instead. The company name itself is configuration, changed in Settings.

## Bank Records

The official bank passbook, encoded by hand. The register reads in the passbook's own columns -
**date, check no., particulars, debit, credit, balance** - and each entry also carries its
transaction type, the account, remarks, who encoded it, and when.

Every entry belongs to a **bank account**, which is managed data rather than a typed-in label.
See *Bank Accounts* below.

An account is opened with its **beginning balance**, entered once, before anything can be
encoded against it. From then on the running balance is the system's arithmetic and not
something anyone types: previous balance, plus the deposit, less the withdrawal. A line dated
earlier than the opening figure is refused, and a line encoded late still takes its place by
date, with every balance after it worked out again.

Unlike a financial request, a passbook entry is a **transcription**, so it stays correctable — a
mistyped reference should be fixable, not cancelled and re-filed. What makes that safe is the
trail. Every correction stores the entry exactly as it was and exactly as it became, names the
user and the moment, and lists the fields that moved. Nothing is ever deleted: a line encoded
in error is **voided**, which keeps it on file, struck through, with its reason, and drops it
out of the balances and totals.

Because the balance follows from the movements, the column can never disagree with them.
Correcting an amount - or the beginning balance itself - re-works every balance after it in the
same transaction, and so does voiding a line. The only balance figure anyone enters is the
opening one, which can also be corrected, but not dated after transactions already encoded, and
not voided while live transactions stand against it.

Makers encode and correct. Approvers and administrators do that and may also void.

### Encoding an existing passbook in bulk

A passbook that already exists on paper is not worth typing in one line at a time, so a whole
spreadsheet can be posted at once. **Import from Excel** offers a template, and that template is
generated from this database rather than shipped with it: its Account column is a dropdown of
the accounts the company actually holds, its Type column a dropdown of the types this system
accepts, and its Accounts sheet says which accounts still need a beginning balance. An account
that does not exist cannot be named, because it is not on the list.

The template has no Balance column, for the same reason the screen has no balance field.

The import is in two steps and the first one writes nothing. The file is read, matched against
the accounts, checked row by row, and summarised: which accounts it touches, the beginning
balance it would set, how many lines, their date range, and the debits and credits per account.
Only then is there anything to confirm.

**A file is imported whole or not at all.** One row that cannot be read refuses the entire
file, and every problem is listed by sheet and row number - "Transactions row 14: a passbook
line is either a debit or a credit, not both" - so it is fixed in the spreadsheet rather than
guessed at. A half-loaded passbook would be worse than none: the balances would be right for a
while and then quietly wrong, with nothing to say where.

Dates may be real date cells, or text if it is unambiguous. `2026-09-30` always reads correctly
and `30/09/2026` does too, because 30 cannot be a month; `09/03/2026` is refused rather than
guessed. Amounts are read in the currency of the account on that row.

Rows that match something already on file - same account, date, reference and amount - are
reported before the import, not refused, because a passbook can legitimately repeat a line. It
is there so that re-uploading a file by mistake is noticed.

An imported line is in every other way a hand-encoded one: it carries who imported it and when,
it can be corrected, and it can never be deleted.

## Bank Accounts

The company's banks, the accounts held with them, and the currencies those accounts are kept
in. All of it is data an authorised user maintains; none of it is written into the system.

- A **bank** is local or international, and carries as many accounts as it needs to.
- A **bank account** has a bank, an account name, an account number, a currency, an account
  type and an optional description. Two accounts at one bank cannot share a number, but a blank
  number is not a clash.
- A **currency** is a code, a name, a symbol and the number of decimal places it uses. The list
  starts with ten common ones and is fully editable: add any currency, edit or remove the ones
  not wanted. Nothing in the system requires any particular currency to exist, and a code is
  accepted by its shape, so an account can be recorded in a currency this system has never
  heard of.

Decimal places are data, not an assumption. An amount on a yen account is entered and shown as
a whole number because JPY says it has no minor unit; an amount on a peso or dollar account
takes two. **Totals and balances are kept apart by currency** - a peso account and a dollar
account are never added together, because the sum would mean nothing.

Renaming a bank, or correcting an account number, changes how it reads everywhere at once,
including on passbook entries encoded years earlier. That works because a record holds the
account's identity and not a copy of its name.

Two things are deliberately fixed once an account holds entries: its **currency**, and the
**decimal places** of that currency. Changing either would silently reinterpret every figure
already recorded. The system refuses, and says to add a separate account or currency instead.

An account in use is **deactivated**, not deleted: nothing new can be encoded against it, and
every existing record and balance stays exactly as it was. Removing outright is only possible
while an account is still empty, and even then the removal is written to the audit trail, so
the trail outlives the record.

Administrators and releasers maintain all of this. Makers and viewers read it - a maker encodes
against the accounts but does not decide which accounts the company has.

## Accounts and access

There is no sign-up. An administrator **registers** each person with an email address, and
that address is the account's identity: people sign in with it (or their username) and it is
where a password reset goes. An address nobody registered matches no account, which is what
keeps everyone else out.

A forgotten password is handled by an emailed one-time link, valid for an hour. The link is
stored only as a hash, works once, and setting a new password ends every other session on the
account. Asking for a reset always gives the same reply whether or not the address is
registered, so the form cannot be used to discover who has an account. Nobody — the
administrator included — can read an existing password.

If outgoing mail is not configured, the administrator is shown the one-time link to hand over
in person rather than being told an email was sent. See DEPLOY.md.

## Configuration

Settings (administrators only) covers the company name, currency symbol, the authorized
approvers (the Approved By dropdown) and which is the default, and the numbering formats. Formats accept `{YYYY}`, `{YY}`,
`{MM}` and `{SEQ:n}` — for example `PR-{YYYY}-{SEQ:6}` or `PV/{YY}{MM}/{SEQ:4}`. Each series is
independent, restarts when its prefix or period changes, and a rolled-back request never burns
a number.

## Search and reporting

Requests can be filtered by reference number, requester, payee, date range, accounting
category, status, amount range, approver, check number, payment status and free text across
particulars. Nine reports render on screen, print, and export to CSV (with formula injection
neutralised):

Payment Request Register · Petty Cash Register · Petty Cash Ledger · Expenses by Accounting
Category · Expenses by Date · Expenses by Requester · Paid vs. Pending Requests · Cancelled and
Rejected Transactions · Petty Cash Replenishment History

## Architecture

```
src/
  store.mjs      SQLite schema, transactions, append-only audit, change events
  workflow.mjs   the status machine: the single source of truth for every transition
  money.mjs      integer-centavo arithmetic
  schema.mjs     Zod validation at every system boundary
  numbering.mjs  configurable, independent reference-number series
  requests.mjs   create, edit, submit, approve, reject, cancel
  payments.mjs   check and payment records attached to approved payment requests
  pettycash.mjs  fund balance, ledger, disbursement, returns, replenishment
  categories.mjs the accounting category master list
  documents.mjs  supporting documents
  search.mjs     filtering, listing and dashboard figures
  reports.mjs    the nine reports and the CSV writer
  bank.mjs       the bank passbook register, its corrections and their trail
  pdf.mjs        the standard and accounting PDF copies
  png.mjs        a minimal PNG decoder, just enough for the letterhead
  brand.mjs      loads the logo once and prepares it for embedding
  auth.mjs       accounts, scrypt passwords, sessions, rate limiting
  server.mjs     HTTP routing
public/          the browser application (no framework, no build)
```

Security: scrypt-hashed passwords with per-account rate limiting, HttpOnly `SameSite=Strict`
session cookies, a CSRF token on every mutation, an origin allow-list, a strict Content
Security Policy with no inline script or style, and parameterised SQL throughout. Supporting
documents are limited to PDFs and images and are always served as downloads.

## Tests

`npm run coverage` runs 136 tests and enforces 80% coverage; the suite currently sits at about
97% of lines. It covers the status machine, numbering, money arithmetic, the Maker–Approver
rules, record locking, cancellation and the audit trail, the fund and ledger (including the
specification's own worked examples of 50,000 − 3,500 = 46,500 and 10,000 + 40,000 = 50,000),
overdraw and over-return protection, both PDF copies, every report, the CSV writer, the search
filters, authentication, logo decoding and embedding, the bank register and its correction
trail, the restriction of the fund balance from makers, and the whole HTTP surface end to end.

## Note on the demo data

`npm run seed:demo` creates the accounts `erika` (administrator and releaser) and `maker`
(Angela Din), both with the placeholder password `change-this-password`. Demry Cheng and
Vicente Cheng deliberately have no accounts. It refuses to run against a database that
already has accounts. Change every password before using this system for real work.
