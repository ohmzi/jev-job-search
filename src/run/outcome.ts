/**
 * What becomes of a job after its form was filled and resolved, before
 * anything is sent. The rules are the person's: a site that wants a sign-in,
 * a form that asks for a signature, and a question the profile cannot answer
 * are not worked around. The job is set aside for them with the reason.
 */
import { SIGN_IN_REASON, type FillReport } from "../browser/report.js";
import type { QueueEntry, WaitingFor } from "../jobs/queue.js";

export type Outcome = {
  /** send: the form is ready. Anything else is the status the job is recorded with. */
  action: "send" | QueueEntry["status"];
  reason: string | null;
  /** The job's site put a sign-in in front of the form: the next discover skips that site. */
  rememberSite: boolean;
  /** What the person is asked to do, when the job waits on them. */
  waitingFor?: WaitingFor | null;
};

/** One line that says why a filled form is not ready, for the record. */
export function notReady(r: FillReport): string {
  if (r.resolution && r.resolution.verdict !== "ready" && r.resolution.reason) return r.resolution.reason;
  const open = [
    ...r.missingRequired.map((l) => `empty: ${l.slice(0, 60)}`),
    ...r.failed.map((f) => (/^(the form did not move on|could not tell that)/.test(f.why) ? f.why : `did not land: ${f.label.slice(0, 60)}`)),
    ...r.reviews.map((x) => `${x.why.startsWith("signing") ? "asks for a signature" : "unsure"}: ${x.label.slice(0, 60)}`),
    ...r.drafts.map((x) => `unwritten: ${x.label.slice(0, 60)}`),
  ];
  const where = r.page > 1 ? `page ${r.page}: ` : "";
  return where + (open.join("; ") || r.reason || "not verified");
}

/** A page that asks the person to prove they are a person. The tab stays open and they are told. */
export const CAPTCHA_REASON = "the site asks you to confirm you are not a robot. The page is open in the tool's window";

export function outcomeOf(r: FillReport, maxPages: number): Outcome {
  if (r.sent) return { action: "applied", reason: null, rememberSite: false };
  if (r.state === "blocked") {
    const reason = r.reason ?? "no form found";
    // A sign-in on a board the tool knows: the job waits for what the sign-in said, and the site is not written off.
    if (r.auth) return { action: r.auth.status, reason: r.auth.status === "queued" ? null : reason, rememberSite: false, waitingFor: r.auth.waitingFor };
    // A sign-in page is the person's, not a site to write off. The tab stays open, the run waits,
    // and if they sign in the form is filled.
    if (reason === SIGN_IN_REASON || /login_required/.test(reason)) return { action: "awaiting_user_action", reason: SIGN_IN_REASON, rememberSite: false, waitingFor: "login" };
    // A posting that has closed is not something the person can do by hand either.
    if (/page looks like: closed/.test(reason)) return { action: "skipped", reason: "the posting has closed", rememberSite: false };
    // A challenge in front of the form is the person's to pass, not a site to write off.
    if (/captcha/.test(reason)) return { action: "awaiting_user_action", reason: CAPTCHA_REASON, rememberSite: false, waitingFor: "robot_check" };
    return { action: "blocked", reason, rememberSite: /page looks like: job_description/.test(reason) };
  }
  if (r.resolution?.verdict === "skip") return { action: "skipped", reason: r.resolution.reason, rememberSite: false };
  if (r.ready) return { action: "send", reason: null, rememberSite: false };
  if (r.hasNext && r.page >= maxPages && !r.failed.length && !r.missingRequired.length) return { action: "needs_review", reason: `the form runs over more than ${maxPages} pages`, rememberSite: false };
  return { action: "needs_review", reason: notReady(r), rememberSite: false };
}
