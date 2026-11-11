import { div, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { brandIcon, modelIconPath, providerIconPath } from "./brand-icons.js";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value.trim()
  : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const finite = value => typeof value === "number" && Number.isFinite(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const terminal = state => ["done", "failed", "canceled"].includes(state);
const unfinished = route => route.done !== true && !terminal(route.state);
const tuple = values => JSON.stringify(values);

function seatOf(candidate) {
  if (!candidate) return "";
  if (text(candidate.id)) return `id:${text(candidate.id)}`;
  if (text(candidate.who)) return `who:${text(candidate.who)}`;
  const name = text(candidate.name);
  return ["account", "key"].includes(candidate.kind) && name && name !== text(candidate.provider)
    ? `name:${candidate.kind}:${name}` : "";
}

function destination(provider, model, effort, candidate) {
  const seatKey = seatOf(candidate);
  return {
    identity: tuple([provider, model, seatKey, effort]),
    provider, model, effort, seatKey,
  };
}

function candidateDestination(candidate) {
  return destination(text(candidate.provider), text(candidate.model), text(candidate.effort), candidate);
}

function reportedAttemptState(attempt) {
  // Normalized state knows about failed HTTP-200 streams. error is informational.
  if (terminal(attempt.state)) return attempt.state;
  if (attempt.done === true) {
    if (attempt.fail === "canceled") return "canceled";
    return finite(attempt.status) && attempt.status < 400 && !text(attempt.fail) ? "done" : "failed";
  }
  return "working";
}

function observedState(route, attempt, index, length) {
  const state = reportedAttemptState(attempt);
  if (state !== "working") return state;
  if (index === length - 1 && unfinished(route)) return "active";
  return index === length - 1 && terminal(route.state) ? route.state : "ended";
}

function newest(a, b) {
  const aId = Number(a.route.id);
  const bId = Number(b.route.id);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId;
  const time = compare(text(b.route.time), text(a.route.time));
  if (time) return time;
  if (finite(a.route.seq) && finite(b.route.seq) && a.route.seq !== b.route.seq) return b.route.seq - a.route.seq;
  return a.index - b.index;
}

function visibleRoutes(routes, selected) {
  if (object(selected)) return [selected];
  const ordered = list(routes).filter(object).map((route, index) => ({ route, index })).sort(newest);
  const seenRequests = new Set();
  const recentSources = new Set();
  const visible = [];
  for (const { route, index } of ordered) {
    const request = route.id === null || route.id === undefined ? `index:${index}` : `id:${text(route.id)}`;
    if (seenRequests.has(request)) continue;
    seenRequests.add(request);
    if (!unfinished(route)) {
      const source = tuple([text(route.agent), text(route.session)]);
      if (recentSources.has(source)) continue;
      recentSources.add(source);
    }
    visible.push(route);
  }
  return visible;
}

function tally() {
  return { active: 0, done: 0, failed: 0, canceled: 0, ended: 0, candidate: 0, waiting: 0 };
}

function aggregate(id, fields) {
  return {
    id, ...fields, states: tally(), observed: false, active: false,
    attemptCount: 0, requestCount: 0, candidateCount: 0, fallbackCount: 0, continuedCount: 0, awaitingCount: 0,
    _requests: new Set(),
  };
}

function record(entry, observation, request) {
  entry.states[observation.state] += 1;
  if (observation.observed) {
    entry.observed = true;
    entry.attemptCount += 1;
    entry._requests.add(request);
    if (observation.fallback) entry.fallbackCount += 1;
    if (observation.continued) entry.continuedCount += 1;
    if (observation.awaiting) entry.awaitingCount += 1;
  } else if (observation.state === "candidate") {
    entry.candidateCount += 1;
  }
}

function finish(entry) {
  entry.active = entry.states.active > 0;
  entry.state = ["active", "done", "failed", "canceled", "ended", "waiting", "candidate"]
    .find(state => entry.states[state] > 0) || "waiting";
  entry.requestCount = entry._requests.size;
  delete entry._requests;
  return entry;
}

/**
 * Pure, scope-preserving projection of the caller's filtered routes.
 * Actual identities use ONLY tries[i].model, provider, reported seat and effort.
 * Candidate models never fill missing actual models; only subsequent tries prove fallback.
 * Pinned targets retain every chronological attempt, including repeated identities.
 */
export function buildRoutingGraph(routes, selected = null) {
  const pinned = object(selected);
  const staged = visibleRoutes(routes, selected);
  const sourceMap = new Map();
  const targetMap = new Map();
  const edgeMap = new Map();
  const pendingCandidates = [];
  const sessions = new Set();
  let attemptCount = 0;
  let fallbackCount = 0;
  let missingModels = 0;
  let liveCount = 0;
  let activeCount = 0;

  staged.forEach((route, routeIndex) => {
    const agent = text(route.agent);
    const sourceId = `source:${tuple([agent])}`;
    let source = sourceMap.get(sourceId);
    if (!source) {
      source = { id: sourceId, agent, requested: [], requestCount: 0, sessionCount: 0,
        liveCount: 0, active: false, _sessions: new Set(), _requested: new Set() };
      sourceMap.set(sourceId, source);
    }
    source.requestCount += 1;
    const session = text(route.session);
    if (session) {
      source._sessions.add(session);
      sessions.add(tuple([agent, session]));
    }
    const requested = text(route.asked) || text(route.group);
    if (requested) source._requested.add(requested);
    if (unfinished(route)) {
      source.liveCount += 1;
      source.active = true;
      liveCount += 1;
    }

    const request = `${routeIndex}`;
    const attempts = list(route.tries).filter(object);
    const triedCandidates = new Set();
    const add = (targetId, fields, observation) => {
      let target = targetMap.get(targetId);
      if (!target) {
        target = aggregate(targetId, fields);
        targetMap.set(targetId, target);
      }
      record(target, observation, request);
      const edgeId = tuple([sourceId, targetId]);
      let edge = edgeMap.get(edgeId);
      if (!edge) {
        edge = aggregate(edgeId, { source: sourceId, target: targetId });
        edgeMap.set(edgeId, edge);
      }
      record(edge, observation, request);
    };

    attempts.forEach((attempt, index) => {
      const candidate = object(attempt.candidate) ? attempt.candidate : null;
      if (candidate) triedCandidates.add(candidateDestination(candidate).identity);
      const provider = text(candidate?.provider) || text(attempt.provider)
        || (index === attempts.length - 1 ? text(route.provider) : "");
      const actual = destination(provider, text(attempt.model), text(attempt.effort), candidate);
      const state = observedState(route, attempt, index, attempts.length);
      const observation = { state, observed: true, fallback: index > 0, continued: index < attempts.length - 1,
        awaiting: state === "failed" && index === attempts.length - 1 && unfinished(route) };
      const targetId = pinned ? `attempt:${index}` : `target:${actual.identity}`;
      add(targetId, { ...actual, kind: "attempt", attempt: pinned ? index + 1 : null,
        continued: pinned && observation.continued, fallback: pinned && observation.fallback }, observation);
      attemptCount += 1;
      if (observation.fallback) fallbackCount += 1;
      if (!actual.model) missingModels += 1;
      if (state === "active") activeCount += 1;
    });

    // An unreported route is real missing data, never an invented routed model.
    if (!attempts.length) {
      const unknown = destination(text(route.provider), "", "", null);
      add(pinned ? "unreported" : `unreported:${unknown.identity}`,
        { ...unknown, kind: "unreported", attempt: null, continued: false, fallback: false },
        { state: "waiting", observed: false, fallback: false, continued: false });
    }

    const candidates = new Set();
    for (const candidate of [...list(route.candidates), ...list(route.left)]) {
      if (!object(candidate)) continue;
      const proposed = candidateDestination(candidate);
      if (candidates.has(proposed.identity) || triedCandidates.has(proposed.identity)) continue;
      candidates.add(proposed.identity);
      pendingCandidates.push({ proposed, add });
    }
  });

  // Candidate effort can be unreported even when observed attempts have an
  // effort. Resolve after all attempts so polling order cannot create a second,
  // falsely idle model; candidate edges still carry their own idle state.
  const observedByModel = new Map();
  if (!pinned) {
    for (const target of targetMap.values()) {
      if (!target.observed || !target.model) continue;
      const key = tuple([target.provider, target.model, target.seatKey]);
      if (!observedByModel.has(key)) observedByModel.set(key, []);
      observedByModel.get(key).push(target);
    }
  }
  for (const { proposed, add } of pendingCandidates) {
    const key = tuple([proposed.provider, proposed.model, proposed.seatKey]);
    const matches = pinned || !proposed.model ? [] : (observedByModel.get(key) || [])
      .filter(target => !proposed.effort || target.effort === proposed.effort);
    const fields = { ...proposed, kind: "candidate", attempt: null, continued: false, fallback: false };
    const observation = { state: "candidate", observed: false, fallback: false, continued: false };
    if (matches.length) {
      for (const target of matches) add(target.id, fields, observation);
    } else {
      const targetId = `target:${proposed.identity}`;
      // An unknown candidate model cannot identify an unknown actual model.
      add(targetMap.get(targetId)?.observed ? `candidate:${proposed.identity}` : targetId, fields, observation);
    }
  }

  const sources = [...sourceMap.values()].sort((a, b) => compare(a.agent, b.agent)).map(source => {
    source.sessionCount = source._sessions.size;
    source.requested = [...source._requested].sort(compare);
    delete source._sessions;
    delete source._requested;
    return source;
  });
  const targets = [...targetMap.values()].map(finish);
  if (!pinned) targets.sort((a, b) => compare(a.provider, b.provider) || compare(a.model, b.model)
    || compare(a.seatKey, b.seatKey) || compare(a.effort, b.effort) || compare(a.id, b.id));
  for (const target of targets) {
    if (target.observed) target.kind = "attempt";
  }
  const seats = new Map();
  for (const target of targets) {
    const key = tuple([target.provider, target.model, target.effort]);
    if (!seats.has(key)) seats.set(key, new Set());
    if (target.seatKey) seats.get(key).add(target.seatKey);
  }
  for (const target of targets) {
    const variants = [...seats.get(tuple([target.provider, target.model, target.effort]))].sort(compare);
    target.seatOrdinal = variants.length > 1 && target.seatKey ? variants.indexOf(target.seatKey) + 1 : null;
  }
  const edges = [...edgeMap.values()].map(finish);
  return { mode: pinned ? "pinned" : "overview", sources, targets, edges,
    counts: { routes: staged.length, live: liveCount, recent: staged.length - liveCount,
      sources: sources.length, sessions: sessions.size, targets: targets.length,
      attempts: attemptCount, active: activeCount, fallbacks: fallbackCount, missingModels,
      candidates: targets.filter(target => target.kind === "candidate").length } };
}

function safe(env, value, fallback = env.msg("graph.unreported"), publicName = false) {
  let valueText = text(value);
  if (!valueText) return fallback;
  valueText = valueText.replace(/https?:\/\/[^\s<>"']+/gi, env.msg("graph.mask.gateway"))
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${env.msg("graph.mask.hidden")}`)
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, env.msg("graph.mask.credential"))
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[=:]\s*)[^\s,;]+/gi,
      (_, prefix) => `${prefix}${env.msg("graph.mask.hidden")}`);
  if (env.masked !== false) {
    if (!publicName) {
      for (const identity of list(env.identities)) {
        if (text(identity)) valueText = valueText.split(text(identity)).join(env.msg("graph.mask.account"));
      }
    }
    valueText = valueText.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, env.msg("graph.mask.account"));
  }
  return valueText;
}

function sourceText(env, value, fallback) {
  return safe(env, value, fallback, true).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, env.msg("graph.mask.identifier"));
}

function wrapped(value, width, fontSize) {
  const columns = Math.max(4, Math.floor(width / (fontSize * 0.6)));
  const rows = [];
  for (const paragraph of value.split("\n")) {
    const characters = [...paragraph];
    let start = 0;
    while (start < characters.length) {
      let end = start;
      let used = 0;
      let separator = -1;
      while (end < characters.length) {
        const units = characters[end].codePointAt(0) >= 0x2e80 ? 2 : 1;
        if (used + units > columns && end > start) break;
        used += units;
        if (/[\s/_.-]/.test(characters[end]) && used >= columns * 0.55) separator = end + 1;
        end += 1;
      }
      if (end < characters.length && separator > start) end = separator;
      rows.push(characters.slice(start, end).join(""));
      start = end;
    }
    if (!characters.length) rows.push("");
  }
  return { value: rows.join("\n"), lines: rows.length };
}

function colorFor(env, state) {
  if (state === "active") return env.t.ansi10 || env.t.accent;
  if (state === "failed") return env.t.blocked;
  if (state === "done") return env.t.done;
  return env.t.muted;
}

function outcome(env, target, pinned) {
  let label;
  if (target.state === "active") label = env.msg("graph.outcome.active", { count: target.states.active });
  else if (target.state === "done") label = env.msg("graph.outcome.done");
  else if (target.state === "failed") label = env.msg(target.continuedCount > 0 ? "graph.outcome.failedContinued"
    : target.awaitingCount > 0 ? "graph.outcome.failedWaiting" : "graph.outcome.failedFinal");
  else if (target.state === "canceled") label = env.msg("graph.outcome.canceled");
  else if (target.state === "ended") label = env.msg(target.continuedCount > 0 ? "graph.outcome.endedContinued" : "graph.outcome.ended");
  else if (target.state === "candidate") label = env.msg("graph.outcome.candidate");
  else label = env.msg("graph.outcome.waiting");
  if (pinned && target.attempt) return env.msg("graph.outcome.attempt", { attempt: env.number(target.attempt), status: label });
  if (target.state === "active" && target.states.failed) {
    return env.msg("graph.outcome.previousFailures", { status: label, count: target.states.failed });
  }
  if (target.fallbackCount > 0) return env.msg("graph.outcome.fallbacks", { status: label, count: target.fallbackCount });
  return target.observed && target.requestCount > 1 ? env.msg("graph.outcome.requests", {
    status: label, requests: env.msg("graph.source.requests", { count: target.requestCount }),
  }) : label;
}

function summary(env, target) {
  return ["active", "done", "failed", "canceled", "ended"].filter(state => target.states[state])
    .map(state => env.msg(`graph.summary.${state}`, { count: target.states[state] })).join(" · ");
}

function sourcePresentation(env, source, width) {
  const agent = sourceText(env, source.agent, env.msg("graph.source.unassigned"));
  const omp = /^omp(?:\b|[-_])/i.test(text(source.agent));
  const hints = source.requested.map(value => sourceText(env, value, env.msg("graph.source.groupUnreported")));
  const requested = hints.length ? hints[0].replace(/^group\//, "") : env.msg("graph.source.groupUnreported");
  const hint = hints.length > 1 ? env.msg("graph.source.additionalGroups", { group: requested, count: hints.length - 1 }) : requested;
  const counts = env.msg("graph.source.counts", {
    sessions: env.msg("graph.source.sessions", { count: source.sessionCount }),
    requests: env.msg("graph.source.requests", { count: source.requestCount }),
  });
  const title = wrapped(agent, width - (omp ? 42 : 20), 12);
  const detail = wrapped(hint, width - 20, 10);
  const state = wrapped(counts, width - 20, 10);
  return { title, detail, state, omp, height: Math.max(66, 26 + Math.max(title.lines * 15, omp ? 16 : 0) + detail.lines * 12 + state.lines * 12),
    tooltip: [agent, ...hints, counts, source.liveCount ? env.msg("graph.source.activeRequests", { count: source.liveCount })
      : env.msg("graph.source.recent")].join("\n") };
}

function targetPresentation(env, target, width, pinned) {
  const model = safe(env, target.model, env.msg("graph.unreported"), true);
  const provider = safe(env, target.provider, env.msg("graph.target.providerUnreported"), true);
  const effort = safe(env, target.effort, "");
  const modelIcon = modelIconPath(target.model);
  const providerIcon = providerIconPath(target.provider);
  const detailText = [provider, effort, target.seatOrdinal ? env.msg("graph.target.seat", { seat: env.number(target.seatOrdinal) }) : ""].filter(Boolean).join(" · ");
  const stateText = outcome(env, target, pinned);
  const metric = env.cache?.models?.get(tuple([target.provider, target.model]));
  const cacheText = env.msg("graph.target.cacheHit", {
    value: metric && finite(metric.rate)
      ? env.msg("graph.target.cacheRate", { rate: (metric.rate * 100).toFixed(2) })
      : env.msg("graph.unreported"),
  });
  const cacheTooltip = [cacheText, env.msg("graph.target.cacheScope"), metric
    ? env.msg("graph.target.cacheTokens", { read: env.number(metric.cacheRead), total: env.number(metric.total) })
    : env.msg("graph.target.cacheUnreported"),
    metric && metric.cacheUnknown > 0 ? env.msg("graph.target.cacheUnknown", { unknown: env.number(metric.cacheUnknown) }) : "",
  ].filter(Boolean).join("\n");
  const title = wrapped(model, width - 20 - (modelIcon ? 20 : 0), 12);
  const detail = wrapped(detailText, width - 20 - (providerIcon ? 17 : 0), 11);
  const state = wrapped(stateText, width - 29, 10);
  const cache = wrapped(cacheText, width - 20, 10);
  return { title, detail, state, cache, modelIcon, providerIcon,
    height: Math.max(87, 32 + title.lines * 15 + detail.lines * 14 + state.lines * 13 + cache.lines * 13),
    tooltip: [env.msg(target.kind === "candidate" ? "graph.target.candidateModel" : "graph.target.actualModel", { model }), detailText, stateText, cacheTooltip,
      target.observed ? env.msg("graph.target.observedCounts", {
        attempts: env.msg("graph.target.observedAttempts", { count: target.attemptCount }),
        requests: env.msg("graph.source.requests", { count: target.requestCount }),
      }) : "", summary(env, target)].filter(Boolean).join("\n") };
}

function label(value, color, size, height) {
  return div().w_full().min_w(0).whitespace_normal().text_color(color).text_size(size).line_height(`${height}px`).child(value);
}

function sourceNode(env, source, presentation, x, y, width, index) {
  const color = source.active ? colorFor(env, "active") : env.t.muted;
  return v_flex().id(`magpie-routing-source-${index}`).absolute().left(x).top(y).w(width).h(presentation.height)
    .min_w(0).justify_center().gap(4).px(10).py(9).rounded(10).border(1).border_color(env.t.border)
    .bg(source.active ? env.t.raised : env.t.chrome).tooltip(presentation.tooltip)
    .child(div().absolute().left(0).top(12).w(2).h(presentation.height - 24).rounded(1).bg(color))
    .child(h_flex().w_full().min_w(0).items_center().gap(6)
      .when(presentation.omp, element => element.child(image("mods/magpie-route/omp.svg").size(16).flex_none()))
      .child(label(presentation.title.value, env.t.foreground, 12, 15).font_semibold().flex_1()))
    .child(label(presentation.detail.value, env.t.muted, 10, 12))
    .child(label(presentation.state.value, env.t.muted, 10, 12));
}

function targetNode(env, target, presentation, x, y, width, index) {
  const color = colorFor(env, target.state);
  const idle = !target.observed;
  return v_flex().id(`magpie-routing-target-${index}`).absolute().left(x).top(y).w(width).h(presentation.height)
    .min_w(0).justify_center().gap(4).px(10).py(9).rounded(10).border(1).border_color(env.t.border)
    .when(idle, element => element.border_dashed()).bg(idle ? env.t.chrome : env.t.raised).tooltip(presentation.tooltip)
    .when(target.observed, element => element.child(div().absolute().left(0).top(12).w(2)
      .h(presentation.height - 24).rounded(1).bg(color)))
    .child(h_flex().w_full().min_w(0).items_center().gap(6).text_color(idle ? env.t.muted : env.t.foreground)
      .when(Boolean(presentation.modelIcon), element => element.child(brandIcon(presentation.modelIcon, 14)))
      .child(label(presentation.title.value, idle ? env.t.muted : env.t.foreground, 12, 15).font_family("monospace").font_medium().flex_1()))
    .child(h_flex().w_full().min_w(0).items_center().gap(5).text_color(env.t.muted)
      .when(Boolean(presentation.providerIcon), element => element.child(brandIcon(presentation.providerIcon, 12)))
      .child(label(presentation.detail.value, env.t.muted, 11, 14).flex_1()))
    .child(h_flex().w_full().min_w(0).items_center().gap(5)
      .child(div().size(4).flex_none().rounded(2).bg(color))
      .child(label(presentation.state.value, color, 10, 13).flex_1()))
    .child(label(presentation.cache.value, env.t.muted, 10, 13));
}

function pointOnCurve(curve, t) {
  const u = 1 - t;
  return { x: u * u * u * curve.x1 + 3 * u * u * t * curve.ax + 3 * u * t * t * curve.bx + t * t * t * curve.x2,
    y: u * u * u * curve.y1 + 3 * u * u * t * curve.y1 + 3 * u * t * t * curve.y2 + t * t * t * curve.y2 };
}

function flowSlots(curve, count) {
  const samples = [{ ...pointOnCurve(curve, 0), length: 0 }];
  let length = 0;
  for (let index = 1; index <= 96; index += 1) {
    const point = pointOnCurve(curve, index / 96);
    const previous = samples[index - 1];
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    samples.push({ ...point, length });
  }
  let sampleIndex = 1;
  return Array.from({ length: count }, (_, index) => {
    const distance = length * index / (count - 1);
    while (sampleIndex < samples.length - 1 && samples[sampleIndex].length < distance) sampleIndex += 1;
    const before = samples[sampleIndex - 1];
    const after = samples[sampleIndex];
    const fraction = after.length === before.length ? 0 : (distance - before.length) / (after.length - before.length);
    return { x: before.x + (after.x - before.x) * fraction, y: before.y + (after.y - before.y) * fraction };
  });
}

function renderCache(env) {
  const owner = object(env.view) ? env.view : env;
  if (!owner._routingGraphCache) owner._routingGraphCache = { paths: new Map(), frames: null };
  return owner._routingGraphCache;
}

/**
 * Native text frames share a clock: one fixed, centered slot emits the head at a
 * time, advancing along the same cubic as its painted path, then two blank frames.
 * No JS animation timer, oscillation, or traffic on untried/completed edges.
 * Per-view cache retains only visible immutable paths/slots plus one fixed frame bank.
 */
export function renderRoutingGraph(env, routes, selected = null) {
  const graph = buildRoutingGraph(routes, selected);
  const cache = renderCache(env);
  const nextPaths = new Map();
  // Layout padding reduces the measured root; keep a 24px lane without overflowing it.
  const width = Math.max(272, Math.round((finite(env.width) ? env.width : 420) - 52));
  const sourceWidth = Math.max(108, Math.min(124, Math.floor(width * 0.29)));
  const targetWidth = Math.max(140, Math.min(210, Math.floor(width * 0.46)));
  const rightX = width - targetWidth;
  const sourceLayout = new Map();
  const targetLayout = new Map();
  let sourceY = 0;
  let targetY = 0;
  graph.sources.forEach((source, index) => {
    const presentation = sourcePresentation(env, source, sourceWidth);
    sourceLayout.set(source.id, { source, presentation, y: sourceY, index });
    sourceY += presentation.height + 10;
  });
  graph.targets.forEach((target, index) => {
    const presentation = targetPresentation(env, target, targetWidth, graph.mode === "pinned");
    targetLayout.set(target.id, { target, presentation, y: targetY, index });
    targetY += presentation.height + 10;
  });
  const height = Math.max(112, sourceY - 10, targetY - 10);
  const paths = [];
  const heads = [];
  const slotCount = 28;
  graph.edges.forEach((edge, edgeIndex) => {
    const source = sourceLayout.get(edge.source);
    const target = targetLayout.get(edge.target);
    const x1 = sourceWidth + 1;
    const x2 = rightX - 1;
    const y1 = source.y + source.presentation.height / 2;
    const y2 = target.y + target.presentation.height / 2;
    const gap = x2 - x1;
    const curve = { x1, y1, x2, y2, ax: x1 + gap * 0.48, bx: x2 - gap * 0.3 };
    const signature = tuple([x1, y1, x2, y2, edge.observed]);
    let geometry = cache.paths.get(edge.id);
    if (!geometry || geometry.signature !== signature) {
      const builder = PathBuilder.stroke(edge.observed ? 1.15 : 1).move_to(x1, y1)
        .cubic_bezier_to(x2, y2, curve.ax, y1, curve.bx, y2)
        .dash_array(edge.observed ? [1.4, 3.2] : [3, 4]);
      geometry = { signature, path: builder.build(), slots: null };
    }
    nextPaths.set(edge.id, geometry);
    const color = colorFor(env, edge.state);
    paths.push(window.paint_path(geometry.path, color).id(`magpie-routing-path-${edgeIndex}`)
      .absolute().left(0).top(0).w(width).h(height).opacity(edge.active ? 0.85 : edge.observed ? 0.5 : 0.3));
    if (edge.observed && edge.active && env.animate === true) {
      if (!geometry.slots) geometry.slots = flowSlots(curve, slotCount);
      if (!cache.frames) cache.frames = Array.from({ length: slotCount }, (_, slot) =>
        Array.from({ length: slotCount + 2 }, (_, frame) => frame === slot ? "•" : ""));
      geometry.slots.forEach((point, slot) => {
        heads.push(div().id(`magpie-routing-head-${edgeIndex}-${slot}`).absolute()
          .left(point.x - 5).top(point.y - 5).size(10).flex().items_center().justify_center()
          .text_size(11).line_height("10px").text_color(color).frames(cache.frames[slot], 45));
      });
    }
  });
  cache.paths = nextPaths;
  const diagram = div().w_full().min_w(0).h(height).flex_none().relative()
    .children(paths).children(heads)
    .children([...sourceLayout.values()].map(item => sourceNode(env, item.source, item.presentation,
      0, item.y, sourceWidth, item.index)))
    .children([...targetLayout.values()].map(item => targetNode(env, item.target, item.presentation,
      rightX, item.y, targetWidth, item.index)));
  const responding = env.msg("graph.status.responding", { count: graph.counts.active });
  const status = graph.mode === "pinned" ? env.msg("graph.status.pinned", { count: graph.counts.attempts })
    : graph.counts.live ? graph.counts.live > graph.counts.active ? env.msg("graph.status.live", {
      responding, routing: env.msg("graph.status.routing", { count: graph.counts.live - graph.counts.active }),
    }) : responding : env.msg("graph.status.recent", { count: graph.counts.routes });
  const headingText = env.msg("graph.title");
  const headingWidth = Math.min(Math.floor(width * 0.35), Math.ceil([...headingText]
    .reduce((units, character) => units + (character.codePointAt(0) >= 0x2e80 ? 2 : 1), 0) * 13 * 0.6) + 2);
  const heading = wrapped(headingText, headingWidth, 13);
  const metadata = wrapped(status, width - headingWidth - 8, 11);
  const empty = wrapped(env.msg("graph.empty"), width, 12);
  return v_flex().w_full().min_w(0).flex_none().p(12).gap(12).rounded(10)
    .border(1).border_color(env.t.border).bg(env.t.chrome)
    .child(h_flex().w_full().min_w(0).h(Math.max(heading.lines * 16, metadata.lines * 14)).flex_none()
      .items_center().justify_between().gap(8)
      .child(div().w(headingWidth).flex_none().child(label(heading.value, env.t.foreground, 13, 16).font_semibold()))
      .child(div().flex_1().min_w(0).child(label(metadata.value, env.t.muted, 11, 14))))
    .when(graph.counts.routes > 0, element => element.child(diagram))
    .when(graph.counts.routes === 0, element => element.child(div().w_full().h(48 + empty.lines * 15).flex_none().py(24)
      .child(label(empty.value, env.t.muted, 12, 15))));
}
