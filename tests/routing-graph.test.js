import { expect, test } from "bun:test";
import { en, zhCN } from "../mods/magpie-route/locales/graph.js";
import { element } from "./native-view.js";
const { buildRoutingGraph, renderRoutingGraph } = await import("../mods/magpie-route/routing-graph.js");

const workingRoute = (id, session, model = "shared-model", fields = {}) => ({
  id, agent: "omp", session, done: false, state: "working",
  tries: [{ provider: "provider", model, done: false, state: "working" }], ...fields,
});

const completedRoute = (id, session, model, time, fields = {}) => ({
  id, agent: "omp", session, time, done: true, state: "done",
  tries: [{ model, done: true, status: 200, state: "done" }], ...fields,
});

test("overview keeps all ongoing requests and only the newest completed route for idle sessions", () => {
  const graph = buildRoutingGraph([
    completedRoute(100, "session-a", "completed-with-active", "2026-11-25T09:04:00Z"),
    workingRoute(1, "session-a", "older-active", { time: "2026-11-25T09:00:00Z" }),
    completedRoute(101, "session-b", "older-completed", "2026-11-25T09:02:00Z"),
    completedRoute(3, "session-b", "newest-completed", "2026-11-25T09:03:00Z"),
    workingRoute(2, "session-a", "concurrent-active"),
    workingRoute(4, "session-a", "unused", { tries: [] }),
    workingRoute(5, "waiting-only", "unused", { tries: [] }),
    completedRoute(102, "waiting-only", "completed-with-waiting", "2026-11-25T09:03:00Z"),
    completedRoute(103, " session-a ", "distinct-exact-session", "2026-11-25T09:03:00Z"),
    completedRoute(104, "session-a", "distinct-exact-agent", "2026-11-25T09:03:00Z", { agent: " omp " }),
  ]);
  expect(graph.counts).toMatchObject({ routes: 7, live: 4, recent: 3, active: 2, sessions: 5 });
  expect(graph.targets.filter(target => target.observed).map(target => target.model).sort()).toEqual([
    "concurrent-active", "distinct-exact-agent", "distinct-exact-session", "newest-completed", "older-active",
  ]);
  expect(graph.targets.find(target => target.kind === "unreported").states.waiting).toBe(2);
});

test("blank sessions keep unrelated ongoing requests and one recent completed route per agent", () => {
  const graph = buildRoutingGraph([
    workingRoute(9, "", "blank-active"),
    completedRoute(10, "", "blank-completed", "2026-11-25T09:02:00Z"),
    completedRoute(11, "  ", "older-blank-completed", "2026-11-25T09:01:00Z"),
    completedRoute(12, "", "other-agent-completed", "2026-11-25T09:01:00Z", { agent: "codex" }),
  ]);
  expect(graph.counts).toMatchObject({ routes: 3, live: 1, recent: 2, sessions: 0 });
  expect(graph.targets.map(target => target.model).sort()).toEqual(["blank-active", "blank-completed", "other-agent-completed"]);
});

test("explicit pin stays on the completed, awaiting fallback, or unattempted request as live traffic arrives", () => {
  const completed = completedRoute(1, "session", "pinned-model");
  const awaiting = workingRoute(1, "session", "unused", {
    tries: [{ model: "pinned-model", done: true, state: "failed", status: 503 }],
  });
  const waiting = workingRoute(1, "session", "unused", { tries: [] });
  const otherRoute = workingRoute(2, "session", "unrelated-live-model");
  for (const [pinned, state, model] of [
    [completed, "done", "pinned-model"], [awaiting, "failed", "pinned-model"], [waiting, "waiting", ""],
  ]) {
    const graph = buildRoutingGraph([otherRoute], pinned);
    expect(graph.mode).toBe("pinned");
    expect(graph.counts).toMatchObject({ routes: 1, active: 0 });
    expect(graph.targets.map(target => [target.state, target.model])).toEqual([[state, model]]);
    expect(graph.targets[0].awaitingCount).toBe(pinned === awaiting ? 1 : 0);
    const root = renderGraph([otherRoute], undefined, en, 340, pinned);
    expect(root.nodes[1].nodes[0].props.tooltip).toContain("Pinned");
    expect(JSON.stringify(root)).not.toContain("unrelated-live-model");
  }
  expect(buildRoutingGraph([completed, otherRoute]).counts).toMatchObject({ routes: 1, active: 1 });
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

function renderGraph(routes, sessionTitles, messages = en, width = 420, pinned = null, classifier = null, controls = null) {
  const previousWindow = globalThis.window;
  globalThis.window = { paint_path: element };
  try {
    return renderRoutingGraph({
      view: { sessionTitles }, width, t: {}, number: String,
      msg(key, values = {}) {
        const message = typeof messages[key] === "object"
          ? messages[key][values.count === 1 ? "one" : "other"] : messages[key];
        return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
      },
    }, routes, pinned, classifier, controls);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const targetCards = root => descendants(root).filter(node => node.props.id?.startsWith("magpie-routing-target-"));

function renderCards(routes, sessionTitles, messages = en, width = 420) {
  return targetCards(renderGraph(routes, sessionTitles, messages, width));
}

for (const width of [340, 420]) {
  test(`graph renders at natural height without nested scrolling at panel width ${width}`, () => {
    const control = element().id("lock-request").h(28);
    const collapsed = element().h(45).child("Collapsed classifier");
    const expanded = element().h(380).child("Expanded classifier with all results");
    const title = "A long session title that stays visible inside the natural graph";
    const first = workingRoute(1, "first", "model-1");
    const titles = new Map([["first", title]]);
    const routes = [first, ...Array.from({ length: 5 }, (_, index) => workingRoute(index + 2,
      `session-${index}`, `model-${index + 2}`)), workingRoute(8, "waiting", "unused", { tries: [] })];
    const messages = { ...en, "graph.status.live": "Requests currently {responding}\nRequests still {routing}" };
    const empty = renderGraph([], undefined, messages, width, null, collapsed, control);
    const short = renderGraph([first], undefined, messages, width, null, collapsed, control);
    const titled = renderGraph([first], titles, messages, width, null, collapsed, control);
    const full = renderGraph(routes, titles, messages, width, null, expanded, control);

    for (const [root, classifier] of [[empty, collapsed], [short, collapsed], [titled, collapsed], [full, expanded]]) {
      const [heading, status, stage] = root.nodes;
      expect(heading.props).toMatchObject({ h: 28, flex_none: true });
      expect(status.props).toMatchObject({ h: 28, flex_none: true });
      expect(heading.nodes[1]).toBe(control);
      expect(stage).toBe(classifier);
      expect(descendants(root).some(node => node.props.overflow_y_scrollbar || node.props.overflow_y_scroll)).toBe(false);
    }
    expect(empty.nodes[3].nodes[0].nodes[0].replace(/\s+/g, " ")).toBe(en["graph.empty"]);
    expect(full.nodes[1].nodes[0].nodes[0]).toContain("\n");
    expect(targetCards(titled)[0].props.h).toBe(targetCards(short)[0].props.h + 17);
    expect(targetCards(titled)[0].props.tooltip).toContain(title);
    expect(targetCards(full)).toHaveLength(7);
    expect(full.nodes[3].props.h).toBeGreaterThan(288);
  });
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
