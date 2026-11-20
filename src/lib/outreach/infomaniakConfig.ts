import "server-only";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { currentOrganizationId } from "@/lib/tenancy/scope";

const configSchema = z.array(z.object({
  organizationId: z.string().min(1),
  emailAddress: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1),
}));

/** Server-only, mounted secret. Credentials never enter API responses or the database. */
export function configuredInfomaniakMailboxes() {
  const path = process.env.INFOMANIAK_MAILBOXES_FILE;
  if (!path) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Cannot read Infomaniak mailbox secret file"); }
  const result = configSchema.safeParse(value);
  // Do not include Zod input/errors: these can contain passwords.
  if (!result.success) throw new Error("Invalid Infomaniak mailbox secret file");
  const emails = result.data.map((m) => m.emailAddress);
  if (new Set(emails).size !== emails.length) throw new Error("Duplicate address in Infomaniak mailbox secret file");
  return result.data;
}

export function infomaniakMailbox(emailAddress: string) {
  const org = currentOrganizationId();
  return configuredInfomaniakMailboxes().find((m) => m.organizationId === org && m.emailAddress === emailAddress.trim().toLowerCase());
}

export function hasInfomaniakMailboxes() {
  const org = currentOrganizationId();
  return configuredInfomaniakMailboxes().some((m) => m.organizationId === org);
}
