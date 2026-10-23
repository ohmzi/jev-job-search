/**
 * The script every tab gets before its own scripts run. A visible Chrome driven over the
 * DevTools protocol already looks like a browser in most ways; the handful of tells that
 * remain are removed here, so a protected form sees a window a person could have opened.
 *
 * It is a plain string on purpose: it runs inside the page, imports nothing, sets no timers,
 * and never reads or writes any value the tool was given. It is also the one place where
 * `Function.prototype.toString` is masked, so the patched getters look native when asked.
 */
export const STEALTH = `(() => {
  const g = globalThis;
  const w = g.window && g.window !== g ? g.window : g;
  const toText = Function.prototype.toString;
  const masked = new WeakMap();
  const hide = (fn, name) => {
    try { masked.set(fn, "function " + name + "() { [native code] }"); } catch (e) {}
    return fn;
  };
  try {
    Function.prototype.toString = hide(function toString() {
      const own = masked.get(this);
      return own || toText.call(this);
    }, "toString");
  } catch (e) {}

  const nav = g.navigator;
  if (nav) {
    const put = (obj, name, value) => {
      try { Object.defineProperty(obj, name, { get: hide(function () { return value; }, "get " + name), configurable: true, enumerable: true }); return true; } catch (e) { return false; }
    };
    // A browser driven over the protocol answers true here. It is a getter on the prototype in
    // Chrome, and an own value on some stands-ins; both are covered.
    if (!put(nav, "webdriver", false)) {
      try { Object.defineProperty(Object.getPrototypeOf(nav), "webdriver", { get: hide(function () { return false; }, "get webdriver"), configurable: true }); } catch (e) {}
    }
    const list = (items) => {
      const a = items.slice();
      a.item = hide(function item(i) { return a[i] || null; }, "item");
      a.namedItem = hide(function namedItem(n) { return a.filter(function (x) { return x.name === n; })[0] || null; }, "namedItem");
      return a;
    };
    const plugins = list([
      { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 2 },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 2 },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 2 },
    ]);
    const mimes = list([
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: plugins[0] },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: plugins[0] },
    ]);
    try { if (!nav.plugins || nav.plugins.length === 0) put(nav, "plugins", plugins); } catch (e) {}
    try { if (!nav.mimeTypes || nav.mimeTypes.length === 0) put(nav, "mimeTypes", mimes); } catch (e) {}
    try {
      if (!nav.languages || nav.languages.length === 0) {
        const tag = nav.language || "en-US";
        put(nav, "languages", /^en/i.test(tag) ? ["en-US", "en"] : [tag]);
        put(nav, "language", /^en/i.test(tag) ? "en-US" : tag);
      }
    } catch (e) {}
    try {
      const perms = nav.permissions;
      const ask = perms && perms.query;
      if (ask) {
        const query = ask.bind(perms);
        perms.query = hide(function query(p) {
          if (p && p.name === "notifications") {
            const state = (g.Notification && g.Notification.permission) || "default";
            if (state === "denied") {
              return Promise.resolve({ state: "prompt", onchange: null, addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; } });
            }
          }
          return query(p);
        }, "query");
      }
    } catch (e) {}
  }

  if (!w.chrome) {
    w.chrome = {
      runtime: {},
      app: {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      },
      loadTimes: hide(function loadTimes() {}, "loadTimes"),
      csi: hide(function csi() {}, "csi"),
    };
  }

  // Names a browser extension or an automation driver leaves behind. None of them belong to a window a person opened.
  const ARTIFACT = /^(cdc_|__playwright|__puppeteer|_phantom|__driver|__webdriver|__selenium|__nightmare|__fxdriver)/;
  for (const target of [w, g]) {
    try {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (ARTIFACT.test(key)) { try { delete target[key]; } catch (e) {} }
      }
    } catch (e) {}
  }
})();`;
