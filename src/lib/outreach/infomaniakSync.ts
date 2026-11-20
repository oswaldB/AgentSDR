import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { configuredInfomaniakMailboxes } from "./infomaniakConfig";
import { syncMailboxInbox } from "./gmailSync";
import { runInOrganization } from "@/lib/tenancy/scope";

/** Poll all connected configured accounts, even when they have no outgoing queue. */
export async function syncInfomaniakMailboxes() {
  for (const config of configuredInfomaniakMailboxes()) {
    await runInOrganization(config.organizationId, async () => {
      const [mailbox] = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(
        eq(mailboxes.organizationId, config.organizationId),
        eq(mailboxes.emailAddress, config.emailAddress), eq(mailboxes.status, "connected"),
      )).limit(1);
      if (!mailbox) return;
      try { await syncMailboxInbox(mailbox.id); }
      catch { console.error(`[outreach/imap] sync failed for mailbox ${mailbox.id}; cursor retained`); }
    });
  }
}
