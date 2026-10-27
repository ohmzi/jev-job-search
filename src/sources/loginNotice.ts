/**
 * Reading the LinkedIn fork's replies for the words that mean a person has to sign in. It lives
 * apart from the Easy Apply step so the server caller can use it too, without a cycle.
 */
import { z } from "zod";

export const ErrorReply = z
  .object({
    section_errors: z.record(z.unknown()).optional(),
    error_type: z.string().optional(),
    error_message: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export const SectionError = z.object({ error_type: z.string().optional(), error_message: z.string().optional(), message: z.string().optional() }).passthrough();

/**
 * The fork's own words when it needs a person to sign in. Only an error field is read: a posting's
 * description may say "sign in" as ordinary prose and must not stop a run.
 */
const LOGIN_NOTICE = /login window|login required|authentication started|sign in/i;

export function loginNoticeIn(text: string | undefined | null): string | null {
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const hit = LOGIN_NOTICE.exec(text);
    return hit ? hit[0] : null;
  }
  if (!json || typeof json !== "object") return null;
  const fields: (string | undefined)[] = [];
  const parsed = ErrorReply.safeParse(json);
  if (parsed.success) {
    fields.push(parsed.data.error_type, parsed.data.error_message, parsed.data.message);
    for (const value of Object.values(parsed.data.section_errors ?? {})) {
      const error = SectionError.safeParse(value);
      if (error.success) fields.push(error.data.error_type, error.data.error_message, error.data.message);
    }
  }
  // Only top-level error words are read, never a posting's own text under `sections`.
  const object = json as Record<string, unknown>;
  for (const key of ["error", "error_type", "error_message", "message", "detail", "reason"]) {
    const value = object[key];
    if (typeof value === "string") fields.push(value);
  }
  for (const field of fields) {
    if (!field) continue;
    const hit = LOGIN_NOTICE.exec(field);
    if (hit) return hit[0];
  }
  return null;
}
