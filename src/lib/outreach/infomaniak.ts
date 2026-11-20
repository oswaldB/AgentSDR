import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { infomaniakMailbox } from "./infomaniakConfig";
import type { InboundMessage, MailboxConnectionTest, SendEmailParams, SendEmailResult } from "./gmail";
import { buildRawEmailMessage } from "./gmail";
import { parseAddressHeader } from "./addressHeader";

function credentials(address: string) {
  const config = infomaniakMailbox(address);
  if (!config) throw new Error("Infomaniak mailbox is not configured for this organization");
  return config;
}

function imap(address: string) {
  const config = credentials(address);
  const client = new ImapFlow({
    host: "mail.infomaniak.com", port: 993, secure: true,
    auth: { user: config.emailAddress, pass: config.password },
    logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    disableAutoIdle: true,
  });
  // The library emits connection errors as well as rejecting commands.
  client.on("error", () => {});
  return client;
}

function smtp(address: string) {
  const config = credentials(address);
  return nodemailer.createTransport({
    host: "mail.infomaniak.com", port: 465, secure: true,
    auth: { user: config.emailAddress, pass: config.password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    logger: false, debug: false,
  });
}

export function imapCursor(validity: bigint | string, uid: number) {
  return `imap:${validity}:${uid}`;
}

export function parseImapCursor(cursor: string) {
  const match = /^imap:(\d+):(\d+)$/.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid IMAP cursor; reconnect the mailbox");
  return { validity: match[1], uid: Number(match[2]) };
}

export async function testInfomaniakConnection(address: string): Promise<MailboxConnectionTest> {
  const client = imap(address);
  const transport = smtp(address);
  try {
    await transport.verify(); // AUTH only: no email is sent.
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true, profileEmail: address, historyId: imapCursor(box.uidValidity, box.uidNext - 1) };
  } catch {
    return { ok: false, error: "Infomaniak SMTP/IMAP connection failed; check mailbox credentials and network access" };
  } finally {
    transport.close();
    client.close();
  }
}

export async function sendInfomaniakEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const transport = smtp(params.from);
  try {
    // SMTP recipients are in the envelope; Bcc MUST NOT appear in delivered MIME.
    const raw = await buildRawEmailMessage(params, false);
    // A raw SMTP transport otherwise invents a different bookkeeping ID.
    const messageId = (await simpleParser(raw)).messageId;
    if (!messageId) throw new Error("Composed SMTP message has no Message-ID");
    const result = await transport.sendMail({
      messageId,
      envelope: { from: params.from, to: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])] }, raw,
    });
    // A partly accepted delivery must not be retried in its entirety.
    // Match the existing Gmail adapter's accepted-send semantics.
    if (!result.accepted?.length) throw new Error("Infomaniak did not accept any recipients");
    return { id: messageId, messageId, threadId: params.threadId ?? params.references?.[0] ?? messageId };
  } finally { transport.close(); }
}

export async function fetchInfomaniakInbound(address: string, cursor: string) {
  return readInfomaniakInbox(imap(address), cursor);
}

/** Shared read-only sync, accepting a client so cursor/retry behaviour is testable offline. */
export async function readInfomaniakInbox(client: Pick<ImapFlow, "connect" | "mailboxOpen" | "search" | "fetchOne" | "close">, cursor: string) {
  const previous = parseImapCursor(cursor);
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    if (String(box.uidValidity) !== previous.validity) {
      // Fail closed. Silently resetting here would lose replies and allow follow-ups.
      throw new Error("IMAP UIDVALIDITY changed; mailbox requires an explicit reconciliation before reconnecting");
    }
    const messages: InboundMessage[] = [];
    let lastUid = previous.uid;
    const upper = box.uidNext - 1;
    if (upper <= lastUid) return { messages, newHistoryId: cursor };
    // Numeric upper bound avoids IMAP n:* returning an older last message.
    const found = await client.search({ uid: `${lastUid + 1}:${upper}` }, { uid: true });
    const ids = (found || []).sort((a, b) => a - b).slice(0, 100);
    for (const uid of ids) {
      const item = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
      if (!item || !item.source) throw new Error("IMAP message disappeared during sync; cursor retained for retry");
      const parsed = await simpleParser(item.source);
      const header = (name: string) => parsed.headerLines.find((h) => h.key === name)?.line.replace(/^[^:]+:\s*/, "") ?? null;
      const from = parseAddressHeader(header("from"))[0];
      const to = parseAddressHeader(header("to"));
      const cc = parseAddressHeader(header("cc"));
      const references = typeof parsed.references === "string" ? [parsed.references] : parsed.references;
      messages.push({
        gmailMessageId: imapCursor(box.uidValidity, uid),
        threadId: references?.[0] ?? parsed.inReplyTo ?? parsed.messageId ?? null,
        fromEmail: from?.email ?? null, fromName: from?.name ?? null,
        toEmail: to[0]?.email ?? null, to, cc, ccEmails: cc.map((a) => a.email),
        replyTo: parseAddressHeader(header("reply-to")),
        subject: parsed.subject ?? null, bodyText: parsed.text ?? (parsed.html || null),
        messageId: parsed.messageId ?? null, inReplyTo: parsed.inReplyTo ?? null,
        internalDate: item.internalDate instanceof Date ? item.internalDate : parsed.date ?? null,
      });
      lastUid = uid;
    }
    // All gaps are deleted UIDs, so an empty search can safely advance to upper.
    return { messages, newHistoryId: imapCursor(box.uidValidity, ids.length ? lastUid : upper) };
  } finally { client.close(); }
}
