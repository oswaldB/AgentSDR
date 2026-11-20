# Infomaniak mailboxes (self-hosted extension)

This branch adds SMTP sending and IMAP reply polling for multiple Infomaniak
mailboxes without Google Workspace or a forwarding service. Google Workspace
accounts keep their existing provider. No database migration is required.

## Set up

1. Use the usual Docker setup to create your admin account and organization.
   Keep the instance private until its normal production configuration is complete.
2. Retrieve your organization's ID from your database (`SELECT id, name FROM
   organizations;`) or your existing organization administration tooling. Verify
   the exact organization rather than assuming the first one is yours.
3. Copy `config/infomaniak-mailboxes.example.json` to
   `config/infomaniak-mailboxes.json`. Set the correct organization ID, complete
   email address and mailbox password for every account (5–10 entries work the
   same way as two). This is the email mailbox password, not the Manager password.
   Restrict access to this file and include it only in encrypted backups. Compose
   mounts it read-only; it is not itself an encrypted secrets vault.
4. Start the modified build:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.infomaniak.yml up -d --build
   ```

5. In Settings → Email → Email accounts, add each address and its display name.
   The connection test authenticates SMTP and opens INBOX read-only; it sends
   nothing. Passwords are not entered through the browser or exposed by APIs.
6. Set each account's daily limit, hours and signature using the existing controls.
   Configure your AI integration separately if you want reply classification and
   drafting. An email transport does not supply an AI model.
7. To verify the deployment, first connect one mailbox. Send a test to an address
   you control with the existing Send test action, reply to it, and check Master
   Inbox after one or two scheduler cycles. Then verify a short campaign, its
   stop-on-reply behaviour, reply threading and a Bcc recipient before enabling
   the other mailboxes. No live send has been performed while developing this.

Infomaniak's documented server is `mail.infomaniak.com`, IMAP 993 TLS, SMTP 465
TLS; the username is the full email address. The host and TLS settings are fixed
in the adapter. Allow those outbound ports from your server. Reference:
https://www.infomaniak.com/en/support/faq/468/understanding-mail-server-ports-and-protocols

## Reception and safety

- The existing single-instance outreach scheduler polls every minute by default,
  including accounts without a pending outgoing queue. Keep it enabled. This
  extension inherits the upstream single-instance deployment requirement.
- Initial connection starts at the current end of INBOX. Old messages are not
  imported. New arrivals are fetched by UID in batches of up to 100, read-only,
  without marking them read. Mail moved out of INBOX before polling is not seen.
- Cursor advancement happens only after the existing reply pipeline successfully
  handles the entire batch. Its mailbox-scoped identities deduplicate retries.
- Before an Infomaniak campaign send, replies are synced again. If sync fails,
  that account's campaign send is skipped for the cycle.
- Retesting an account preserves its existing IMAP cursor. A UIDVALIDITY change
  stops sync instead of silently discarding replies. Reconcile the affected
  INBOX and pending campaigns before an administrator resets its cursor.
- The existing database/API names `gmailMessageId`, `lastHistoryId` and the CRM
  provider label `gmail` are retained for compatibility. IMAP IDs are namespaced
  `imap:<uid-validity>:<uid>`; RFC Message-ID/References provide threading.
- Bcc is sent through the SMTP envelope and stripped from MIME headers. TLS
  certificate checks remain enabled. Mail credentials are scoped to an explicit
  organization; another organization cannot select them by entering the address.

## Limits

This is an initial transport extension. It does not add a provider management UI,
import old mail, sync Sent/read/delete state, or add attachment support to the
existing reply pipeline. SMTP-sent messages are recorded in AgentSDR but this
adapter does not append copies to the remote Sent folder. Partial recipient
acceptance is treated as an accepted send to avoid resending to recipients who
already received it, matching the existing adapter's one-result interface.
Live verification with real credentials and a server remains necessary.
