/**
 * Running `daily` every day at a set time, through macOS's own scheduler (a LaunchAgent in the
 * person's account). Nothing is installed until the person runs `schedule install`, and
 * `schedule remove` takes it away again. The Mac has to be on and signed in at that time.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, DAILY, HOURLY, PATHS, ROOT } from "../config.js";

export const agentFile = (home = homedir()) => path.join(home, "Library", "LaunchAgents", `${DAILY.label}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "09:00" as an hour and a minute. Null for anything that is not a time of day. */
export function timeOfDay(at: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** The LaunchAgent: run `jev daily` in the project folder at that time each day, with its output in the daily log. */
export function agentPlist(o: { node: string; root: string; hour: number; minute: number; searchPath: string; log: string }): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(DAILY.label)}
  <key>ProgramArguments</key>
  <array>${str(o.node)}${str(path.join(o.root, "bin", "jev.js"))}${str("daily")}</array>
  <key>WorkingDirectory</key>${str(o.root)}
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${o.hour}</integer><key>Minute</key><integer>${o.minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${str(o.searchPath)}</dict>
  <key>StandardOutPath</key>${str(o.log)}
  <key>StandardErrorPath</key>${str(o.log)}
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

type Launchctl = (args: string[]) => { status: number | null };
const launchctl: Launchctl = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", env: childEnv() });
const domain = () => `gui/${process.getuid?.() ?? 0}`;

export function installSchedule(at: string = DAILY.at, o: { file?: string; run?: Launchctl; node?: string; root?: string; searchPath?: string } = {}): { file: string; at: string } {
  if (process.platform !== "darwin" && !o.run) throw new Error("the scheduled run uses macOS's scheduler. On another system, run `node bin/jev.js daily` from your own scheduler");
  const time = timeOfDay(at);
  if (!time) throw new Error(`"${at}" is not a time of day. Give it as HH:MM, for example 09:00`);
  const file = o.file ?? agentFile();
  const run = o.run ?? launchctl;
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(PATHS.dailyLog), { recursive: true });
  // One that is already loaded is taken out first, so a new time replaces the old one.
  run(["bootout", `${domain()}/${DAILY.label}`]);
  writeFileSync(file, agentPlist({ node: o.node ?? process.execPath, root: o.root ?? ROOT, ...time, searchPath: o.searchPath ?? process.env.PATH ?? "/usr/bin:/bin", log: PATHS.dailyLog }));
  if (run(["bootstrap", domain(), file]).status !== 0) throw new Error(`macOS did not take the schedule. The file is at ${file}`);
  return { file, at: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` };
}

export function removeSchedule(o: { file?: string; run?: Launchctl } = {}): boolean {
  const file = o.file ?? agentFile();
  (o.run ?? launchctl)(["bootout", `${domain()}/${DAILY.label}`]);
  const was = existsSync(file);
  rmSync(file, { force: true });
  return was;
}

/** Whether a schedule is installed, whether macOS has it loaded, and the time of day it runs. */
export function scheduleStatus(o: { file?: string; run?: Launchctl } = {}): { installed: boolean; loaded: boolean; file: string; at: string | null } {
  const file = o.file ?? agentFile();
  const installed = existsSync(file);
  let at: string | null = null;
  if (installed) {
    const m = /<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/.exec(readFileSync(file, "utf8"));
    if (m) at = `${String(m[1]).padStart(2, "0")}:${String(m[2]).padStart(2, "0")}`;
  }
  return { installed, loaded: installed && (o.run ?? launchctl)(["print", `${domain()}/${DAILY.label}`]).status === 0, file, at };
}

// ------------------------------------------------------------------ hourly search

/** A portable name for the portal, safe in a file name on both schedulers. */
export function portalSlug(portal: string): string {
  return portal.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "portal";
}

/** Where the hourly LaunchAgent lives on macOS. */
export const hourlyAgentFile = (portal: string, home = homedir()) =>
  path.join(home, "Library", "LaunchAgents", `com.jev-job-search.${HOURLY.labelPrefix}.${portalSlug(portal)}.plist`);

/** Where the hourly systemd units live on Linux. */
export const hourlyUnitDir = (home = homedir()) => path.join(home, ".config", "systemd", "user");
export const hourlyUnitFiles = (portal: string, home = homedir()) => {
  const name = `${HOURLY.labelPrefix}-${portalSlug(portal)}`;
  return { service: path.join(hourlyUnitDir(home), `${name}.service`), timer: path.join(hourlyUnitDir(home), `${name}.timer`), name };
};

/** The LaunchAgent: run the hourly search at this minute of every hour. */
export function hourlyAgentPlist(o: { portal: string; node: string; root: string; minute: number; searchPath: string; log: string }): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(`com.jev-job-search.${HOURLY.labelPrefix}.${portalSlug(o.portal)}`)}
  <key>ProgramArguments</key>
  <array>${str(o.node)}${str(path.join(o.root, "bin", "jev.js"))}${str("hourly")}</array>
  <key>WorkingDirectory</key>${str(o.root)}
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>${o.minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${str(o.searchPath)}</dict>
  <key>StandardOutPath</key>${str(o.log)}
  <key>StandardErrorPath</key>${str(o.log)}
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/** The systemd service and timer for one portal. */
export function hourlyServiceUnit(o: { portal: string; node: string; root: string; searchPath: string; log: string; name: string }): string {
  return `[Unit]
Description=jev hourly job search (${o.portal})

[Service]
Type=oneshot
WorkingDirectory=${o.root}
Environment=PATH=${o.searchPath}
ExecStart=${o.node} ${path.join(o.root, "bin", "jev.js")} hourly
StandardOutput=append:${o.log}
StandardError=append:${o.log}
`;
}

export function hourlyTimerUnit(o: { portal: string; minute: number; name: string }): string {
  return `[Unit]
Description=jev hourly job search (${o.portal})

[Timer]
OnCalendar=*-*-* *:${String(o.minute).padStart(2, "0")}:00
Unit=${o.name}.service

[Install]
WantedBy=timers.target
`;
}

type Scheduler = (args: string[]) => { status: number | null };

/** systemctl for this user's own services. */
const systemctl: Scheduler = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: childEnv() });

const platformOf = (o: { platform?: NodeJS.Platform }) => o.platform ?? process.platform;

/**
 * Installs the hourly search for one portal. macOS gets a LaunchAgent; Linux gets a systemd user
 * timer. The portal's minute offset keeps four clones from asking the boards at the same moment.
 */
export function installHourlySchedule(
  portal: string,
  minute: number,
  o: { platform?: NodeJS.Platform; file?: string; run?: Scheduler; node?: string; root?: string; searchPath?: string; home?: string } = {},
): { file: string; minute: number } {
  const platform = platformOf(o);
  const at = ((minute % 60) + 60) % 60;
  const searchPath = o.searchPath ?? process.env.PATH ?? "/usr/bin:/bin";
  if (platform === "darwin") {
    const file = o.file ?? hourlyAgentFile(portal, o.home);
    const run = o.run ?? launchctl;
    const label = `com.jev-job-search.${HOURLY.labelPrefix}.${portalSlug(portal)}`;
    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(path.dirname(PATHS.hourlyLog), { recursive: true });
    run(["bootout", `${domain()}/${label}`]);
    writeFileSync(file, hourlyAgentPlist({ portal, node: o.node ?? process.execPath, root: o.root ?? ROOT, minute: at, searchPath, log: PATHS.hourlyLog }));
    if (run(["bootstrap", domain(), file]).status !== 0) throw new Error(`macOS did not take the hourly schedule. The file is at ${file}`);
    return { file, minute: at };
  }
  const run = o.run ?? systemctl;
  const files = hourlyUnitFiles(portal, o.home);
  mkdirSync(path.dirname(files.service), { recursive: true });
  mkdirSync(path.dirname(PATHS.hourlyLog), { recursive: true });
  writeFileSync(files.service, hourlyServiceUnit({ portal, node: o.node ?? process.execPath, root: o.root ?? ROOT, searchPath, log: PATHS.hourlyLog, name: files.name }));
  writeFileSync(files.timer, hourlyTimerUnit({ portal, minute: at, name: files.name }));
  const reload = run(["daemon-reload"]);
  if (reload.status !== 0) throw new Error(`systemd did not reload. The units are at ${hourlyUnitDir(o.home)}`);
  const enabled = run(["enable", "--now", `${files.name}.timer`]);
  if (enabled.status !== 0) throw new Error(`systemd did not start the hourly timer. The units are at ${hourlyUnitDir(o.home)}`);
  return { file: files.timer, minute: at };
}

/** Removes one portal's hourly schedule. True when something was there. */
export function removeHourlySchedule(portal: string, o: { platform?: NodeJS.Platform; home?: string; run?: Scheduler } = {}): boolean {
  const platform = platformOf(o);
  if (platform === "darwin") {
    const file = hourlyAgentFile(portal, o.home);
    const label = `com.jev-job-search.${HOURLY.labelPrefix}.${portalSlug(portal)}`;
    (o.run ?? launchctl)(["bootout", `${domain()}/${label}`]);
    const was = existsSync(file);
    rmSync(file, { force: true });
    return was;
  }
  const run = o.run ?? systemctl;
  const files = hourlyUnitFiles(portal, o.home);
  run(["disable", "--now", `${files.name}.timer`]);
  const was = existsSync(files.timer) || existsSync(files.service);
  rmSync(files.timer, { force: true });
  rmSync(files.service, { force: true });
  run(["daemon-reload"]);
  return was;
}

/** Whether a portal's hourly timer is installed, loaded, and at which minute it runs. */
export function hourlyScheduleStatus(
  portal: string,
  o: { platform?: NodeJS.Platform; home?: string; run?: Scheduler } = {},
): { installed: boolean; loaded: boolean; file: string; minute: number | null } {
  const platform = platformOf(o);
  if (platform === "darwin") {
    const file = hourlyAgentFile(portal, o.home);
    const label = `com.jev-job-search.${HOURLY.labelPrefix}.${portalSlug(portal)}`;
    const installed = existsSync(file);
    const m = installed ? /<key>Minute<\/key><integer>(\d+)<\/integer>/.exec(readFileSync(file, "utf8")) : null;
    return { installed, loaded: installed && ((o.run ?? launchctl)(["print", `${domain()}/${label}`]).status === 0), file, minute: m ? Number(m[1]) : null };
  }
  const files = hourlyUnitFiles(portal, o.home);
  const installed = existsSync(files.timer);
  const m = installed ? /^OnCalendar=.*\*:(\d{2}):00$/m.exec(readFileSync(files.timer, "utf8")) : null;
  return { installed, loaded: installed && ((o.run ?? systemctl)(["is-enabled", `${files.name}.timer`]).status === 0), file: files.timer, minute: m ? Number(m[1]) : null };
}

/** The next moment a schedule at this time of day runs, after now. */
export function nextRun(at: string, now = new Date()): Date | null {
  const t = timeOfDay(at);
  if (!t) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hour, t.minute, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
