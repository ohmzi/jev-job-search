// Every test file starts with its own empty shared folder (the lock, the list of sent jobs, the pause
// switch, the browser profile). Without it a test would read the real ones: a pause or a lock left on
// this machine would change what the tests find.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JEV_SHARED_DIR = mkdtempSync(path.join(os.tmpdir(), "jev-test-shared-"));
