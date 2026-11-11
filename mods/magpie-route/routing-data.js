import { messageError } from "./i18n.js";

// Gateway schema: github.com/yetone/magpie/internal/gateway/{trace,session_route}.go.
// Keep only sidebar fields: full trace snapshots also contain private prompt metadata.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string" ? value : "";
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const list = value => Array.isArray(value) ? value : [];
const strings = value => list(value).filter(item => typeof item === "string");
function endpoint(port, path) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw messageError("system.invalidPort");
  return `http://127.0.0.1:${port}/v1/magpie/${path}`;
}

async function request(port, path, method = "GET") {
  const response = await fetch(endpoint(port, path), { method });
  // Do not surface arbitrary response bodies, which may contain request metadata.
  if (!response.ok) throw messageError("system.httpError", { status: response.status });
  return response;
}

export function emptyTrace() {
  return { pid: null, seq: 0, routes: new Map(), totals: { requests: 0, rerouted: 0, errors: 0 } };
}

// routing.go:770–812. Never retain vendor links, raw errors, or key fields.
function normalizeRest(value) {
  if (!object(value)) return null;
  return {
    why: string(value.why), status: number(value.status), until: string(value.until),
    by: string(value.by), failures: number(value.failures),
    probed: value.probed === true, rate: value.rate === true,
  };
}

function normalizeRule(value) {
  if (!object(value)) return null;
  return {
    n: number(value.n), when: strings(value.when), held: value.held === true,
    waits: value.waits === true, turn: number(value.turn), tokens: number(value.tokens),
  };
}

function normalizeCandidate(value) {
  return {
    id: string(value.id), provider: string(value.provider), agent: string(value.agent),
    model: string(value.model), kind: ["account", "key", "provider"].includes(value.kind) ? value.kind : "unknown",
    name: string(value.name), who: string(value.who), plan: string(value.plan),
    rest: normalizeRest(value.rest), used: value.known === true ? number(value.used) : null,
    renews: strings(value.renews), fallback: value.fallback === true,
  };
}

function candidateFor(attempt, candidates) {
  if (typeof attempt.id !== "string" || !attempt.id) return null;
  const sameID = candidates.filter(candidate => candidate.id === attempt.id);
  if (attempt.model) {
    const exact = sameID.find(candidate => candidate.model === attempt.model);
    if (exact) return exact;
    // A model explicitly present on both sides must match; a shared seat ID alone
    // cannot identify which model was tried.
    const withoutModel = sameID.filter(candidate => !candidate.model);
    return withoutModel.length === 1 ? withoutModel[0] : null;
  }
  if (!sameID.length) return null;
  const first = sameID[0];
  return sameID.every(candidate => candidate.model === first.model && candidate.provider === first.provider)
    ? first : null;
}

// Match the official Routing client's tryOk/outcome predicates (624–630,
// 3821–3835): a failed stream can have HTTP 200; error alone can be a note.
function attemptState(value) {
  if (!value.done) return "working";
  if (value.fail === "canceled") return "canceled";
  const status = number(value.status);
  return status !== null && status < 400 && !string(value.fail) ? "done" : "failed";
}

function routeState(value, tries) {
  if (!value.done) return tries.length ? "working" : "routing";
  const status = number(value.status);
  const answered = tries.some(attempt => attempt.done && attempt.status !== null
    && attempt.status < 400 && !attempt.fail);
  if (status !== null && status < 400 && (answered || !tries.length)) return "done";
  return value.canceled === true ? "canceled" : "failed";
}

// Only classification metadata is retained, never raw classifier errors or prompts.
function normalizeClassifier(value) {
  if (!object(value)) return null;
  const score = number(value.score);
  const sure = number(value.sure);
  const ms = number(value.ms);
  return {
    by: string(value.by), intents: strings(value.intents), intent: string(value.intent),
    after: string(value.after), effort: string(value.effort),
    score: score !== null && score >= 0 && score <= 3 ? score : null,
    sure: sure !== null && sure >= 0 && sure <= 1 ? sure : null,
    ms: ms !== null && ms >= 0 ? ms : null, cached: value.cached === true,
    above: string(value.above), fallback: string(value.fallback), afterEffort: string(value.afterEffort),
    failed: Boolean(string(value.error)),
  };
}

function normalizeRoute(value) {
  const candidates = list(value.order).filter(object).map(normalizeCandidate);
  const left = list(value.left).filter(object).map(normalizeCandidate);
  const all = candidates.concat(left);
  const tries = list(value.tries).filter(object).map(attempt => {
    const candidate = candidateFor(attempt, all);
    return {
      id: string(attempt.id), model: string(attempt.model), effort: string(attempt.effort),
      served: string(attempt.served), done: attempt.done === true, status: number(attempt.status),
      ms: number(attempt.ms), ttft_ms: number(attempt.ttft), fail: string(attempt.fail),
      error: string(attempt.error), rest: normalizeRest(attempt.rest),
      state: attemptState(attempt), candidate,
    };
  });
  const current = tries.length ? tries[tries.length - 1] : null;
  const group = object(value.group)
    ? string(value.group.ref) || string(value.group.id) || string(value.group.name)
    : "";
  return {
    id: value.id, seq: value.seq, time: string(value.time), agent: string(value.agent),
    session: string(value.session), asked: string(value.model), asked_effort: string(value.effort),
    model: current?.model ?? "", effort: current?.effort ?? "", served: string(value.served),
    provider: current?.candidate?.provider || string(value.provider), group,
    done: value.done === true, status: number(value.status), error: string(value.error),
    ms: number(value.ms), ttft_ms: number(value.ttft), rule: normalizeRule(value.rule),
    classifier: normalizeClassifier(value.rule?.classified),
    tries, candidates, left, state: routeState(value, tries),
  };
}

async function traceSnapshot(port, after) {
  // The presence of wait (even wait=0) enables the server's 25-second wait.
  const response = await request(port, `trace?after=${after}`);
  const data = await response.json();
  if (!object(data) || data.object !== "trace" || !counter(data.seq) || !counter(data.pid)
    || !Array.isArray(data.routes) || !Array.isArray(data.ids) || !data.ids.every(counter)
    || !object(data.totals) || !["requests", "rerouted", "errors"].every(key => counter(data.totals[key]))
    || !data.routes.every(route => object(route) && counter(route.id) && counter(route.seq)
      && typeof route.model === "string" && typeof route.done === "boolean" && Array.isArray(route.tries))) {
    throw messageError("system.invalidTrace");
  }
  return data;
}

export async function readTrace(port, previous = emptyTrace()) {
  let data = await traceSnapshot(port, previous.seq);
  let reset = previous.pid !== null && data.pid !== previous.pid || data.seq < previous.seq;
  if (reset) data = await traceSnapshot(port, 0);
  const routes = reset ? new Map() : new Map(previous.routes);
  for (const route of data.routes) routes.set(route.id, normalizeRoute(route));
  const retained = new Set(data.ids);
  // No client-side 60-row cap: the server retains extra concurrent requests.
  // IDs are authoritative, including the server dropping an unfinished route.
  for (const id of routes.keys()) if (!retained.has(id)) routes.delete(id);
  return {
    pid: data.pid, seq: data.seq, routes,
    totals: { requests: data.totals.requests, rerouted: data.totals.rerouted, errors: data.totals.errors },
  };
}

// Usage's Input excludes reads/writes but includes input whose cache status is
// unknown. Exclude that unknown portion, as Magpie's Usage page does.
function cacheMetric(value) {
  if (!object(value) || ![value.input, value.cache_read, value.cache_write].every(counter)
    || value.cache_unknown !== undefined && !counter(value.cache_unknown)) return null;
  const cacheUnknown = value.cache_unknown ?? 0;
  if (cacheUnknown > value.input) return null;
  const total = value.input + value.cache_read + value.cache_write - cacheUnknown;
  if (!Number.isSafeInteger(total)) return null;
  return {
    input: value.input, cacheRead: value.cache_read, cacheWrite: value.cache_write,
    cacheUnknown, total, rate: total > 0 ? value.cache_read / total : null,
    samples: counter(value.calls) ? value.calls : 0,
  };
}

export async function readUsage(port) {
  const response = await request(port, "usage?period=all");
  const data = await response.json();
  const overall = cacheMetric(data);
  if (!overall || data.period !== "all" || !Array.isArray(data.models) || !counter(data.calls)) {
    throw messageError("system.invalidUsage");
  }
  const models = new Map();
  for (const model of data.models) {
    const metric = cacheMetric(model);
    if (!metric || typeof model.provider !== "string" || typeof model.model !== "string") {
      throw messageError("system.invalidUsage");
    }
    models.set(JSON.stringify([model.provider, model.model]), metric);
  }
  // Discard ledger sessions, accounts, keys, file paths, and unrelated usage data.
  return { period: "all", since: string(data.since), calls: data.calls, overall, models };
}

function accountingMetric(value) {
  if (!object(value) || !["calls", "input", "output", "cache_read", "cache_write"]
    .every(key => counter(value[key]))) throw messageError("system.invalidAccounting");
  const reasoning = value.reasoning ?? 0;
  const cacheUnknown = value.cache_unknown ?? 0;
  if (!counter(reasoning) || !counter(cacheUnknown)
    || value.unpriced !== undefined && !counter(value.unpriced)) throw messageError("system.invalidAccounting");
  const totalTokens = value.input + value.output + value.cache_read + value.cache_write;
  if (!Number.isSafeInteger(totalTokens)) throw messageError("system.invalidAccounting");
  const unpriced = value.unpriced ?? null;
  const cost = number(value.cost);
  return {
    calls: value.calls, input: value.input, output: value.output,
    cacheRead: value.cache_read, cacheWrite: value.cache_write, cacheUnknown, reasoning, totalTokens,
    cost: cost !== null && cost >= 0 && !(cost === 0 && unpriced > 0) ? cost : null, unpriced,
  };
}

function accountingAccumulator() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cacheUnknown: 0, reasoning: 0, totalTokens: 0, cost: 0, unpriced: 0, _priced: false };
}

function addAccounting(target, metric) {
  for (const key of ["calls", "input", "output", "cacheRead", "cacheWrite", "cacheUnknown", "reasoning", "totalTokens"]) {
    target[key] += metric[key];
    if (!counter(target[key])) throw messageError("system.invalidAccounting");
  }
  if (metric.cost !== null) { target.cost += metric.cost; target._priced = true; }
  target.unpriced = target.unpriced !== null && metric.unpriced !== null ? target.unpriced + metric.unpriced : null;
}

function finishAccounting(value) {
  const { _priced, ...metric } = value;
  if (!_priced || metric.cost === 0 && metric.unpriced > 0) metric.cost = null;
  return metric;
}

function accountingModels(models) {
  return [...models.values()].map(finishAccounting).sort((a, b) => b.totalTokens - a.totalTokens
    || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

export async function readAccounting(port, { scope, session = null } = {}) {
  if (!["all", "session"].includes(scope)) throw messageError("system.invalidAccounting");
  if (scope === "session" && (typeof session !== "string" || !session.trim())) {
    throw messageError("system.accountingUnbound");
  }
  // Restrict both scopes to calls through Magpie, matching the routing sidebar.
  // The unfiltered ledger also imports unrelated historical agent session files.
  const base = `usage/requests?period=all&via=through&limit=${scope === "all" ? 1 : 500}`
    + (scope === "session" ? `&q=${encodeURIComponent(session)}` : "");
  const models = new Map();
  const totals = accountingAccumulator();
  let expectedTotal = null;
  let offset = 0;
  let earliest = Infinity;
  do {
    const response = await request(port, `${base}&offset=${offset}`);
    const data = await response.json();
    if (!object(data) || data.period !== "all" || !counter(data.total) || data.offset !== offset
      || !Array.isArray(data.rows) || data.rows.length > data.total - offset) {
      throw messageError("system.invalidAccounting");
    }
    if (scope === "all") {
      if (!Array.isArray(data.by?.modelAt)) throw messageError("system.invalidAccounting");
      for (const share of data.by.modelAt) {
        if (!object(share) || typeof share.id !== "string" || !share.id.includes("/")) {
          throw messageError("system.invalidAccounting");
        }
        // A model may contain slashes; provider IDs do not.
        const slash = share.id.indexOf("/");
        const provider = share.id.slice(0, slash);
        const model = share.id.slice(slash + 1);
        const key = JSON.stringify([provider, model]);
        if (!models.has(key)) models.set(key, { ...accountingAccumulator(), provider, model });
        addAccounting(models.get(key), accountingMetric(share));
      }
      return { scope, session: null, since: "", totals: accountingMetric(data), models: accountingModels(models) };
    }
    // q is only a broad substring search. Never attribute another session's rows.
    // Offset pages are mutable: reject a changing scan instead of double-counting.
    if (expectedTotal !== null && data.total !== expectedTotal) throw messageError("system.accountingChanged");
    expectedTotal = data.total;
    if (!data.rows.length && offset < expectedTotal) throw messageError("system.invalidAccounting");
    for (const row of data.rows) {
      if (!object(row)) throw messageError("system.invalidAccounting");
      if (row.session !== session || row.rejected === true
        || !string(row.provider) && number(row.status) !== null && row.status >= 400) continue;
      const input = row.in ?? 0;
      const output = row.out ?? 0;
      const cacheRead = row.cache_read ?? 0;
      const cacheWrite = row.cache_write ?? 0;
      const cost = number(row.cost);
      const priced = row.priced === true && cost !== null && cost >= 0;
      const metric = accountingMetric({ calls: row.handed_on === true ? 0 : 1,
        input, output, cache_read: cacheRead, cache_write: cacheWrite,
        cache_unknown: row.cache_unknown === true ? input : 0, reasoning: row.reasoning ?? 0,
        cost: priced ? cost : undefined, unpriced: !priced && input + output > 0 ? 1 : 0 });
      const provider = string(row.provider);
      const model = string(row.model);
      const key = JSON.stringify([provider, model]);
      if (!models.has(key)) models.set(key, { ...accountingAccumulator(), provider, model });
      addAccounting(models.get(key), metric);
      addAccounting(totals, metric);
      const time = Date.parse(row.t);
      if (Number.isFinite(time)) earliest = Math.min(earliest, time);
    }
    offset += data.rows.length;
  } while (offset < expectedTotal);
  // No raw ledger rows, account/key fields, response IDs or file paths escape.
  return { scope, session, since: Number.isFinite(earliest) ? new Date(earliest).toISOString() : "",
    totals: finishAccounting(totals), models: accountingModels(models) };
}

function normalizeWindow(value, unavailable) {
  const balance = number(value.balance);
  const percentage = !unavailable && value.text !== true && value.unlimited !== true && balance === null;
  return {
    name: string(value.name), used: percentage ? number(value.used) : null,
    remaining: percentage ? number(value.remaining) : null, resetsAt: string(value.resetsAt),
    display: string(value.display), text: value.text === true, unlimited: value.unlimited === true,
    amount: number(value.amount), limit: number(value.limit), unit: string(value.unit), balance,
  };
}

function normalizeQuota(value) {
  const error = string(value.error);
  return {
    provider: string(value.provider), name: string(value.name),
    kind: ["subscription", "plan", "balance"].includes(value.kind) ? value.kind : "unknown",
    user: string(value.user), alias: string(value.alias), seat: string(value.seat), plan: string(value.plan),
    error, balance: string(value.balance), asOf: string(value.asOf), readAt: string(value.readAt),
    readDeferred: value.readDeferred === true,
    windows: list(value.windows).filter(object).map(window => normalizeWindow(window, error !== "")),
  };
}

export async function readQuotas(port, refresh = false) {
  if (refresh) await request(port, "quotas/refresh", "POST");
  const response = await request(port, "quotas?kept=1");
  const data = await response.json();
  if (!object(data) || data.object !== "list" || !Array.isArray(data.data) || !data.data.every(object)) {
    throw messageError("system.invalidQuota");
  }
  return { cards: data.data.map(normalizeQuota), updatedAt: new Date().toISOString() };
}

export function filterRoutes(trace, { scope, session, adaptiveOnly } = {}) {
  if (scope === "session" && (typeof session !== "string" || session.length === 0)) return [];
  return Array.from(trace.routes.values()).filter(route => {
    if (scope === "session" && route.session !== session) return false;
    if (scope !== "session" && scope !== "all") return false;
    return !adaptiveOnly || route.asked === "group/codex-adaptive"
      || route.group === "group/codex-adaptive" || route.group === "codex-adaptive";
  }).sort((a, b) => b.id - a.id);
}
