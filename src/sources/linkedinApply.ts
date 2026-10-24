/**
 * Sending one Easy Apply application through the LinkedIn MCP fork. The server walks the wizard and
 * presses submit for this account; JEV's job here is to read what came back. The reply is data: it
 * is parsed for a status, a message and the questions the walk answered or could not, and nothing in
 * it is run or followed.
 *
 * A reply this module cannot read is a failure, never an application. The pipeline has already
 * recorded the job as submission_unknown before the call, so an unreadable or timed-out answer
 * leaves the posting to be read before anything is sent again.
 */
import { z } from "zod";
import { MCP } from "../config.js";
import type { ToolCall } from "./listingLink.js";

export const McpApplyStatus = z.enum(["applied", "already_applied", "blocked", "failed", "not_easy_apply", "closed", "external", "outcome_unknown"]);

const LearnedReply = z.object({ question: z.string(), answer: z.string(), options: z.array(z.string()), required: z.boolean() });
const UnansweredReply = z.object({ label: z.string(), kind: z.string(), options: z.array(z.string()), required: z.boolean() });

const McpApply = z.object({
  status: McpApplyStatus,
  message: z.string(),
  project: z.string().optional(),
  learned: z.array(LearnedReply).default([]),
  unanswered: z.array(UnansweredReply).default([]),
});

export type Learned = z.infer<typeof LearnedReply>;
export type Unanswered = z.infer<typeof UnansweredReply>;
export type McpApplyResult = { status: z.infer<typeof McpApplyStatus>; message: string; project?: string; learned: Learned[]; unanswered: Unanswered[] };

/** A reply from the apply tool that this module could not read, or that never came. */
export class McpApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpApplyError";
  }
}

const unreadable = (text: string) => new McpApplyError(`the linkedin apply tool answered in a shape this tool does not read: ${text.slice(0, 200)}`);

/** Runs the call, giving up after callMs when one is set. The call itself owns any other bound. */
async function within<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return work;
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const tooLong = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpApplyError(`the linkedin apply tool did not answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([work, tooLong]);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the application for one LinkedIn posting and returns what the server said it did. */
export async function applyOnLinkedIn(id: string, o: { call: ToolCall; callMs?: number }): Promise<McpApplyResult> {
  const text = await within(o.call("linkedin", MCP.linkedin.tools.apply, { job_id: id }, o.callMs), o.callMs);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw unreadable(text);
  }
  const parsed = McpApply.safeParse(json);
  if (!parsed.success) throw unreadable(text);
  const { status, message, project, learned, unanswered } = parsed.data;
  return { status, message, ...(project === undefined ? {} : { project }), learned, unanswered };
}
