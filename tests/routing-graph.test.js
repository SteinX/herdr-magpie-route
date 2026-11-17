import { expect, mock, test } from "bun:test";
import { en, zhCN } from "../mods/magpie-route/locales/graph.js";

function element() {
  const node = { nodes: [], props: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "child") node.nodes.push(args[0]);
      else if (key === "children") node.nodes.push(...args[0]);
      else if (key === "when") { if (args[0]) args[1](proxy); }
      else node.props[key] = args.length ? args[0] : true;
      return proxy;
    };
  } });
  return proxy;
}

mock.module("gpui-kit", () => ({ View: class {}, div: element, image: element, svg: element, PathBuilder: { stroke: element } }));
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element }));
const { buildRoutingGraph, graphSelection, renderRoutingGraph } = await import("../mods/magpie-route/routing-graph.js");

const completed = {
  id: 1, agent: "omp", session: "session", done: true, state: "done",
  tries: [{ model: "model-a", done: true, status: 200, state: "done" }],
};
const active = {
  id: 2, agent: "omp", session: "session", done: false, state: "working",
  tries: [{ model: "model-b", done: false, state: "working" }],
};

test("a stale pinned route yields to other active traffic without losing selection", () => {
  const routes = [completed, active];
  expect(buildRoutingGraph(routes, completed).counts.active).toBe(0);

  const effectiveSelection = graphSelection(routes, completed);
  expect(effectiveSelection).toBeNull();
  const overview = buildRoutingGraph(routes, effectiveSelection);
  expect(overview.mode).toBe("overview");
  expect(overview.counts.active).toBe(1);
  expect(overview.targets.some(target => target.model === "model-b" && target.active)).toBe(true);

  expect(graphSelection([active], active)).toBe(active);
  expect(graphSelection([completed], completed)).toBe(completed);
});

const workingRoute = (id, session, model = "shared-model", fields = {}) => ({
  id, agent: "omp", session, done: false, state: "working",
  tries: [{ provider: "provider", model, done: false, state: "working" }], ...fields,
});

test("active model sessions deduplicate exact IDs across requests without merging distinct sessions", () => {
  const graph = buildRoutingGraph([
    workingRoute(10, "session-a"),
    workingRoute(11, "session-a", "shared-model", { agent: "other-agent" }),
    workingRoute(12, "session-b"),
    workingRoute(13, "session-a", "other-model"),
    workingRoute(14, "session-a-extra"),
    workingRoute(15, " session-a "),
    workingRoute(16, ""),
    workingRoute(17, "session-a"),
  ]);
  expect(graph.targets.find(target => target.model === "shared-model").sessionIds)
    .toEqual([" session-a ", "session-a", "session-a-extra", "session-b"]);
  expect(graph.targets.find(target => target.model === "other-model").sessionIds).toEqual(["session-a"]);
  expect(graph.targets.find(target => target.model === "shared-model").sessions
    .filter(session => session.id === "session-a")).toEqual([
    { agent: "omp", id: "session-a" }, { agent: "other-agent", id: "session-a" },
  ]);
});

test("only the current observed attempt associates a session, including an active fallback", () => {
  const fallback = workingRoute(20, "fallback-session", "unused", {
    tries: [
      { provider: "provider", model: "first-model", state: "failed", done: true, status: 503 },
      { provider: "provider", model: "fallback-model", state: "working", done: false },
    ],
    candidates: [{ provider: "provider", model: "candidate-model" }],
  });
  const graph = buildRoutingGraph([
    fallback,
    workingRoute(21, "completed-session", "fallback-model", {
      done: true, state: "done",
      tries: [{ provider: "provider", model: "fallback-model", done: true, state: "done", status: 200 }],
    }),
    workingRoute(22, "terminal-session", "terminal-model", { done: true, state: "canceled" }),
    workingRoute(23, "waiting-session", "unused", { tries: [], provider: "provider" }),
    workingRoute(24, "candidate-session", "unused", {
      tries: [], candidates: [{ provider: "provider", model: "fallback-model" }],
    }),
  ]);
  expect(graph.targets.find(target => target.model === "fallback-model").sessionIds).toEqual(["fallback-session"]);
  for (const target of graph.targets.filter(target => target.model !== "fallback-model")) {
    expect(target.sessionIds).toEqual([]);
  }
  const pinned = buildRoutingGraph([fallback], fallback);
  expect(pinned.targets.map(target => target.sessionIds)).toEqual([[], ["fallback-session"], []]);
  expect(graph.edges.every(edge => !Object.hasOwn(edge, "sessionIds"))).toBe(true);
});

function descendants(node) {
  return typeof node === "object" && node !== null ? [node, ...node.nodes.flatMap(descendants)] : [];
}

function renderCards(routes, sessionTitles, messages = en, width = 420) {
  const previousWindow = globalThis.window;
  globalThis.window = { paint_path: element };
  try {
    const root = renderRoutingGraph({
      view: { sessionTitles }, width, t: {}, number: String,
      msg(key, values = {}) {
        const message = typeof messages[key] === "object"
          ? messages[key][values.count === 1 ? "one" : "other"] : messages[key];
        return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
      },
    }, routes);
    return descendants(root).filter(node => node.props.id?.startsWith("magpie-routing-target-"));
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const sessionRows = card => card.nodes.filter(node => node?.props?.truncate);

test("model cards resolve exact session titles and retain separate rows for identical titles", () => {
  const title = "A long session title whose complete text remains available in the tooltip";
  const routes = [workingRoute(30, "exact-session"), workingRoute(31, "other-session"), workingRoute(32, "missing-session")];
  const [card] = renderCards(routes, new Map([
    ["exact-session", title], ["other-session", title], ["missing", "Must not match a prefix"],
  ]));
  const rows = sessionRows(card);
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.nodes[0])).toEqual([`Session: ${title}`, `Session: ${title}`]);
  expect(rows.map(row => row.props.tooltip)).toEqual([title, title]);
  expect(rows.every(row => row.props.h === 13 && row.props.w_full && row.props.min_w === 0)).toBe(true);
  expect(card.props.tooltip).toContain(title);
  expect(JSON.stringify(card)).not.toContain("exact-session");
  expect(JSON.stringify(card)).not.toContain("other-session");
  expect(JSON.stringify(card)).not.toContain("missing-session");
  const [oneSession] = renderCards([routes[0]], new Map([["exact-session", title]]));
  expect(card.props.h - oneSession.props.h).toBe(17);
});

test("missing and blank titles leave no session row or tooltip placeholder", () => {
  const routes = [
    workingRoute(40, "blank-title"),
    workingRoute(41, "completed-title", "finished-model", {
      done: true, state: "done",
      tries: [{ provider: "provider", model: "finished-model", state: "done", done: true, status: 200 }],
    }),
    workingRoute(42, "candidate-title", "unused", {
      tries: [], candidates: [{ provider: "provider", model: "candidate-model" }],
    }),
  ];
  const cards = renderCards(routes, new Map([["blank-title", "  "], ["completed-title", "Finished"], ["candidate-title", "Candidate"]]), zhCN);
  expect(cards.flatMap(sessionRows)).toEqual([]);
  expect(cards.every(card => !card.props.tooltip.includes("标题不可用"))).toBe(true);
  const [withoutMetadata] = renderCards([workingRoute(43, "unknown-title")], undefined);
  expect(sessionRows(withoutMetadata)).toEqual([]);
  expect(withoutMetadata.props.tooltip).not.toContain("Title unavailable");
});

test("OMP title metadata cannot label another agent's colliding session ID", () => {
  const [card] = renderCards([
    workingRoute(50, "colliding-id"),
    workingRoute(51, "colliding-id", "shared-model", { agent: "codex" }),
    workingRoute(52, "colliding-id", "shared-model", { agent: "omp-worker" }),
  ], new Map([["colliding-id", "OMP session title"]]));
  expect(sessionRows(card).map(row => row.nodes[0])).toEqual([
    "Session: OMP session title", "Session: OMP session title",
  ]);
});

test("session titles apply the graph's default sensitive-text masking", () => {
  const [card] = renderCards([workingRoute(60, "private-title")], new Map([
    ["private-title", "Discuss account user@example.com"],
  ]));
  expect(sessionRows(card).map(row => row.nodes[0])).toEqual(["Session: Discuss account [Account hidden]"]);
  expect(card.props.tooltip).not.toContain("user@example.com");
});

for (const width of [340, 420]) {
  test(`rendered model cards keep session rows compact at panel width ${width}`, () => {
    const title = "为多个工作会话展示完整标题，同时保持模型请求卡片紧凑 — a deliberately long session title";
    const routes = [workingRoute(70, "first-session"), workingRoute(71, "second-session")];
    const titles = new Map([["first-session", title], ["second-session", title]]);
    const [card] = renderCards(routes, titles, en, width);
    const [withoutSessions] = renderCards(routes.map(route => ({ ...route, session: "" })), titles, en, width);
    expect(card.props.w).toBe(width === 340 ? 140 : 169);
    expect(card.props.h - withoutSessions.props.h).toBe(34);
    expect(sessionRows(card)).toHaveLength(2);
    for (const row of sessionRows(card)) {
      expect(row.props).toMatchObject({ truncate: true, w_full: true, min_w: 0, h: 13, line_height: "13px" });
      expect(row.nodes).toEqual([`Session: ${title}`]);
      expect(row.props.tooltip).toBe(title);
    }
    expect(card.props.tooltip.split(`Session: ${title}`)).toHaveLength(3);
    expect(JSON.stringify(card)).not.toContain("first-session");
    expect(JSON.stringify(card)).not.toContain("second-session");
  });
}
