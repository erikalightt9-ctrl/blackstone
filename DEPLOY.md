# Putting Financial Monitoring into service

The service itself only ever listens on `127.0.0.1:3403`. Nothing reaches it directly. Two
front doors sit in front of it, and you can run either or both:

| Front door | Reaches it from | Address |
| --- | --- | --- |
| **Caddy** | the office network | `https://finance-pc` |
| **Cloudflare Tunnel** | anywhere | `https://finance.example.com` |

Both terminate HTTPS, so the session cookie is issued `Secure` and the sign-in page is never
served in the clear.

This machine is **FINANCE-PC** at **192.168.1.10**. Every command below runs on it.

---

## 0. Make the local configuration files

The two files that carry this office's own computer name, address and paths are not in the
repository - only templates for them are, so that nothing internal is published. Copy each
template once and edit it for the machine you are setting up:

```bash
cp deploy/start-service.example.cmd deploy/start-service.cmd
cp deploy/Caddyfile.example deploy/Caddyfile
```

Then set, in `deploy/start-service.cmd`, the address staff actually type (`FR_ORIGIN`) and
every other name the same server answers to (`FR_EXTRA_ORIGINS`); and in `deploy/Caddyfile`,
the same names on the site line. A browser treats each name as a separate origin, so any name
in use must appear in both or the service will refuse form submissions from it.

Your copies stay on this machine: both are in `.gitignore`.

## 1. Fix the address

The address is handed out by DHCP today, so it can change and break the certificate and the
tunnel. Reserve it on the router for this machine's MAC address, or set it statically:

```powershell
Get-NetAdapter -Name 'Ethernet 2' | Get-NetIPConfiguration
```

Skip this if you only ever use the **Cloudflare** address, which does not depend on the IP.

## 2. Retire the demo data

The database is full of invented requests. Stop the service first so nothing is half-written,
then:

```bash
npm run go-live -- --confirm
```

It backs the demo up, archives it under `data/retired-…` (nothing is deleted), and leaves an
empty database. Start the service once and it prints a **one-time setup code** in the console:

```bash
npm run dev
```

Open the address, enter the code, and create the real administrator. Setup then closes itself.

As that administrator, before anyone files anything:

1. **Settings** — company name, the numbering formats, and the two approvers
2. **Settings** — check the accounting categories against your chart of accounts
3. **Settings** — add the maker's account
4. **Petty Cash Fund** — open the fund with its real opening balance

If your reference numbers must continue an existing series rather than start at `000001`, say
so before you begin: the starting number is set in the database, not in the screen.

## 3. HTTPS on the office network (Caddy)

```powershell
winget install CaddyServer.Caddy
```

Then, in an **Administrator** PowerShell in the project folder:

```powershell
caddy trust                                   # trusts Caddy's authority on this machine
New-NetFirewallRule -DisplayName "Financial Monitoring HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private
```

`deploy/Caddyfile` already lists `finance-pc` and `192.168.1.10`. If you change either, change
it in `deploy/start-service.cmd` too — the service refuses a form posted from a name it has
not been told about, which is what stops a cross-site request.

**On each other office computer**, once: copy
`C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy\pki\authorities\local\root.crt`
from this machine and install it into **Trusted Root Certification Authorities** (double-click
→ Install Certificate → Local Machine). Without that step the browser shows a warning.

## 4. From outside the office (Cloudflare Tunnel)

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create financial-monitoring
cloudflared tunnel route dns financial-monitoring finance.example.com
```

Point the tunnel at the service — `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: financial-monitoring
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: finance.example.com
    service: http://127.0.0.1:3403
  - service: http_status:404
```

```powershell
cloudflared service install      # starts with the computer
```

Then in `deploy/start-service.cmd` make the public address canonical:

```bat
set FR_ORIGIN=https://finance.example.com
set FR_EXTRA_ORIGINS=https://finance-pc,https://192.168.1.10
```

`FR_TRUST_PROXY=1` is already set there. It has to be: behind a tunnel every request appears
to come from the loopback address, and without it the whole office would share a single
login-attempt limit.

> **Put Cloudflare Access in front of it.** The moment this is on the internet, the sign-in
> page is reachable by anyone who finds the name. Cloudflare Access (free for small teams)
> demands an identity — your Google or email one-time code — *before* a request ever reaches
> the service. The application has no second factor of its own, so without Access a leaked
> password is the only thing between an outsider and your financial records.

## 5. Email, so password resets can be sent

Accounts are reached by their **registered email address**, and that is where a reset link is
sent. Put the mail account's own password in the environment, never in this repository, and
never in a shared document.

Add these to `deploy/start-service.cmd`, filling in your own values:

```bat
set FR_MAIL_FROM=Financial Monitoring <finance@example.com>
set FR_SMTP_HOST=smtp.example.com
set FR_SMTP_PORT=587
set FR_SMTP_USER=finance@example.com
set FR_SMTP_PASS=the-mailbox-password
```

Port **587** upgrades to TLS with STARTTLS; port **465** is encrypted from the first byte and
is detected automatically. A single `FR_SMTP_URL=smtps://user:pass@host:465` works instead of
the four separate settings.

With Google Workspace or Microsoft 365, create an **app password** for this purpose rather
than using the mailbox's own sign-in password, so it can be revoked on its own.

**Until this is set up nothing breaks.** The administrator's *Send reset link* button reports
that mail is not configured and shows the one-time link to hand over in person, instead of
claiming to have sent an email it did not send.

## 6. Start with the computer, back itself up hourly

In an **Administrator** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-tasks.ps1
```

That registers three scheduled tasks running as SYSTEM, so everything comes back after a
reboot with nobody signed in: the service, the Caddy front door, and a backup **every hour**,
keeping the last 240 in `data/backups` - ten days of hourly copies. Hourly rather than nightly
because a nightly copy puts a whole day of approvals at risk, and each backup costs a fraction
of a second.

Take one now and check it:

```bash
npm run backup
```

Every backup is **verified** before it is kept: the copy is opened, integrity-checked, and its
row counts compared against the live database table by table. A copy that does not match is
reported and discarded rather than quietly filed.

Backups use SQLite's own hot-backup, so they are safe to take while people are working.
Copying `finance.sqlite` in Explorer while the service runs is **not** safe.

**Keep a copy off this machine.** A backup sitting on the same disk as the database does not
survive the disk. Point OneDrive, a network share or a USB routine at `data/backups`, or set
`FR_BACKUP_COPY_TO` in `deploy/start-service.cmd` to a network path and each verified backup is
copied there as it is taken.

## 6a. If the database is lost or damaged

This has been rehearsed: the database was deliberately corrupted, listed, restored and checked
back to the last good copy. What to do:

**1. Stop the service** so nothing writes while you work.

```powershell
Stop-ScheduledTask -TaskName FinancialMonitoring
```

**2. See what you have.** This reads every backup and prints its date, size and what is inside
it - how many requests, the petty cash balance, the passbook balance - so you can choose by
content rather than by filename.

```bash
npm run restore
```

**3. Put one back.** Name the file and confirm:

```bash
node scripts/restore.mjs finance-2026-09-22T1000.sqlite --confirm
```

The current database is **archived, not overwritten**, so a wrong choice is undoable. The
restored copy is integrity-checked before it is put in place, and the script then prints what
it contains so you can confirm it is the state you expected.

**4. Start the service** and check the dashboard figures against the numbers the restore
printed.

```powershell
Start-ScheduledTask -TaskName FinancialMonitoring
```

Anything filed after the backup you restored is gone and has to be re-entered - which is why
the backup runs hourly. The audit trail of everything that survived is intact, so you can see
exactly where the record stops.

## 6b. Clearing the sample data

To empty the payment requests, the petty cash requests and the passbook while keeping the
accounts, banks, bank accounts, currencies, categories and configuration:

```bash
npm run clear-transactions
```

Run without `--confirm` it only reports what would go and what would stay. With `--confirm` it
takes a verified backup first, empties the transactional tables, and resets the numbering so
the first real request is 000001.

This is a pre-go-live tool, not a way to edit history. The system is built so a record can
never be deleted; sample data is not a record. The script drops the deletion guards for that
one operation, and the schema recreates every one of them the next time the service starts, so
records are protected again from the first real entry. Once real work is in the system the way
to correct something is to cancel, void or correct it - which is what the audit trail is for.

To retire the whole database instead, users and all, use `npm run go-live -- --confirm`.

## 7. Before you trust it with real money

- Change every password. The demo accounts use a placeholder one.
- Bank Accounts - add the company's banks and accounts, with the right currency on each.
- Bank Records - enter each account's beginning balance by hand, then encode or import from it.
- Have Angela file two or three real requests and take them through to release. Some rules are
  deliberately strict — only drafts are editable, a correction after approval means cancelling
  and re-filing, a reviewer comments rather than edits. Feel those on real work first.
- Restore a backup into a scratch copy and open it, so you know the recovery works before you
  need it. Section 6a is the procedure; walk it once on a copy while nothing is at stake.

## Day to day

| Task | Command |
| --- | --- |
| Is it running? | `Get-ScheduledTask -TaskName FinancialMonitoring*` |
| Restart it | `Restart-ScheduledTask -TaskName FinancialMonitoring` |
| Back up now | `npm run backup` |
| Clear the sample data, keep the setup | `npm run clear-transactions -- --confirm` |
| See what the backups hold | `npm run restore` |
| Put a backup back | `node scripts/restore.mjs <file> --confirm` |
| Check the tests still pass after any change | `npm test` |
