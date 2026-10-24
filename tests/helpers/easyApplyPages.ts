/**
 * Stand-in pages for LinkedIn's Easy Apply dialog, on this machine. They hold the shape the dump
 * has to recognise (a dialog named easy-apply, Next and Submit controls, a form's email box) and
 * no personal information. Nothing here is reachable from another host.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const CONTACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>UI/UX Full-Stack Developer</title></head>
<body>
  <div id="site-search"><input type="text" aria-label="Search" placeholder="Search"></div>
  <main><h1>UI/UX Full-Stack Developer</h1><p>Perry Homes, Houston, TX</p><button>Easy Apply</button></main>
  <div role="dialog" class="jobs-easy-apply-modal" aria-label="Easy Apply">
    <h2>Easy Apply</h2>
    <p>Contact info</p>
    <label for="email">Email address</label>
    <input id="email" type="email" required>
    <label for="cc">Phone country code</label>
    <select id="cc"><option>United States (+1)</option><option>Canada (+1)</option></select>
    <label for="phone">Mobile phone number</label>
    <input id="phone" type="tel">
    <button>Back</button>
    <button>Next</button>
  </div>
</body></html>`;

const REVIEW = `<!doctype html>
<html><head><meta charset="utf-8"><title>UI/UX Full-Stack Developer</title></head>
<body>
  <div id="site-search"><input type="text" aria-label="Search" placeholder="Search"></div>
  <main><h1>UI/UX Full-Stack Developer</h1></main>
  <div role="dialog" class="jobs-easy-apply-modal" aria-label="Easy Apply">
    <h2>Review your application</h2>
    <p>Perry Homes</p>
    <button>Back</button>
    <button data-test-easy-apply-submit-button>Submit application</button>
  </div>
</body></html>`;

const SIGN_IN = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <div role="dialog" class="jobs-easy-apply-modal" aria-label="Easy Apply">
    <h2>Sign in to apply</h2>
    <label for="email">Email or phone</label>
    <input id="email" type="email">
    <button>Continue</button>
  </div>
</body></html>`;

const NATIVE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Senior Android Developer</title></head>
<body>
  <div id="site-search"><input type="text" aria-label="Search" placeholder="Search"></div>
  <main>
    <h1>Senior Android Developer</h1><p>Programmers.io</p><button>Easy Apply</button>
    <div class="apply-panel">
      <div class="apply-counter">1/4 pages</div>
      <p>Contact info</p>
      <label for="email">Email address</label>
      <select id="email"><option>person@example.com</option><option>other@example.com</option></select>
      <label for="cc">Phone country code</label>
      <select id="cc"><option>United States (+1)</option><option>Canada (+1)</option></select>
      <label for="phone">Mobile phone number</label>
      <input id="phone" type="tel">
      <footer><button>Next</button></footer>
    </div>
  </main>
</body></html>`;

export type EasyApplyPages = { origin: string; close: () => Promise<void> };

export async function startEasyApplyPages(): Promise<EasyApplyPages> {
  const pages: Record<string, string> = { "/contact.html": CONTACT, "/review.html": REVIEW, "/sign-in.html": SIGN_IN, "/native.html": NATIVE };
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0] ?? "";
    const body = pages[name];
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
