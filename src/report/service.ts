/**
 * A dashboard that keeps running: a systemd user service on Linux. The unit starts
 * `jev report --port <port>` in this folder, restarts it if it exits badly, and writes what it
 * prints to data/runs/report.log. Nothing is installed until the person asks for it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, PATHS, REPORT, ROOT } from "../config.js";

export const reportServiceDir = (home = homedir()) => path.join(home, ".config", "systemd", "user");

/** A service name unique to this folder: jev-report-android-nj, jev-report-job-search. */
export function reportServiceName(root = ROOT): string {
  const base = path.basename(root).toLowerCase().replace(/^jev-/, "").replace(/[^a-z0-9-]+/g, "-");
  return `${REPORT.servicePrefix}-${base || "dashboard"}`;
}

export const reportServiceFile = (root = ROOT, home = homedir()) =>
  path.join(reportServiceDir(home), `${reportServiceName(root)}.service`);

/** The unit. Simple, one process, restarted on a bad exit, with its output in the run log. */
export function reportServiceUnit(o: { name: string; root: string; port: number; node: string; searchPath: string; log: string }): string {
  return `[Unit]
Description=jev dashboard (${o.name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${o.root}
Environment=PATH=${o.searchPath}
ExecStart=${o.node} ${path.join(o.root, "bin", "jev.js")} report --port ${o.port}
Restart=on-failure
RestartSec=5
StandardOutput=append:${o.log}
StandardError=append:${o.log}

[Install]
WantedBy=default.target
`;
}

type Scheduler = (args: string[]) => { status: number | null };

/** systemctl for this user's own services. */
const systemctl: Scheduler = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: childEnv() });

export type ReportServiceOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  root?: string;
  node?: string;
  searchPath?: string;
  log?: string;
  run?: Scheduler;
};

const requireSystemd = (o: ReportServiceOptions) => {
  if ((o.platform ?? process.platform) !== "linux") {
    throw new Error("the dashboard service uses systemd. On macOS, keep the dashboard running with a LaunchAgent or `node bin/jev.js report --port <port>`.");
  }
};

/** Writes the unit, reloads systemd, and enables and starts it now. */
export function installReportService(port: number, o: ReportServiceOptions = {}): { file: string; name: string } {
  requireSystemd(o);
  const root = o.root ?? ROOT;
  const name = reportServiceName(root);
  const file = reportServiceFile(root, o.home);
  const log = o.log ?? PATHS.reportLog;
  const run = o.run ?? systemctl;
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(
    file,
    reportServiceUnit({ name, root, port, node: o.node ?? process.execPath, searchPath: o.searchPath ?? process.env.PATH ?? "/usr/bin:/bin", log }),
  );
  const reload = run(["daemon-reload"]);
  if (reload.status !== 0) throw new Error(`systemd did not reload. The unit is at ${file}`);
  const enabled = run(["enable", "--now", `${name}.service`]);
  if (enabled.status !== 0) throw new Error(`systemd did not start the dashboard. The unit is at ${file}`);
  return { file, name };
}

/** Stops and disables the service and removes the unit. True when a unit was there. */
export function removeReportService(o: ReportServiceOptions = {}): boolean {
  requireSystemd(o);
  const root = o.root ?? ROOT;
  const name = reportServiceName(root);
  const file = reportServiceFile(root, o.home);
  const run = o.run ?? systemctl;
  run(["disable", "--now", `${name}.service`]);
  const was = existsSync(file);
  rmSync(file, { force: true });
  run(["daemon-reload"]);
  return was;
}

/** Whether the unit is on disk, running now, and set to start with the user's session. */
export function reportServiceStatus(o: ReportServiceOptions = {}): { installed: boolean; active: boolean; enabled: boolean; file: string; name: string } {
  const root = o.root ?? ROOT;
  const name = reportServiceName(root);
  const file = reportServiceFile(root, o.home);
  const run = o.run ?? systemctl;
  const installed = existsSync(file);
  return {
    installed,
    active: installed && run(["is-active", `${name}.service`]).status === 0,
    enabled: installed && run(["is-enabled", `${name}.service`]).status === 0,
    file,
    name,
  };
}
