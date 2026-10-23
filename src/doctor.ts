/**
 * `doctor`: checks everything a run needs and names the one thing to do next.
 * The setup skill runs it after every step, so a person never has to work out
 * what is missing. With `online` it also makes one tiny DeepSeek typed call and one tiny
 * DeepSeek writer call to prove the key works.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { BROWSER, DOCTOR, GMAIL, PATHS, ROOT, WRITER } from "./config.js";
import { loadAccounts } from "./accounts/config.js";
import { defaultStore, type SecretStore } from "./accounts/secrets.js";
import { loadGmail } from "./mail/gmail.js";
import { askWriter } from "./answers/resolve.js";
import { JevClient } from "./jev/client.js";
import { noul } from "./jev/questions.js";
import { loadQueue } from "./jobs/queue.js";
import { loadProfile, type Profile } from "./profile/schema.js";

export type Check = {
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** What to do when it is not ok. */
  fix: string;
  /** An optional check never blocks a run. */
  optional?: boolean;
};

const rel = (file: string) => path.relative(ROOT, file) || file;

export function checkNode(version = process.versions.node): Check {
  const major = Number(version.split(".")[0]);
  return { name: "Node.js", ok: major >= DOCTOR.minNodeMajor, detail: `version ${version}`, fix: `Install Node.js ${DOCTOR.minNodeMajor} or newer from https://nodejs.org` };
}

export function checkChrome(file: string = BROWSER.chromePath): Check {
  return { name: "Google Chrome", ok: existsSync(file), detail: existsSync(file) ? "installed" : `not found at ${file}`, fix: "Install Google Chrome from https://www.google.com/chrome, or set BROWSER.chromePath in src/config.ts" };
}

export function checkKey(key = process.env.DEEPSEEK_API_KEY ?? ""): Check {
  const ok = key.trim().length > 0;
  return {
    name: "DeepSeek key",
    ok,
    detail: ok ? "set in .env" : existsSync(path.join(ROOT, ".env")) ? ".env exists but DEEPSEEK_API_KEY is empty" : "no .env file yet",
    fix: "Create a key at https://platform.deepseek.com/api_keys, run `cp .env.example .env`, and paste the key after DEEPSEEK_API_KEY= in .env. Do not paste the key into a chat.",
  };
}

export function checkProfile(file: string = PATHS.profile): { check: Check; profile: Profile | null } {
  if (!existsSync(file)) return { profile: null, check: { name: "Your profile", ok: false, detail: `${rel(file)} does not exist yet`, fix: "Run /setup in Claude Code, or copy data/profile.example.json to data/profile.json and fill it in" } };
  try {
    const profile = loadProfile(file);
    return { profile, check: { name: "Your profile", ok: true, detail: `${profile.name.first} ${profile.name.last}, ${profile.facts.length} facts, ${profile.answers.length} standing answers`, fix: "" } };
  } catch (err) {
    return { profile: null, check: { name: "Your profile", ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 600), fix: `Correct the fields named above in ${rel(file)}` } };
  }
}

export function checkResume(profile: Profile | null): Check {
  const fix = "Put your resume PDF at documents/resume.pdf and set resume.path in data/profile.json to its full path";
  if (!profile) return { name: "Your resume", ok: false, detail: "needs the profile first", fix };
  const file = profile.resume.path;
  if (!existsSync(file)) return { name: "Your resume", ok: false, detail: `no file at ${file}`, fix };
  const size = statSync(file).size;
  const ok = /\.pdf$/i.test(file) && size > 0 && size <= DOCTOR.maxResumeBytes;
  return { name: "Your resume", ok, detail: `${path.basename(file)}, ${(size / 1024).toFixed(0)} KB`, fix: `The resume must be a PDF of at most ${DOCTOR.maxResumeBytes / 1_000_000} MB. ${fix}` };
}

export function checkOwnWords(): Check[] {
  const voice = existsSync(path.join(PATHS.data, "voice.local.md"));
  const bank = existsSync(PATHS.bank);
  return [
    { name: "Your voice guide", ok: voice, optional: true, detail: voice ? "data/voice.local.md" : "using the shipped data/voice.md", fix: "Copy data/voice.md to data/voice.local.md and edit it until a sample answer sounds like you" },
    { name: "Your drafts", ok: bank, optional: true, detail: bank ? "data/bank.json" : "using the example drafts, which are about a made-up person", fix: "Copy data/bank.example.json to data/bank.json and rewrite each draft with your own facts" },
  ];
}

export function checkQueue(): Check {
  const fix = "Run `node bin/jev.js discover` to find jobs";
  if (!existsSync(PATHS.queue)) return { name: "Job queue", ok: false, optional: true, detail: "no jobs found yet", fix };
  const q = loadQueue();
  const queued = q.entries.filter((e) => e.status === "queued").length;
  const ageHours = (Date.now() - new Date(q.generatedAt).getTime()) / 3_600_000;
  const fresh = ageHours <= DOCTOR.staleQueueHours;
  return { name: "Job queue", ok: queued > 0 && fresh, optional: true, detail: `${queued} jobs queued, last refreshed ${ageHours < 1 ? "under an hour" : `${Math.round(ageHours)} hours`} ago`, fix };
}

/**
 * Job-board accounts are optional. When the person set some up, this says whether what a sign-in
 * needs is there: the password in the Keychain, and Gmail when they let the tool read verification mail.
 */
export function checkAccounts(store: SecretStore = defaultStore(), files: { accounts?: string; gmail?: string } = {}): Check {
  const name = "Job-board accounts";
  let file;
  try {
    file = loadAccounts(files.accounts);
  } catch (err) {
    return { name, ok: false, optional: true, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200), fix: "Correct data/accounts.json, or set it up again with /accounts" };
  }
  const rule = file.providers.workday;
  if (!rule && !file.accounts.length) return { name, ok: true, optional: true, detail: "not set up, so jobs on Workday are skipped (optional: /accounts)", fix: "" };
  if (!file.enabled) return { name, ok: true, optional: true, detail: "set up, and switched off (/accounts on)", fix: "" };
  const wantsMail = !!rule?.emailVerification || file.accounts.some((a) => a.emailVerification);
  const mail = !!loadGmail(files.gmail) && !!store.get(GMAIL.refreshTokenItem);
  const how = rule?.mode === "create_if_missing" ? `sign in, or make an account (at most ${rule.maxNewAccountsPerDay} new a day)` : "sign in to the employers you listed";
  const verify = !wantsMail ? "" : mail ? ", verification emails read from Gmail" : ", you click each verification link (Gmail is not connected)";
  return { name, ok: true, optional: true, detail: `Workday: ${how}, ${file.accounts.filter((a) => a.mode !== "off").length} employer account(s)${verify}`, fix: "" };
}

/** One tiny DeepSeek call: proves the key is valid and has credit. */
export async function checkKeyOnline(): Promise<Check> {
  const fix = "Check the key at https://platform.deepseek.com/api_keys and that the account has credit";
  try {
    const jev = new JevClient({ usageLog: null });
    await jev.decide("The sky is blue.", { ok: noul("Does the text mention a colour?") }, "doctor");
    return { name: "DeepSeek answers", ok: true, detail: `one test call, $${jev.usage.costUsd.toFixed(6)}`, fix: "" };
  } catch (err) {
    return { name: "DeepSeek answers", ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300), fix };
  }
}

/** One tiny writer call: proves the writer's model answers with a JSON object, as every writer prompt asks. */
export async function checkWriterOnline(): Promise<Check> {
  const fix = "Check DEEPSEEK_API_KEY and WRITER_MODEL in .env, and that the DeepSeek account has credit";
  try {
    const text = await askWriter("ok?", 'Reply with the JSON object {"ok": true} and nothing else.');
    return { name: "Writer answers", ok: /"ok"\s*:\s*true/.test(text), detail: `DeepSeek, ${WRITER.model}`, fix };
  } catch (err) {
    return { name: "Writer answers", ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200), fix };
  }
}

export async function runChecks(online: boolean): Promise<Check[]> {
  const { check: profileCheck, profile } = checkProfile();
  const key = checkKey();
  const checks = [checkNode(), checkChrome(), key, profileCheck, checkResume(profile), ...checkOwnWords(), checkQueue(), checkAccounts()];
  if (online) {
    if (key.ok) checks.push(await checkKeyOnline());
    if (key.ok) checks.push(await checkWriterOnline());
  }
  return checks;
}

/** The first thing that blocks a run, or, when nothing does, the first optional improvement. */
export function nextStep(checks: Check[]): string {
  const blocking = checks.find((c) => !c.ok && !c.optional);
  if (blocking) return blocking.fix;
  const optional = checks.find((c) => !c.ok && c.optional);
  if (optional) return optional.fix;
  return "Everything is in place. Rehearse with `node bin/jev.js apply --dry --count 3`, then apply.";
}

export const isReadyToRun = (checks: Check[]) => checks.every((c) => c.ok || c.optional);

export function formatChecks(checks: Check[]): string {
  const mark = (c: Check) => (c.ok ? "ok      " : c.optional ? "optional" : "MISSING ");
  const lines = checks.map((c) => `${mark(c)}  ${c.name.padEnd(20)} ${c.detail}`);
  return [...lines, "", `Next step: ${nextStep(checks)}`].join("\n");
}
