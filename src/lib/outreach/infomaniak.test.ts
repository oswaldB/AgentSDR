import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredInfomaniakMailboxes, hasInfomaniakMailboxes, infomaniakMailbox } from "./infomaniakConfig";
import { runInOrganization } from "@/lib/tenancy/scope";
import { buildRawEmailMessage } from "./gmail";
import { imapCursor, parseImapCursor, readInfomaniakInbox } from "./infomaniak";

const original = process.env.INFOMANIAK_MAILBOXES_FILE;
let dir: string;
let path: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentsdr-imap-")); path = join(dir, "mailboxes.json"); });
afterAll(() => {
  if (original === undefined) delete process.env.INFOMANIAK_MAILBOXES_FILE;
  else process.env.INFOMANIAK_MAILBOXES_FILE = original;
  rmSync(dir, { recursive: true, force: true });
});
function configure(value: unknown) { writeFileSync(path, JSON.stringify(value)); process.env.INFOMANIAK_MAILBOXES_FILE = path; }

describe("Infomaniak mailbox isolation", () => {
  test("unconfigured installs retain the Google-only path", () => {
    delete process.env.INFOMANIAK_MAILBOXES_FILE;
    expect(configuredInfomaniakMailboxes()).toEqual([]);
    expect(runInOrganization("a", () => hasInfomaniakMailboxes())).toBe(false);
  });
  test("supports ten accounts but only exposes each organization's own credentials", () => {
    configure(Array.from({ length: 10 }, (_, i) => ({ organizationId: i < 5 ? "a" : "b", emailAddress: `user${i}@example.com`, password: `secret-${i}` })));
    expect(configuredInfomaniakMailboxes()).toHaveLength(10);
    runInOrganization("a", () => {
      expect(infomaniakMailbox(" USER0@EXAMPLE.COM ")?.password).toBe("secret-0");
      expect(infomaniakMailbox("user9@example.com")).toBeUndefined();
    });
    expect(runInOrganization("c", () => hasInfomaniakMailboxes())).toBe(false);
  });
  test("lookup without an organization fails closed", () => {
    expect(() => infomaniakMailbox("user0@example.com")).toThrow("No organization scope");
  });
  test("invalid config errors do not reveal the supplied secret", () => {
    configure([{ organizationId: "a", emailAddress: "invalid", password: "DO-NOT-LOG-ME" }]);
    expect(() => configuredInfomaniakMailboxes()).toThrow("Invalid Infomaniak mailbox secret file");
    try { configuredInfomaniakMailboxes(); } catch (e) { expect(String(e)).not.toContain("DO-NOT-LOG-ME"); }
  });
  test("duplicate addresses cannot be assigned across organizations", () => {
    configure(["a", "b"].map((organizationId) => ({ organizationId, emailAddress: "same@example.com", password: "secret" })));
    expect(() => configuredInfomaniakMailboxes()).toThrow("Duplicate address");
  });
});

describe("SMTP delivery headers", () => {
  test("strips Bcc from SMTP MIME, retains Cc and RFC threading", async () => {
    const raw = await buildRawEmailMessage({ from: "sender@example.com", to: ["to@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "Test", text: "Body", inReplyTo: "<prior@example.com>", references: ["<root@example.com>", "<prior@example.com>"] }, false);
    const headers = raw.toString().split(/\r?\n\r?\n/, 1)[0];
    expect(headers).not.toMatch(/^Bcc:/mi);
    expect(headers).not.toContain("hidden@example.com");
    expect(headers).toMatch(/^Cc: cc@example.com/mi);
    expect(headers).toContain("In-Reply-To: <prior@example.com>");
    expect(headers).toContain("References: <root@example.com> <prior@example.com>");
  });
  test("Gmail's raw API keeps Bcc by default", async () => {
    const raw = await buildRawEmailMessage({ from: "sender@example.com", to: ["to@example.com"], bcc: ["hidden@example.com"], subject: "Test", text: "Body" });
    expect(raw.toString()).toMatch(/^Bcc: hidden@example.com/mi);
  });
});

describe("IMAP cursor identity", () => {
  test("preserves UIDVALIDITY separately from the last consumed UID", () => {
    expect(parseImapCursor(imapCursor("123456789", 42))).toEqual({ validity: "123456789", uid: 42 });
    expect(parseImapCursor("imap:123:0").uid).toBe(0);
  });
  test("rejects Gmail and malformed cursors instead of resetting silently", () => {
    for (const value of ["98765", "imap:123:-1", "imap:abc:1", "imap:123:90071992547409999"]) {
      expect(() => parseImapCursor(value)).toThrow("Invalid IMAP cursor");
    }
  });
});


describe("IMAP incremental reception", () => {
  function fake(options: { validity?: string; uidNext?: number; ids?: number[]; missing?: boolean; broken?: boolean } = {}) {
    const observed: { readOnly?: boolean; search?: unknown; closed?: boolean; fetched: string[] } = { fetched: [] };
    const client = {
      connect: async () => {},
      mailboxOpen: async (_: string, config: { readOnly?: boolean }) => {
        observed.readOnly = config.readOnly;
        return { uidValidity: BigInt(options.validity ?? "123"), uidNext: options.uidNext ?? 45 };
      },
      search: async (query: unknown) => { observed.search = query; return options.ids ?? [44, 43]; },
      fetchOne: async (uid: string) => {
        observed.fetched.push(uid);
        if (options.broken) throw new Error("network interrupted");
        if (options.missing) return false;
        return { source: Buffer.from("From: Prospect <lead@example.com>\r\nTo: rep@example.com\r\nCc: boss@example.com\r\nSubject: Re: Proposal\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: <prior@example.com>\r\nReferences: <root@example.com> <prior@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYes, interested."), internalDate: new Date("2026-11-19T12:00:00Z") };
      },
      close: () => { observed.closed = true; },
    };
    return { client: client as unknown as Parameters<typeof readInfomaniakInbox>[0], observed };
  }
  test("reads ordered new UIDs read-only and preserves RFC threading and all recipients", async () => {
    const { client, observed } = fake();
    const result = await readInfomaniakInbox(client, "imap:123:42");
    expect(observed.readOnly).toBe(true);
    expect(observed.search).toEqual({ uid: "43:44" });
    expect(observed.fetched).toEqual(["43", "44"]);
    expect(observed.closed).toBe(true);
    expect(result.newHistoryId).toBe("imap:123:44");
    expect(result.messages[0]).toMatchObject({ gmailMessageId: "imap:123:43", threadId: "<root@example.com>", inReplyTo: "<prior@example.com>", fromEmail: "lead@example.com", ccEmails: ["boss@example.com"], bodyText: "Yes, interested." });
  });
  test("does not query n:* or refetch the last message in an unchanged INBOX", async () => {
    const { client, observed } = fake({ uidNext: 43 });
    expect(await readInfomaniakInbox(client, "imap:123:42")).toEqual({ messages: [], newHistoryId: "imap:123:42" });
    expect(observed.search).toBeUndefined();
  });
  test("UIDVALIDITY change fails rather than dropping replies", async () => {
    const { client, observed } = fake({ validity: "456" });
    await expect(readInfomaniakInbox(client, "imap:123:42")).rejects.toThrow("UIDVALIDITY changed");
    expect(observed.fetched).toEqual([]);
    expect(observed.closed).toBe(true);
  });
  test("a missing or failed message rejects without a new cursor", async () => {
    for (const options of [{ missing: true }, { broken: true }]) {
      const { client, observed } = fake(options);
      await expect(readInfomaniakInbox(client, "imap:123:42")).rejects.toThrow();
      expect(observed.closed).toBe(true);
    }
  });
  test("bounds each cycle to 100 messages and never skips the remaining UIDs", async () => {
    const { client } = fake({ ids: Array.from({ length: 150 }, (_, i) => i + 43), uidNext: 193 });
    const result = await readInfomaniakInbox(client, "imap:123:42");
    expect(result.messages).toHaveLength(100);
    expect(result.newHistoryId).toBe("imap:123:142");
  });
});
