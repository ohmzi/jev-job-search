import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installReportService, removeReportService, reportServiceFile, reportServiceName, reportServiceStatus } from "../src/report/service.js";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "jev-report-service-"));
const fake = (calls: string[][]) => (args: string[]) => { calls.push(args); return { status: 0 }; };

describe("the dashboard's systemd service", () => {
  it("names the service after the folder, without the jev- prefix", () => {
    expect(reportServiceName("/home/x/jev-android-nj")).toBe("jev-report-android-nj");
    expect(reportServiceName("/home/x/jev-fullstack-tx")).toBe("jev-report-fullstack-tx");
    expect(reportServiceName("/home/x/jev-job-search")).toBe("jev-report-job-search");
  });

  it("writes a unit that runs the dashboard on the port and restarts it", () => {
    const home = temp();
    const calls: string[][] = [];
    const log = path.join(home, "report.log");
    const out = installReportService(7421, { platform: "linux", home, root: "/repo/jev-android-nj", node: "/usr/bin/node", searchPath: "/usr/bin", log, run: fake(calls) });
    expect(out.name).toBe("jev-report-android-nj");
    const unit = readFileSync(reportServiceFile("/repo/jev-android-nj", home), "utf8");
    expect(unit).toContain("ExecStart=/usr/bin/node /repo/jev-android-nj/bin/jev.js report --port 7421");
    expect(unit).toContain("WorkingDirectory=/repo/jev-android-nj");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`StandardOutput=append:${log}`);
    expect(calls.some((c) => c.includes("enable") && c.includes("--now"))).toBe(true);
  });

  it("reports whether the unit is installed, running and enabled", () => {
    const home = temp();
    const calls: string[][] = [];
    installReportService(7421, { platform: "linux", home, root: "/repo/jev-android-nj", log: path.join(home, "r.log"), run: fake(calls) });
    const status = reportServiceStatus({ platform: "linux", home, root: "/repo/jev-android-nj", run: fake(calls) });
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.enabled).toBe(true);
  });

  it("removes the unit and stops the service", () => {
    const home = temp();
    const calls: string[][] = [];
    installReportService(7421, { platform: "linux", home, root: "/repo/jev-android-nj", log: path.join(home, "r.log"), run: fake(calls) });
    const file = reportServiceFile("/repo/jev-android-nj", home);
    expect(existsSync(file)).toBe(true);
    expect(removeReportService({ platform: "linux", home, root: "/repo/jev-android-nj", run: fake(calls) })).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(calls.some((c) => c.includes("disable"))).toBe(true);
  });

  it("says systemd is Linux only", () => {
    expect(() => installReportService(7421, { platform: "darwin", home: temp() })).toThrow(/systemd/);
  });
});
