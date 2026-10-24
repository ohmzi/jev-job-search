/**
 * A server for the challenge fixtures on this machine. It serves only the protection pages,
 * by name, so a browser test can load a stand-in wall without reaching Cloudflare, Akamai or
 * DataDome. Nothing here is reachable from another host.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NAME = /^[a-z0-9-]+\.html$/;

export type ProtectionPages = { origin: string; close: () => Promise<void> };

export async function startProtectionPages(): Promise<ProtectionPages> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "").replace(/^\//, "");
    if (!NAME.test(name)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    try {
      const body = readFileSync(path.join(FIXTURES, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
