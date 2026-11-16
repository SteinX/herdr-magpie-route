import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The production view imports native modules; all routing and transport code stays real.
mock.module("gpui-kit", () => ({ View: class {} }));
mock.module("../mods/magpie-route/route-view.js", () => ({ renderRouting: view => view }));
const PORT = 43127;
const SESSION = "shared-session";
const realFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const runtime = {};
mock.module("herdr", () => Object.fromEntries([
  "appHome", "exec", "focused", "home", "layout", "nextCommand", "panes", "readTextFile", "spaces", "terminals",
].map(name => [name, (...args) => runtime[name](...args)])));

const { createMachineSource } = await import("../mods/magpie-route/machine-source.js");
const { default: MagpieRoute } = await import("../mods/magpie-route/main.js");
const { readTrace } = await import("../mods/magpie-route/routing-data.js");

beforeEach(() => {
  const storage = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  } });
  Object.assign(runtime, {
    appHome: () => "/installed/herdr/",
    home: () => "/local-home/",
    exec: mock(async () => { throw new Error("Unexpected exec"); }),
    readTextFile: mock(async () => { throw new Error("Unexpected local file read"); }),
    layout: () => ({ id: "magpie-route-panel" }),
    nextCommand: () => new Promise(() => {}),
    spaces: () => [], panes: () => [], terminals: () => [], focused: () => null,
  });
  globalThis.fetch = mock(async () => { throw new Error("Unexpected local fetch"); });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else delete globalThis.localStorage;
});

const response = data => ({ json: async () => data });
const result = data => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function remoteFixture(run) {
  const remoteHome = await mkdtemp(join(tmpdir(), "magpie-remote-"));
  const requests = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const seen = { method: request.method, path: url.pathname + url.search, host: url.host };
    requests.push(seen);
    if (url.pathname.endsWith("/failure")) return new Response("private upstream body", { status: 503 });
    return Response.json(seen);
  } });
  try {
    const config = join(remoteHome, ".config", "magpie");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ port: server.port, secret: "must-stay-remote" }));
    const calls = [];
    runtime.exec = mock(async (command, args, options) => {
      calls.push({ command, args, options });
      // Execute exactly what the source sent to Herdr, replacing only the target host.
      const child = Bun.spawn([command, ...args], {
        env: { ...process.env, HOME: remoteHome, HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, stdout, stderr };
    });
    await run({ source: createMachineSource("lab/east"), remoteHome, config, server, calls, requests });
  } finally {
    server.stop(true);
    await rm(remoteHome, { recursive: true, force: true });
  }
}

describe("machine source transport", () => {
  test("executes remote settings and GET/POST Python against target loopback", async () => {
    await remoteFixture(async ({ source, server, calls, requests }) => {
      expect(await source.loadPort()).toBe(server.port);
      expect(source.port).toBe(server.port);
      expect(await (await source.request("trace?after=9")).json()).toEqual({
        method: "GET", path: "/v1/magpie/trace?after=9", host: `127.0.0.1:${server.port}`,
      });
      await source.request("quotas/refresh", "POST");
      await source.request("models", "GET", "/v1/");
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v1/magpie/trace?after=9"], ["POST", "/v1/magpie/quotas/refresh"], ["GET", "/v1/models"],
      ]);
      expect(calls.every(call => call.command === "python3" && call.args[0] === "-c" && call.options.on === "lab/east")).toBe(true);
      expect(calls[2].options.timeout).toBe(33000);
      expect(runtime.readTextFile).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  test("remote HTTP failure preserves status without falling back locally", async () => {
    await remoteFixture(async ({ source, requests }) => {
      await source.loadPort();
      await expect(source.request("failure")).rejects.toMatchObject({
        messageKey: "system.httpError", messageValues: { status: 503 },
      });
      expect(requests).toHaveLength(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(runtime.readTextFile).not.toHaveBeenCalled();
    });
  });

  test("invalid remote settings never select the local or default port", async () => {
    await remoteFixture(async ({ source, config, requests }) => {
      await writeFile(join(config, "settings.json"), '{"port":0}');
      await expect(source.loadPort()).rejects.toMatchObject({ messageKey: "system.invalidPort" });
      expect(source.port).toBeNull();
      expect(requests).toHaveLength(0);
      expect(runtime.readTextFile).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  test("disconnected remote fails without inspecting this machine", async () => {
    runtime.exec = mock(async () => ({ code: 255, stdout: "", stderr: "private SSH diagnostic" }));
    const source = createMachineSource("offline");
    await expect(source.loadPort()).rejects.toThrow("selected machine");
    expect(source.port).toBeNull();
    expect(runtime.exec.mock.calls[0][2].on).toBe("offline");
    expect(runtime.readTextFile).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("remote helper receives argv unchanged and executes in target HOME", async () => {
    await remoteFixture(async ({ source, remoteHome, calls }) => {
      runtime.readTextFile = mock(async () => "import json,sys\nfrom pathlib import Path\nprint(json.dumps({'args':sys.argv[1:],'home':str(Path.home())}))\n");
      const args = ["session", "a session/'\";$HOME", "group/a/b"];
      const output = await source.runHelper("classifier-history.py", args, 6000);
      expect(output.code).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({ args, home: remoteHome });
      expect(runtime.readTextFile.mock.calls[0][0]).toBe("/installed/herdr/mods/magpie-route/classifier-history.py");
      expect(calls[0].args.slice(2)).toEqual(args);
      expect(calls[0].options).toEqual({ on: "lab/east", timeout: 6000 });
    });
  });

  test("local source reads local settings, fetches loopback and runs installed helper", async () => {
    runtime.readTextFile = mock(async () => JSON.stringify({ port: PORT }));
    globalThis.fetch = mock(async () => Response.json({ target: "local" }));
    runtime.exec = mock(async () => result({ terminal: "ta", session: SESSION }));
    const source = createMachineSource(null);
    expect(await source.loadPort()).toBe(PORT);
    expect(runtime.readTextFile.mock.calls[0][0]).toBe("/local-home/.config/magpie/settings.json");
    expect(await (await source.request("models", "GET", "/v1/")).json()).toEqual({ target: "local" });
    expect(globalThis.fetch.mock.calls[0]).toEqual([`http://127.0.0.1:${PORT}/v1/models`, { method: "GET" }]);
    await source.runHelper("resolve-session.py", ["ta"], 5000);
    expect(runtime.exec.mock.calls[0]).toEqual([
      "python3", ["/installed/herdr/mods/magpie-route/resolve-session.py", "ta"], { on: null, timeout: 5000 },
    ]);
  });
});

function select(machine, tab = "tab", terminal = `${machine === null ? "" : machine + "/"}ta`) {
  runtime.spaces = () => [{ id: "space", machine, active: true, tabs: [{ id: tab, name: "OMP", active: true }] }];
  runtime.panes = () => [{ tab, terminal, app: "omp", focused: true }];
  runtime.terminals = () => [{ address: terminal, state: "live", app: "omp" }];
  runtime.focused = () => ({ tab, terminal });
}

function context() {
  const queued = [];
  const cx = {
    queued, notify: mock(() => {}),
    focus_handle: () => ({ focus() {}, release() {} }),
    timer: { every() {} },
    spawn: task => queued.push(task),
    start: () => queued.splice(0).map(task => task(cx)),
    discard: () => { queued.length = 0; },
  };
  return cx;
}

function fakeSource(machine) {
  return { machine, port: PORT, loadPort: async () => PORT,
    request: async () => { throw new Error("Unexpected source request"); },
    runHelper: async () => { throw new Error("Unexpected source helper"); } };
}

function routePayload(owner) {
  return { object: "trace", pid: 42, seq: 1, ids: [7], totals: { requests: 1, rerouted: 0, errors: 0 }, routes: [{
    id: 7, seq: 1, time: "2026-11-16T10:00:00Z", session: SESSION, model: "group/test", done: true,
    status: 200, provider: owner, tries: [], rule: { classified: { by: owner, score: 1, sure: 1 } },
  }] };
}

async function seed(view, owner) {
  view.port = PORT;
  view.session = SESSION;
  view.trace = await readTrace({ port: PORT, request: async () => response(routePayload(owner)) });
  view.quotas = [{ name: owner }];
  view.quotasUpdated = owner;
  view.groups = [`group/${owner}`];
  view.usage = { owner };
  view.accounting = { owner };
  view.classifierHistory = { key: view.classifierHistoryKey(), state: "ready" };
  view.selectedId = 7;
}

async function viewFixture(machine = "A") {
  select(machine);
  const cx = context();
  const view = new MagpieRoute();
  view.init({}, cx);
  cx.discard(); // The perpetual native command listener is outside these state tests.
  view.sync(cx);
  cx.discard();
  view.resetBinding();
  view.source = fakeSource(machine);
  await seed(view, "A");
  return { view, cx, source: view.source };
}

function expectCleared(view) {
  expect(view.trace.routes.size).toBe(0);
  expect(view.trace.classifiers.size).toBe(0);
  expect(view.trace.seq).toBe(0);
  expect(view.quotas).toEqual([]);
  expect(view.quotasUpdated).toBeNull();
  expect(view.groups).toEqual([]);
  expect(view.usage).toBeNull();
  expect(view.accounting).toBeNull();
  expect(view.classifierHistory).toBeNull();
  expect(view.selectedId).toBeNull();
  expect(view.session).toBeNull();
  expect(view.port).toBeNull();
}

describe("view machine isolation", () => {
  for (const hidden of [false, true]) {
    test(`${hidden ? "hidden" : "visible"} A to B clears all A data synchronously`, async () => {
      const { view, cx, source } = await viewFixture();
      if (hidden) view.hide();
      select("B");
      view.sync(cx);
      expect(view.source).not.toBe(source);
      expect(view.source.machine).toBe("B");
      expectCleared(view);
    });
  }

  const pendingCases = [
    ["trace", "pollTrace", "traceJob", () => routePayload("late-A")],
    ["quota", "pollQuotas", "quotaJob", () => ({ object: "list", data: [{ name: "late-A" }] })],
    ["groups", "pollGroups", "groupJob", () => ({ data: [{ id: "group/late-A" }] })],
    ["usage", "pollUsage", "usageJob", () => ({ period: "all", calls: 1, input: 1, cache_read: 0, cache_write: 0, models: [] })],
    ["accounting", "pollAccounting", "accountingJob", () => ({ period: "all", total: 1, offset: 0, rows: [{
      session: SESSION, provider: "late-A", model: "model", in: 1, out: 1,
    }] })],
    ["classifier", "pollClassifierHistory", "classifierHistoryJob", () => ({ scope: "session", session: SESSION, group: "all", records: [{
      id: 7, time: "2026-11-16T11:00:00Z", session: SESSION, group: "group/test", classifier: { by: "late-A", score: 1, sure: 1 },
    }] })],
  ];

  for (const [name, poll, slot, payload] of pendingCases) {
    test(`delayed A ${name} cannot publish or detach B job with the same port and IDs`, async () => {
      const { view, cx, source } = await viewFixture();
      const gate = deferred();
      view.page = name === "accounting" ? "usage" : "routing";
      if (name === "classifier") { view.classifierHistory = null; view.trace.routes.clear(); }
      source.request = () => gate.promise.then(response);
      source.runHelper = () => gate.promise.then(result);
      view[poll](cx);
      const oldJobs = cx.start();
      expect(oldJobs).toHaveLength(1);
      select("B");
      view.sync(cx);
      expectCleared(view);
      cx.discard();
      view.source = fakeSource("B");
      await seed(view, "B");
      if (name === "classifier") { view.classifierHistory = null; view.trace.routes.clear(); }
      view[poll](cx);
      const bJob = view[slot];
      expect(bJob).toBeTruthy();
      const bState = { trace: view.trace, quotas: view.quotas, groups: view.groups, usage: view.usage,
        accounting: view.accounting, history: view.classifierHistory };
      gate.resolve(payload());
      await Promise.all(oldJobs);
      expect(view[slot]).toBe(bJob);
      expect(view.trace).toBe(bState.trace);
      expect(view.quotas).toBe(bState.quotas);
      expect(view.groups).toBe(bState.groups);
      expect(view.usage).toBe(bState.usage);
      expect(view.accounting).toBe(bState.accounting);
      expect(view.classifierHistory).toBe(bState.history);
      expect(view.session).toBe(SESSION);
      expect(view.error).toBeNull();
    });
  }

  for (const reject of [false, true]) {
    test(`delayed A config ${reject ? "error" : "success"} cannot replace B config`, async () => {
      const { view, cx, source } = await viewFixture();
      const gate = deferred();
      source.loadPort = () => gate.promise;
      view.loadPort(cx);
      const jobs = cx.start();
      select("B");
      view.sync(cx);
      cx.discard();
      view.source = fakeSource("B");
      view.loadPort(cx);
      await Promise.all(cx.start());
      expect(view.port).toBe(PORT);
      if (reject) gate.reject(new Error("A settings unreadable"));
      else gate.resolve(PORT + 1);
      await Promise.all(jobs);
      expect(view.port).toBe(PORT);
      expect(view.source.machine).toBe("B");
      expect(view.configError).toBeNull();
    });
  }

  test("delayed A binding cannot publish or clear B resolver", async () => {
    const { view, cx, source } = await viewFixture();
    const gate = deferred();
    source.runHelper = () => gate.promise;
    view.resetBinding();
    view.resolve(cx);
    const jobs = cx.start();
    select("B");
    view.sync(cx);
    const bJob = view.bindingJob;
    expect(bJob).toBeTruthy();
    view.session = SESSION;
    gate.resolve(result({ terminal: "ta", session: "late-A" }));
    await Promise.all(jobs);
    expect(view.session).toBe(SESSION);
    expect(view.bindingJob).toBe(bJob);
    expect(view.reason).toBeNull();
  });

  test("remote resolver strips the exact machine prefix including embedded slashes", async () => {
    const { view, cx, source } = await viewFixture("dev/lab");
    source.runHelper = mock(async () => result({ terminal: "ta", session: SESSION }));
    view.resetBinding();
    view.resolve(cx);
    await Promise.all(cx.start());
    expect(source.runHelper.mock.calls[0]).toEqual(["resolve-session.py", ["ta"], 5000]);
    expect(view.session).toBe(SESSION);
    view.resetBinding();
    view.target = { ...view.target, terminal: "other/dev/lab/ta" };
    view.resolve(cx);
    expect(cx.queued).toHaveLength(0);
    expect(source.runHelper).toHaveBeenCalledTimes(1);
    expect(view.session).toBeNull();
    expect(view.reason.key).toBe("system.noLocalTerminal");
  });

  test("same-machine tab switch preserves machine-wide usage and trace", async () => {
    const { view, cx, source } = await viewFixture();
    view.scope = "all";
    const { usage, quotas, accounting, trace } = view;
    select("A", "other-tab");
    view.sync(cx);
    expect(view.source).toBe(source);
    expect(view.usage).toBe(usage);
    expect(view.quotas).toBe(quotas);
    expect(view.accounting).toBe(accounting);
    expect(view.trace).toBe(trace);
  });

  test("same-machine refresh replaces source and rejects its pending config", async () => {
    const { view, cx, source } = await viewFixture();
    const gate = deferred();
    source.loadPort = () => gate.promise;
    view.loadPort(cx);
    const jobs = cx.start();
    view.refresh(cx);
    expect(view.source).not.toBe(source);
    expect(view.source.machine).toBe("A");
    expect(view.port).toBeNull();
    gate.resolve(PORT + 1);
    await Promise.all(jobs);
    expect(view.port).toBeNull();
    expect(view.configError).toBeNull();
  });

  test("no selected space has no source and cannot poll local data", () => {
    const cx = context();
    const view = new MagpieRoute();
    view.init({}, cx);
    cx.discard();
    view.sync(cx);
    expect(view.source).toBeNull();
    expect(view.port).toBeNull();
    expect(cx.queued).toHaveLength(0);
    expect(runtime.exec).not.toHaveBeenCalled();
    expect(runtime.readTextFile).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
