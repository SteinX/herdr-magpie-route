import { View } from "gpui-kit";
import { appHome, exec, focused, home, layout, nextCommand, panes, readTextFile, spaces, terminals } from "herdr";
import { emptyTrace, filterRoutes, readQuotas, readTrace } from "./routing-data.js";
import { renderRouting } from "./route-view.js";
import { createI18n, messageError } from "./i18n.js";

const PANEL = "magpie-route-panel";
const DEFAULT_PORT = 3425;
const REBIND_MS = 5000;
const QUOTA_MS = 30000;
const nonempty = value => typeof value === "string" && value.trim().length > 0;

function shown(node, hidden = false) {
  if (!node || typeof node !== "object") return false;
  const off = hidden || node.hidden === true;
  if (node.id === PANEL) return !off;
  return (node.children ?? []).some(child => shown(child, off));
}

function isOMP(pane, terminal) {
  return pane?.app === "omp" || pane?.program?.key === "omp"
    || terminal?.app === "omp" || terminal?.report?.app === "omp" || terminal?.program?.key === "omp";
}

function failure(error) {
  if (typeof error?.messageKey === "string") return { key: error.messageKey, values: error.messageValues ?? {} };
  return String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, "Magpie").slice(0, 300);
}

/** Native routing dashboard: live routes, global quotas, and paged recent requests. */
export default class MagpieRoute extends View {
  init(_props, cx) {
    this.i18n = createI18n(localStorage.getItem("locale"));
    this.locale = this.i18n.locale;
    this.visible = false;
    this.closed = false;
    this.target = null;
    this.recent = new Map();
    this.session = null;
    this.reason = null;
    this.bindingBusy = false;
    this.bindingJob = null;
    this.bindingGeneration = 0;
    this.lastBinding = 0;
    this.bindingPaused = false;
    this.trace = emptyTrace();
    this.traceJob = null;
    this.streamGeneration = 0;
    this.streamEnabled = true;
    this.connection = "unbound";
    this.error = null;
    this.port = null;
    this.configError = null;
    this.configGeneration = 0;
    this.quotaJob = null;
    this.quotaBusy = false;
    this.quotas = [];
    this.quotasUpdated = null;
    this.quotaError = null;
    this.lastQuota = 0;
    this.scope = "session";
    this.adaptiveOnly = localStorage.getItem("adaptive-only") !== "false";
    this.masked = localStorage.getItem("masked") !== "false";
    this.motion = localStorage.getItem("motion") !== "false";
    this.selectedId = null;
    this.recentExpanded = false;
    this.recentPage = 0;
    this.recentPageCount = 1;
    this.graphWidth = 360;
    // One view owns immutable graph paths and synchronized frames across visual redraws.
    this._routingGraphCache = { paths: new Map(), frames: null };
    this.focusHandles = new Map(["refresh", "scope-session", "scope-all", "adaptive", "privacy", "motion", "locale", "quota-refresh",
      "recent-toggle", "recent-prev", "recent-next"]
      .map(key => [key, cx.focus_handle()]));
    this.loadPort(cx);
    // Timers fetch data only. GPUI animates observed live paths natively.
    // Omit trace's `wait`: any nonempty value holds the request for up to 25s.
    cx.timer.every(1000, cx => {
      if (!shown(layout())) { this.hide(); return; }
      if (!this.visible || this.closed) return;
      if (this.target?.terminal && Date.now() - this.lastBinding >= REBIND_MS) this.resolve(cx);
      this.pollTrace(cx);
      if (Date.now() - this.lastQuota >= QUOTA_MS) this.pollQuotas(cx);
    });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.focusHandles.values().next().value?.focus();
        else if (command === "refresh") this.refresh(cx);
        else if (command === "locale") this.toggleLocale(cx);
      }
    });
  }

  syncRouteFocus(cx) {
    const keys = new Set();
    for (const id of this.trace.routes.keys()) {
      const key = `route-${encodeURIComponent(String(id))}`;
      keys.add(key);
      if (!this.focusHandles.has(key)) this.focusHandles.set(key, cx.focus_handle());
    }
    for (const [key, handle] of this.focusHandles) {
      if (key.startsWith("route-") && !keys.has(key)) {
        handle.release();
        this.focusHandles.delete(key);
      }
    }
  }

  selection() {
    const allSpaces = spaces();
    const allPanes = panes();
    const allTerminals = terminals();
    const focus = focused();
    const space = allSpaces.find(space => space.active);
    const tab = space?.tabs.find(tab => tab.id === focus?.tab) ?? space?.tabs.find(tab => tab.active);
    if (!space || !tab) return { key: "no-tab", name: this.i18n.msg("system.noTabSelected"), terminal: null, reason: { key: "system.selectOMP", values: {} } };
    const key = `${space.id}/${tab.id}`;
    if (space.machine !== null) return { key, name: tab.name, terminal: null, reason: { key: "system.remoteTab", values: {} } };
    const byAddress = new Map(allTerminals.map(terminal => [terminal.address, terminal]));
    const candidates = allPanes.filter(pane => {
      if (pane.tab !== tab.id || !pane.terminal) return false;
      const terminal = byAddress.get(pane.terminal);
      return (!terminal || terminal.state === "live") && isOMP(pane, terminal);
    });
    const current = candidates.find(pane => pane.terminal === focus?.terminal)
      ?? candidates.find(pane => pane.focused);
    if (current) this.recent.set(key, current.terminal);
    const chosen = current ?? candidates.find(pane => pane.terminal === this.recent.get(key)) ?? candidates[0];
    return {
      key: `${key}/${chosen?.terminal ?? "no-omp"}`,
      name: tab.name,
      terminal: chosen?.terminal ?? null,
      reason: chosen ? null : { key: "system.noForegroundTerminal", values: {} },
    };
  }

  resetBinding() {
    this.bindingGeneration++;
    this.session = null;
    this.reason = null;
    this.selectedId = null;
    if (this.scope !== "all") this.resetRecent();
    this.bindingPaused = false;
    this.lastBinding = 0;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.target = null;
    this.resetBinding();
    // A hidden copy remains alive in Herdr: invalidate replies, keep the cursor.
    this.streamGeneration++;
    this.connection = "unbound";
  }

  sync(cx) {
    if (this.closed) return;
    if (!shown(layout())) { this.hide(); return; }
    const next = this.selection();
    const opening = !this.visible;
    const switched = opening || this.target?.key !== next.key;
    this.visible = true;
    this.target = next;
    if (switched) {
      // Filtering is synchronous: no old session can appear under a new tab.
      this.resetBinding();
      this.reason = next.reason;
      if (next.terminal) this.resolve(cx);
    }
    if (opening) {
      this.connection = "connecting";
      this.streamEnabled = true;
      this.pollTrace(cx);
      this.pollQuotas(cx);
    }
  }

  loadPort(cx) {
    const generation = ++this.configGeneration;
    this.configError = null;
    cx.spawn(async cx => {
      try {
        // Read only the documented gateway port, never provider credentials.
        const source = await readTextFile(home().replace(/[\\/]+$/, "") + "/.config/magpie/settings.json");
        const port = (source === null ? {} : JSON.parse(source))?.port ?? DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw messageError("system.invalidPort");
        if (generation !== this.configGeneration || this.closed) return;
        this.port = port;
      } catch (error) {
        if (generation !== this.configGeneration || this.closed) return;
        this.configError = { key: "system.configFailed", values: { error: failure(error) } };
        this.connection = "offline";
      }
      cx.notify();
      this.pollTrace(cx);
      this.pollQuotas(cx);
    });
  }

  resolve(cx) {
    if (!this.visible || this.closed || !this.target?.terminal || this.bindingPaused || this.bindingJob) return;
    const job = { generation: this.bindingGeneration, terminal: this.target.terminal };
    this.bindingJob = job;
    this.bindingBusy = true;
    this.lastBinding = Date.now();
    cx.spawn(async cx => {
      try {
        // Resolve the foreground PID's uniquely open root session. Never infer
        // identity from cwd, account, model, process argv or a session title.
        const helper = appHome().replace(/[\\/]+$/, "") + "/mods/magpie-route/resolve-session.py";
        const result = await exec("python3", [helper, job.terminal], { timeout: 5000 });
        if (job.generation !== this.bindingGeneration || !this.visible || this.closed) return;
        if (result.code !== 0) throw result.stderr.trim()
          ? new Error(result.stderr.trim()) : messageError("system.resolverExited", { code: result.code });
        const binding = JSON.parse(result.stdout);
        if (binding?.terminal !== job.terminal || !(binding.session === null || nonempty(binding.session))) throw messageError("system.invalidBinding");
        const reason = binding.session ? null : { key: binding.reason || "system.awaitingRequest", values: {} };
        const changed = this.session !== binding.session || this.reason?.key !== reason?.key;
        if (this.session !== binding.session) this.selectedId = null;
        this.session = binding.session;
        this.reason = reason;
        if (changed) cx.notify();
      } catch (error) {
        if (job.generation !== this.bindingGeneration || !this.visible || this.closed) return;
        this.session = null;
        this.selectedId = null;
        this.bindingPaused = true;
        this.reason = { key: "system.bindingFailed", values: { error: failure(error) } };
        cx.notify();
      } finally {
        if (this.bindingJob === job) {
          this.bindingJob = null;
          this.bindingBusy = false;
        }
        if (!this.visible || this.closed) return;
        if (job.generation !== this.bindingGeneration && this.target?.terminal) this.resolve(cx);
        cx.notify();
      }
    });
  }

  pollTrace(cx) {
    if (!this.visible || this.closed || this.traceJob || !this.streamEnabled || this.port === null || this.configError) return;
    const job = { generation: this.streamGeneration, port: this.port };
    this.traceJob = job;
    cx.spawn(async cx => {
      try {
        const next = await readTrace(job.port, this.trace);
        if (job.generation !== this.streamGeneration || !this.visible || this.closed) return;
        const changed = this.connection !== "live" || next.pid !== this.trace.pid || next.seq !== this.trace.seq;
        if (next.pid !== this.trace.pid) this.selectedId = null;
        this.trace = next;
        this.syncRouteFocus(cx);
        if (this.selectedId !== null && !next.routes.has(this.selectedId)) this.selectedId = null;
        this.connection = "live";
        this.error = null;
        if (changed) cx.notify();
      } catch (error) {
        if (job.generation !== this.streamGeneration || !this.visible || this.closed) return;
        this.connection = "offline";
        this.error = { key: "system.traceFailed", values: { error: failure(error) } };
        this.streamEnabled = false;
        cx.notify();
      } finally {
        if (this.traceJob === job) this.traceJob = null;
        if (this.visible && !this.closed && job.generation !== this.streamGeneration) this.pollTrace(cx);
      }
    });
  }

  pollQuotas(cx, refresh = false) {
    if (!this.visible || this.closed || this.quotaJob || this.port === null || this.configError) return;
    const job = { generation: this.streamGeneration, port: this.port };
    this.quotaJob = job;
    this.quotaBusy = true;
    this.lastQuota = Date.now();
    if (refresh) { this.quotaError = null; cx.notify(); }
    cx.spawn(async cx => {
      try {
        const report = await readQuotas(job.port, refresh);
        if (job.generation !== this.streamGeneration || !this.visible || this.closed) return;
        this.quotas = report.cards;
        this.quotasUpdated = report.updatedAt;
        this.quotaError = null;
      } catch (error) {
        if (job.generation !== this.streamGeneration || !this.visible || this.closed) return;
        this.quotaError = { key: "system.quotaFailed", values: { error: failure(error) } };
      } finally {
        if (this.quotaJob === job) {
          this.quotaJob = null;
          this.quotaBusy = false;
        }
        if (this.visible && !this.closed) {
          if (job.generation !== this.streamGeneration) this.pollQuotas(cx);
          cx.notify();
        }
      }
    });
  }

  refresh(cx) {
    if (!this.visible || this.closed) return;
    this.streamGeneration++;
    this.port = null;
    this.trace = emptyTrace();
    this.quotas = [];
    this.quotasUpdated = null;
    this.quotaError = null;
    this.error = null;
    this.connection = "connecting";
    this.streamEnabled = true;
    this.resetBinding();
    this.reason = this.target?.reason ?? null;
    this.loadPort(cx);
    this.resolve(cx);
    cx.notify();
  }

  refreshQuotas(cx) { this.pollQuotas(cx, true); }

  routes() {
    return filterRoutes(this.trace, { scope: this.scope, session: this.session, adaptiveOnly: this.adaptiveOnly });
  }

  selectRoute(id, cx) {
    this.selectedId = this.selectedId === id ? null : id;
    cx.notify();
  }
  // Reset pages when their filter changes; global history survives tab focus changes.
  resetRecent() {
    this.recentExpanded = false;
    this.recentPage = 0;
    this.recentPageCount = 1;
  }

  setRecentPageCount(count) {
    this.recentPageCount = Math.max(1, count);
    this.recentPage = Math.min(this.recentPage, this.recentPageCount - 1);
  }

  toggleRecent(cx) {
    this.recentExpanded = !this.recentExpanded;
    this.recentPage = 0;
    this.selectedId = null;
    cx.notify();
  }

  setRecentPage(page, cx) {
    const next = Math.max(0, Math.min(Math.trunc(page), this.recentPageCount - 1));
    if (next === this.recentPage) return;
    this.recentPage = next;
    this.selectedId = null;
    cx.notify();
  }


  setScope(scope, cx) {
    if (scope !== "session" && scope !== "all") return;
    this.scope = scope;
    this.selectedId = null;
    this.resetRecent();
    cx.notify();
  }

  toggleAdaptive(cx) {
    this.adaptiveOnly = !this.adaptiveOnly;
    localStorage.setItem("adaptive-only", String(this.adaptiveOnly));
    this.selectedId = null;
    this.resetRecent();
    cx.notify();
  }

  toggleMasked(cx) {
    this.masked = !this.masked;
    localStorage.setItem("masked", String(this.masked));
    cx.notify();
  }

  toggleMotion(cx) {
    this.motion = !this.motion;
    localStorage.setItem("motion", String(this.motion));
    cx.notify();
  }

  toggleLocale(cx) {
    this.i18n = createI18n(this.locale === "en" ? "zh-CN" : "en");
    this.locale = this.i18n.locale;
    localStorage.setItem("locale", this.locale);
    cx.notify();
  }

  render(cx) {
    this.sync(cx);
    return renderRouting(this, cx);
  }

  close() {
    this.closed = true;
    this.hide();
    this.configGeneration++;
  }
}
