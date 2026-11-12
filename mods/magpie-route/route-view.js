import { div } from "gpui-kit";
import { Button, Popup, Progress, ProgressTrack, ProgressIndicator, h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { renderRoutingGraph } from "./routing-graph.js";
import { brandIcon, modelIconPath, providerIconPath } from "./brand-icons.js";
import { compactCost, compactNumber } from "./usage-format.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const list = value => Array.isArray(value) ? value : [];
const scalar = value => typeof value === "string" ? value.trim()
  : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const present = (env, value, fallback = env.msg("ui.notReported")) => scalar(typeof value === "object" ? env.messageValue(value) : value) || fallback;
const routeKey = route => String(route.id);
const shortSession = value => {
  const text = scalar(value);
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
};

const shortGroup = value => scalar(value).replace(/^(?:group|auto)\//, "");
function duration(env, value) {
  if (!finite(value) || value < 0) return env.msg("ui.notReported");
  if (value < 1000) return env.msg("ui.duration.ms", { value: env.number(Math.round(value)) });
  const digits = value < 10000 ? 2 : 1;
  return env.msg("ui.duration.seconds", {
    value: env.number(value / 1000, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  });
}


function status(env, route) {
  const state = route.state;
  if (state === "canceled") return { label: env.msg("ui.status.canceled"), token: "muted" };
  if (state === "failed" || (finite(route.status) && route.status >= 400)) return { label: env.msg("ui.status.failed"), token: "blocked" };
  if (state === "done" || route.done === true) return { label: env.msg("ui.status.done"), token: "done" };
  return scalar(route.model) ? { label: env.msg("ui.status.responding"), token: "working" }
    : { label: env.msg("ui.status.routing"), token: "working" };
}

function unfinished(route) {
  return route.done !== true && !["done", "failed", "canceled"].includes(route.state);
}

function attemptState(env, attempt) {
  if (attempt.state === "canceled") return { label: env.msg("ui.status.canceled"), token: "muted" };
  if (attempt.state === "failed" || (finite(attempt.status) && attempt.status >= 400)
      || (present(env, attempt.fail, "") && !(attempt.status >= 200 && attempt.status < 300))) {
    return { label: env.msg("ui.status.failed"), token: "blocked" };
  }
  if (attempt.done === true || attempt.state === "done") {
    return { label: env.msg(attempt.status >= 200 && attempt.status < 300 ? "ui.status.success" : "ui.status.ended"), token: "done" };
  }
  return { label: env.msg("ui.status.inProgress"), token: "working" };
}

function currentCandidate(route) {
  const attempts = list(route.tries);
  return attempts.length ? attempts[attempts.length - 1].candidate : null;
}

function providerOf(route) {
  return scalar(currentCandidate(route)?.provider) || scalar(route.provider);
}

function attemptOutcome(env, route, attempt, index) {
  const state = attemptState(env, attempt);
  if (state.token !== "blocked") return state.label;
  if (index < list(route.tries).length - 1) return env.msg("ui.attempt.continued");
  return env.msg(unfinished(route) ? "ui.attempt.awaitingRoute" : "ui.attempt.finalFailure");
}

function agentOf(env, route) {
  return scalar(route.agent) || env.msg("ui.agent.unassigned");
}


function privacyValues(view, routes) {
  const values = new Set();
  const add = value => { const text = scalar(value); if (text.length > 2) values.add(text); };
  for (const card of list(view.quotas)) {
    for (const key of ["user", "alias", "seat"]) add(card[key]);
    if (scalar(card.name).toLowerCase() !== scalar(card.provider).toLowerCase()) add(card.name);
  }
  for (const route of routes) {
    for (const candidate of [...list(route.candidates), ...list(route.left), ...list(route.tries).map(attempt => attempt.candidate)]) {
      if (!candidate) continue;
      for (const key of ["who", "id"]) add(candidate[key]);
      if (scalar(candidate.name).toLowerCase() !== scalar(candidate.provider).toLowerCase()) add(candidate.name);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function safeText(env, value, fallback = env.msg("ui.notReported"), publicIdentifier = false) {
  let text = scalar(typeof value === "object" ? env.messageValue(value) : value);
  if (!text) return fallback;
  const hidden = env.msg("ui.privacy.hidden");
  const accountHidden = env.msg("ui.privacy.accountHidden");
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, () => env.msg("ui.privacy.gatewayHidden"))
    .replace(/\bBearer\s+[^\s,;]+/gi, () => `Bearer ${hidden}`)
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, () => env.msg("ui.privacy.credentialHidden"))
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[=:]\s*)[^\s,;]+/gi, (_match, prefix) => `${prefix}${hidden}`);
  if (env.masked) {
    if (!publicIdentifier) for (const identity of env.identities) text = text.split(identity).join(accountHidden);
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => accountHidden);
  }
  return text;
}

function line(env, value, color = env.t.foreground) {
  return div().min_w(0).w_full().whitespace_normal().text_color(color).child(value);
}

function clipped(env, value, color = env.t.foreground) {
  const text = present(env, value);
  return div().min_w(0).truncate().text_color(color).tooltip(text).child(text);
}

function brandedLine(env, value, path, size = 14, color = env.t.foreground) {
  return h_flex().w_full().min_w(0).items_center().gap(6)
    .when(Boolean(path), el => el.child(brandIcon(path, size)))
    .child(line(env, value, color).flex_1());
}

function dot(env, color, animate = false, key = "") {
  return div().when(Boolean(key), el => el.id(key)).size(6).flex_none().rounded(3).bg(color)
    .when(animate, el => el.loop("opacity", { from: 0.35, to: 1, period: 1400 }));
}

function badge(env, value, color = env.t.muted) {
  return div().min_w(0).max_w(150).flex_none().px(6).py(2).rounded(4).bg(env.t.raised)
    .text_size(10).text_color(color).truncate().tooltip(String(value)).child(value);
}

function button(env, key, label, callback, options = {}) {
  const id = `magpie-${key}`;
  const handle = env.view.focusHandles.get(key);
  const selected = options.selected === true;
  const disabled = options.disabled === true;
  const inset = options.kind === "segment" || options.kind === "quiet";
  return Button.new(id).track_focus(handle).tab_index(0).selected(selected).disabled(disabled)
    .min_w(0).h(options.height ?? 28).px(options.padding ?? 8).flex().items_center().justify_center().gap(5)
    .rounded(6).border(1).border_color(handle.is_focused() ? env.t.accent : inset ? env.t.chrome : env.t.border)
    .bg(selected ? env.t.raised : inset ? env.t.chrome : env.t.surface)
    .text_size(11).text_color(disabled ? env.t.muted : selected && options.kind !== "row" ? env.t.accent : env.t.foreground)
    .when(!disabled, el => el.cursor_pointer())
    .hover(el => { if (!disabled) el.bg(env.t.hover); })
    .active(el => { if (!disabled) el.bg(env.t.raised); })
    .focus(el => el.border_color(env.t.accent))
    .accessibility_label(options.accessible ?? label)
    .when(options.tooltip !== false, el => el.tooltip(options.tooltip ?? label))
    .on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); })
    .when(!options.custom, el => el.child(div().min_w(0).child(label)));
}

function section(env, title, subtitle = null, trailing = null) {
  return h_flex().w_full().min_w(0).items_center().gap(8)
    .child(v_flex().min_w(0).flex_1().gap(3)
      .child(line(env, title).font_semibold().text_size(13))
      .when(Boolean(subtitle), el => el.child(line(env, subtitle, env.t.muted).text_size(10))))
    .when(Boolean(trailing), el => el.child(trailing));
}

function field(env, label, value, prominent = false, iconPath = null) {
  return v_flex().w_full().min_w(0).flex_none().gap(4)
    .child(line(env, label, env.t.muted).text_size(10))
    .child(brandedLine(env, value, iconPath).text_size(prominent ? 13 : 12).when(prominent, el => el.font_medium()));
}

function notice(env, title, message, failure = false) {
  return v_flex().w_full().min_w(0).flex_none().p(12).gap(6).rounded(10).border(1)
    .border_color(env.t.border).bg(env.t.chrome)
    .child(line(env, title, failure ? env.t.blocked : env.t.foreground).font_medium())
    .when(Boolean(message), el => el.child(line(env, message, env.t.muted).text_size(11)));
}

function connectionState(env) {
  const { view } = env;
  if (view.configError) return { label: env.msg("ui.connection.configError"), token: "blocked" };
  if (view.bindingBusy) return { label: env.msg("ui.connection.binding"), token: "muted" };
  return {
    unbound: { label: env.msg("ui.connection.unbound"), token: "muted" },
    connecting: { label: env.msg("ui.connection.connecting"), token: "muted" },
    live: { label: env.msg("ui.connection.live"), token: "done" },
    offline: { label: env.msg("ui.connection.offline"), token: "blocked" },
  }[view.connection] ?? { label: env.msg("ui.connection.waiting"), token: "muted" };
}


function modelFilterDropdown(env, filterGroup) {
  const { view, t, msg } = env;
  const open = view.modelFilterOpen === true;
  const options = view.modelFilterOptions();
  const current = scalar(view.modelFilter) && view.modelFilter !== "all" ? view.modelFilter : "all";
  const label = filterGroup || msg("ui.filter.allModels");
  const accessible = filterGroup ? msg("ui.filter.groupAccessible", { group: filterGroup }) : msg("ui.filter.allAccessible");
  const trigger = button(env, "adaptive", label, cx => view.toggleModelFilterMenu(cx), {
    selected: Boolean(filterGroup) || open,
    padding: 8,
    accessible,
    tooltip: open ? false : accessible,
    custom: true,
  }).w_full().min_w(0).flex_1().justify_between()
    .on_key_down((event, cx) => {
      const key = event.keystroke ?? event.key;
      if (!open && (key === "down" || key === "up")) {
        cx.stop_propagation();
        view.toggleModelFilterMenu(cx);
      } else if (open && key === "escape") {
        cx.stop_propagation();
        view.closeModelFilterMenu(cx, true);
      }
    })
    .child(div().min_w(0).flex_1().truncate().child(label))
    .child(div().flex_none().text_size(10).text_color(open || filterGroup ? t.accent : t.muted).child(open ? "▴" : "▾"));
  const menuHandle = view.focusHandles.get("adaptive-menu");
  const highlightIndex = Math.max(0, Math.min(Number.isInteger(view.modelFilterIndex) ? view.modelFilterIndex : 0, Math.max(0, options.length - 1)));
  const menuWidth = Math.max(180, Math.min(320, Math.round((env.width || 340) - 28)));
  const menuHeight = Math.min(238, 8 + options.length * 28 + Math.max(0, options.length - 1) * 2 + (options.length <= 1 ? 26 : 0));
  const menu = v_flex().id("magpie-model-filter-menu").w(menuWidth)
    .track_focus(menuHandle).tab_index(0).role("list_box").accessibility_label(msg("ui.filter.menuAccessible"))
    .rounded(8).border(1).border_color(t.border).bg(t.popover ?? t.surface)
    .on_mouse_down_out((_event, cx) => view.closeModelFilterMenu(cx, false))
    .on_scroll_wheel((_event, cx) => cx.stop_propagation())
    .on_key_down((event, cx) => {
      const key = event.keystroke ?? event.key;
      if (key === "down") {
        cx.stop_propagation();
        view.moveModelFilterHighlight(1, cx);
      } else if (key === "up") {
        cx.stop_propagation();
        view.moveModelFilterHighlight(-1, cx);
      } else if (key === "enter" || key === "space" || key === " ") {
        cx.stop_propagation();
        view.selectModelFilter(options[highlightIndex] ?? "all", cx);
      } else if (key === "escape") {
        cx.stop_propagation();
        view.closeModelFilterMenu(cx, true);
      }
    })
    .child(v_flex().id("magpie-model-filter-scroll").h(menuHeight).p(4).gap(2).overflow_y_scrollbar()
    .children(options.map((option, index) => {
      const isAll = option === "all";
      const optionLabel = isAll ? msg("ui.filter.allModels") : shortGroup(option);
      const isSelected = option === current;
      const isHighlighted = index === highlightIndex;
      const optionAccessible = isAll ? msg("ui.filter.selectAllAccessible") : msg("ui.filter.selectGroupAccessible", { group: optionLabel });
      return h_flex().id(`magpie-model-filter-option-${encodeURIComponent(option)}`).w_full().min_w(0).h(28).flex_none().px(8).gap(6)
        .items_center().justify_between()
        .role("list_box_option").aria_selected(isSelected).set_position(index + 1, options.length)
        .when(isHighlighted, el => el.aria_active_descendant())
        .rounded(6).border(1).border_color(isHighlighted && menuHandle?.is_focused() ? t.accent : isSelected ? t.border : "#00000000")
        .bg(isSelected ? t.raised : isHighlighted ? t.hover : "#00000000")
        .text_size(11).text_color(isSelected ? t.accent : t.foreground)
        .cursor_pointer()
        .hover(el => el.bg(t.hover))
        .active(el => el.bg(t.raised))
        .accessibility_label(optionAccessible)
        .tooltip(isAll ? optionLabel : option)
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click((_event, cx) => {
          cx.stop_propagation();
          view.selectModelFilter(option, cx);
        })
        .child(div().min_w(0).flex_1().truncate().child(optionLabel))
        .when(isSelected, el => el.child(div().flex_none().text_size(10).text_color(t.accent).child("✓")));
    }))
    .when(options.length <= 1, el => el.child(div().w_full().min_w(0).flex_none().px(8).py(4).text_size(10).text_color(t.muted).child(msg("ui.filter.noGroups")))));
  return Popup.new("magpie-model-filter-popup", trigger).anchor("top_left").flex_1().min_w(0).flex()
    .when(open, el => el.content(menu));
}
function header(env, live) {
  const { view, t, msg } = env;
  const usagePage = view.page === "usage";
  const connection = connectionState(env);
  const connectionColor = view.connection === "live" && connection.token === "done" ? t.live : t[connection.token];
  const filterGroup = scalar(view.modelFilter) && view.modelFilter !== "all" ? shortGroup(view.modelFilter) : "";
  return v_flex().w_full().min_w(0).flex_none().px(14).py(14).gap(10).border_b(1).border_color(t.border)
    .child(h_flex().w_full().min_w(0).items_center().gap(8)
      .child(v_flex().min_w(0).flex_1().gap(4)
        .child(h_flex().items_center().gap(8)
          .child(div().font_semibold().text_size(18).child("Magpie"))
          .child(div().text_color(t.muted).text_size(10).child(msg(usagePage ? "ui.accounting.title" : "ui.routing"))))
        .child(h_flex().min_w(0).items_center().gap(5).role("status")
          .child(dot(env, connectionColor))
          .child(div().text_size(11).text_color(connectionColor).child(connection.label))
          .when(live.length > 0, el => el.child(div().text_size(11).text_color(t.muted).child(msg("ui.header.active", { count: live.length }))))))
      .child(button(env, usagePage ? "accounting-refresh" : "refresh", msg("ui.header.refresh"),
        cx => usagePage ? view.refreshAccounting(cx) : view.refresh(cx), {
          disabled: usagePage && view.accountingBusy,
          accessible: msg(usagePage ? "ui.accounting.refreshAccessible" : "ui.header.refreshAccessible"),
        })))
    .child(h_flex().w_full().min_w(0).p(3).gap(3).rounded(8).bg(t.chrome)
      .child(button(env, "page-routing", msg("ui.routing"), cx => view.setPage("routing", cx), {
        kind: "segment", selected: !usagePage, accessible: msg("ui.page.routingAccessible"),
      }).flex_1())
      .child(button(env, "page-usage", msg("ui.accounting.title"), cx => view.setPage("usage", cx), {
        kind: "segment", selected: usagePage, accessible: msg("ui.page.usageAccessible"),
      }).flex_1()))
    .child(h_flex().w_full().min_w(0).items_center().gap(7)
      .child(div().flex_none().text_size(10).text_color(t.muted).child(msg("ui.header.sourceSession")))
      .child(clipped(env, view.session ? shortSession(view.session) : msg("ui.header.unboundSession"), t.muted)
        .text_size(11).flex_1().tooltip(safeText(env, view.session, msg("ui.header.unboundSession")))))
    .child(h_flex().w_full().min_w(0).p(3).gap(3).rounded(8).bg(t.chrome)
      .child(button(env, "scope-session", msg("ui.scope.session"), cx => view.setScope("session", cx), {
        kind: "segment", selected: view.scope === "session", accessible: msg("ui.scope.sessionAccessible"),
        tooltip: msg(usagePage ? "ui.accounting.sessionTooltip" : "ui.scope.sessionTooltip"),
      }).flex_1())
      .child(button(env, "scope-all", msg(usagePage ? "ui.accounting.all" : "ui.scope.all"), cx => view.setScope("all", cx), {
        kind: "segment", selected: view.scope === "all", accessible: msg(usagePage ? "ui.accounting.allAccessible" : "ui.scope.allAccessible"),
        tooltip: msg(usagePage ? "ui.accounting.allTooltip" : "ui.scope.allTooltip"),
      }).flex_1()))
    .child(h_flex().w_full().min_w(0).items_center().gap(6)
      .when(!usagePage, el => el.child(modelFilterDropdown(env, filterGroup)))
      .when(usagePage, el => el.child(button(env, "privacy", msg(env.masked ? "ui.privacy.masked" : "ui.privacy.visible"), cx => view.toggleMasked(cx), {
        kind: "quiet", selected: env.masked, padding: 6, accessible: msg(env.masked ? "ui.privacy.maskedAccessible" : "ui.privacy.visibleAccessible"),
      }).flex_1()))
      .child(button(env, "order-toggle", msg(view.editingPanels ? "ui.order.done" : "ui.order.arrange"),
        cx => view.togglePanelEditing(cx), {
          kind: "quiet", selected: view.editingPanels, height: 24, padding: 6,
          accessible: msg(view.editingPanels ? "ui.order.doneAccessible" : "ui.order.arrangeAccessible"),
        }).flex_none())
      .child(button(env, "locale", msg("ui.locale.caption"), cx => view.toggleLocale(cx), {
        kind: "quiet", accessible: msg("ui.locale.accessible"), tooltip: msg("ui.locale.accessible"),
      }).flex_none()))
    .when(!usagePage, el => el.child(h_flex().w_full().min_w(0).items_center().gap(6)
      .child(button(env, "privacy", msg(env.masked ? "ui.privacy.masked" : "ui.privacy.visible"), cx => view.toggleMasked(cx), {
        kind: "quiet", selected: env.masked, padding: 6, accessible: msg(env.masked ? "ui.privacy.maskedAccessible" : "ui.privacy.visibleAccessible"),
      }).flex_1())
      .child(button(env, "motion", msg(view.motion ? "ui.motion.on" : "ui.motion.off"), cx => view.toggleMotion(cx), {
        kind: "quiet", selected: view.motion, padding: 6, accessible: msg(view.motion ? "ui.motion.onAccessible" : "ui.motion.offAccessible"),
        tooltip: msg("ui.motion.tooltip"),
      }).flex_1())));
}

function panelTitle(env, id) {
  return env.msg({
    cache: "ui.usage.title", routing: "ui.order.routing", active: "ui.requests.active",
    quotas: "ui.quota.title", classifier: "ui.classifier.title", recent: "ui.recent.title",
    summary: "ui.order.summary", models: "ui.accounting.models",
  }[id]);
}

function panelOrderRow(env, page, id, index, count) {
  const { view, t, msg } = env;
  const title = panelTitle(env, id);
  const drag = view.panelDrag?.page === page ? view.panelDrag : null;
  const dragging = drag?.active === true;
  const source = dragging && drag.id === id;
  const handle = view.focusHandles.get(`order-grip-${page}-${id}`);
  const grip = h_flex().id(`magpie-order-grip-${page}-${id}`).size(28).flex_none().items_center().justify_center().gap(3)
    .track_focus(handle).tab_index(0).role("button").rounded(4).border(1)
    .border_color(handle.is_focused() ? t.accent : t.chrome)
    .when(source, el => el.cursor_grabbing()).when(!source, el => el.cursor_grab())
    .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
    .accessibility_label(msg("ui.order.grip", { panel: title }))
    .when(!dragging, el => el.tooltip(msg("ui.order.grip", { panel: title })))
    .children([0, 1].map(() => v_flex().gap(3).children([0, 1, 2].map(() => div().size(3).rounded(1).bg(t.muted)))))
    .on_mouse_down("left", (event, cx) => {
      cx.stop_propagation();
      view.startPanelDrag(id, event, cx);
    })
    .on_key_down((event, cx) => {
      const key = event.keystroke ?? event.key;
      if (key === "up" || key === "down") {
        cx.stop_propagation();
        view.movePanelBy(id, key === "up" ? -1 : 1, cx);
      } else if (key === "escape") {
        cx.stop_propagation();
        view.cancelPanelDrag(cx);
      }
    });
  const arrow = (direction, delta, disabled) => h_flex().size(28).flex_none()
    .child(button(env, `order-${direction}-${page}-${id}`, delta < 0 ? "↑" : "↓",
      cx => view.movePanelBy(id, delta, cx), {
        kind: "quiet", height: 28, padding: 0, disabled,
        accessible: msg(`ui.order.${direction}`, { panel: title }),
        tooltip: dragging ? false : msg(`ui.order.${direction}`, { panel: title }),
      }).w(28))
    .on_mouse_down("left", (_event, cx) => { cx.stop_propagation(); view.cancelPanelDrag(cx); })
    .on_mouse_up("left", (_event, cx) => { cx.stop_propagation(); view.cancelPanelDrag(cx); });
  return h_flex().id(`magpie-order-row-${page}-${id}`).relative().w_full().min_w(0).h(38).flex_none()
    .items_center().gap(6).px(5).rounded(6).border(1).border_color(t.border).bg(t.chrome)
    .accessibility_label(msg("ui.order.position", { panel: title, position: index + 1, count }))
    .when(source, el => el.opacity(0.55))
    .child(grip)
    .child(div().min_w(0).flex_1().truncate().text_size(11).child(title))
    .child(arrow("up", -1, index === 0))
    .child(arrow("down", 1, index === count - 1))
    .when(dragging && drag.target === id && !source, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
      .when(drag.edge === "before", marker => marker.top(0))
      .when(drag.edge === "after", marker => marker.bottom(0))))
    .on_mouse_move((event, cx) => view.hoverPanel(id, event, cx))
    .on_mouse_up("left", (event, cx) => { cx.stop_propagation(); view.dropPanel(id, event, cx); });
}

function panelOrderEditor(env) {
  const { view, msg } = env;
  const page = view.page;
  const order = view.panelOrder(page);
  return v_flex().id(`magpie-panel-order-${page}`).w_full().min_w(0).flex_1().gap(10)
    .child(section(env, msg("ui.order.title"), null,
      h_flex().flex_none()
        .child(button(env, "order-reset", msg("ui.order.reset"), cx => view.resetPanelOrder(cx), {
          kind: "quiet", height: 24, padding: 6, accessible: msg("ui.order.resetAccessible"),
          tooltip: view.panelDrag?.active ? false : msg("ui.order.resetAccessible"),
        }))
        .on_mouse_down("left", (_event, cx) => { cx.stop_propagation(); view.cancelPanelDrag(cx); })
        .on_mouse_up("left", (_event, cx) => { cx.stop_propagation(); view.cancelPanelDrag(cx); })))
    .child(line(env, msg("ui.order.help"), env.t.muted).text_size(10))
    .child(v_flex().w_full().min_w(0).gap(5)
      .children(order.map((id, index) => panelOrderRow(env, page, id, index, order.length))))
    .on_mouse_down("left", (_event, cx) => view.cancelPanelDrag(cx))
    .on_mouse_up("left", (_event, cx) => view.finishPanelDrag(cx))
    .on_hover((hovered, cx) => { if (!hovered) view.cancelPanelDrag(cx); })
    .on_key_down((event, cx) => {
      if ((event.keystroke ?? event.key) === "escape") {
        cx.stop_propagation();
        view.cancelPanelDrag(cx);
      }
    });
}

function accountingNumber(env, value) {
  return compactNumber(value) ?? env.msg("ui.notReported");
}

function accountingPrice(env, metric) {
  const { msg } = env;
  const unpriced = finite(metric?.unpriced) && metric.unpriced >= 0 ? metric.unpriced : null;
  const unavailable = !finite(metric?.cost) || metric.cost < 0;
  return {
    value: unavailable ? msg("ui.accounting.priceUnavailable")
      : msg(metric.cost > 0 && metric.cost < 0.0001 ? "ui.accounting.usdTiny" : "ui.accounting.usd", { value: compactCost(metric.cost) }),
    note: unpriced === null ? msg("ui.accounting.priceCoverageUnknown")
      : unpriced > 0 ? msg("ui.accounting.unpriced", { count: accountingNumber(env, unpriced) }) : null,
    label: msg(!unavailable && unpriced > 0 ? "ui.accounting.partialCost" : "ui.accounting.cost"),
  };
}

function accountingTooltip(env, metric) {
  return env.msg("ui.accounting.details", {
    calls: accountingNumber(env, metric.calls), tokens: accountingNumber(env, metric.totalTokens),
    input: accountingNumber(env, metric.input), output: accountingNumber(env, metric.output),
    cacheRead: accountingNumber(env, metric.cacheRead), cacheWrite: accountingNumber(env, metric.cacheWrite),
    reasoning: accountingNumber(env, metric.reasoning), cost: accountingPrice(env, metric).value,
  });
}

function accountingMetric(env, label, value, prominent = false) {
  return v_flex().min_w(0).flex_1().gap(4)
    .child(line(env, label, env.t.muted).text_size(10))
    .child(line(env, value).text_size(prominent ? 15 : 12).when(prominent, el => el.font_medium()));
}

function accountingPair(env, leftLabel, leftValue, rightLabel, rightValue, prominent = false) {
  return h_flex().w_full().min_w(0).gap(12)
    .child(accountingMetric(env, leftLabel, leftValue, prominent))
    .child(accountingMetric(env, rightLabel, rightValue, prominent));
}

function accountingModel(env, model) {
  const { msg, t } = env;
  const price = accountingPrice(env, model);
  const modelName = safeText(env, model.model, msg("ui.model.notReported"), true);
  const providerName = safeText(env, model.provider, msg("ui.provider.notReported"), true);
  return v_flex().w_full().min_w(0).flex_none().p(12).gap(12).rounded(10).border(1).border_color(t.border).bg(t.chrome)
    .tooltip(accountingTooltip(env, model))
    .child(v_flex().w_full().min_w(0).gap(5)
      .child(brandedLine(env, modelName, modelIconPath(model.model) ?? providerIconPath(model.provider), 16).font_medium().text_size(13))
      .child(h_flex().w_full().min_w(0).gap(8)
        .child(line(env, providerName, t.muted).flex_1().text_size(11))
        .child(line(env, msg("ui.accounting.modelCalls", { count: accountingNumber(env, model.calls) }), t.muted).flex_1().text_size(11))))
    .child(accountingPair(env, msg("ui.accounting.tokens"), accountingNumber(env, model.totalTokens), price.label, price.value, true))
    .when(Boolean(price.note), el => el.child(line(env, price.note, t.muted).text_size(10)))
    .child(accountingPair(env, msg("ui.accounting.input"), accountingNumber(env, model.input), msg("ui.accounting.output"), accountingNumber(env, model.output)))
    .child(accountingPair(env, msg("ui.accounting.cacheRead"), accountingNumber(env, model.cacheRead), msg("ui.accounting.cacheWrite"), accountingNumber(env, model.cacheWrite)))
    .when(finite(model.cacheUnknown) && model.cacheUnknown > 0, el => el.child(line(env,
      msg("ui.accounting.cacheUnknown", { count: accountingNumber(env, model.cacheUnknown) }), t.muted).text_size(10)))
    .when(finite(model.reasoning) && model.reasoning > 0, el => el.child(line(env,
      msg("ui.accounting.reasoning", { count: accountingNumber(env, model.reasoning) }), t.muted).text_size(10)));
}

function accountingSummary(env, accounting) {
  const { view, msg, t } = env;
  const metric = accounting.totals;
  const price = accountingPrice(env, metric);
  return v_flex().id("magpie-panel-usage-summary").w_full().min_w(0).flex_none().gap(14)
    .child(v_flex().w_full().min_w(0).flex_none().p(12).gap(12).rounded(10).border(1).border_color(t.border).bg(t.chrome)
      .tooltip(accountingTooltip(env, metric))
      .child(accountingPair(env, msg("ui.accounting.tokens"), accountingNumber(env, metric?.totalTokens), price.label, price.value, true))
      .when(Boolean(price.note), el => el.child(line(env, price.note, t.muted).text_size(10)))
      .child(line(env, msg("ui.accounting.modelCalls", { count: accountingNumber(env, metric?.calls) }), t.muted).text_size(11))
      .when(Boolean(scalar(accounting.since)), el => el.child(line(env, msg("ui.usage.since", {
        time: safeText(env, env.date(accounting.since)),
      }), t.muted).text_size(10)))
      .when(view.accountingBusy, el => el.child(line(env, msg("ui.accounting.loading"), t.muted).text_size(10))))
    .child(line(env, msg("ui.accounting.disclaimer"), t.muted).text_size(10));
}

function accountingModels(env, accounting) {
  const { msg, t } = env;
  const models = list(accounting.models);
  return v_flex().id("magpie-panel-usage-models").w_full().min_w(0).flex_none().gap(14)
    .child(section(env, msg("ui.accounting.models"), msg("ui.accounting.tokenDefinition")))
    .child(line(env, msg("ui.accounting.units"), t.muted).text_size(10))
    .children(models.map(model => accountingModel(env, model)))
    .when(models.length === 0, el => el.child(notice(env, msg("ui.accounting.emptyTitle"), msg("ui.accounting.empty"))));
}

function accountingPage(env) {
  const { view, msg } = env;
  const page = v_flex().w_full().min_w(0).flex_none().gap(14)
    .child(section(env, msg("ui.accounting.title"), msg(view.scope === "all" ? "ui.accounting.scopeAll" : "ui.accounting.scopeSession")));
  if (view.scope === "session" && !view.session) {
    return page.child(notice(env, msg(view.bindingBusy ? "ui.notice.binding" : "ui.notice.unbound"), msg("ui.accounting.unbound")));
  }
  if (view.accountingError) {
    page.child(notice(env, msg("ui.accounting.errorTitle"), safeText(env, view.accountingError), true));
  }
  const reading = view.accounting;
  const accounting = reading?.scope === view.scope && (view.scope !== "session" || reading.session === view.session) ? reading : null;
  if (!accounting) {
    if (!view.accountingError) page.child(notice(env, msg(view.accountingBusy ? "ui.accounting.loading" : "ui.accounting.emptyTitle"),
      msg(view.accountingBusy ? "ui.accounting.loadingHelp" : "ui.accounting.empty")));
    return page;
  }
  if (accounting.totals?.calls === 0 && !list(accounting.models).length) {
    return page.child(notice(env, msg("ui.accounting.emptyTitle"), msg("ui.accounting.empty")));
  }
  return page.children(view.panelOrder("usage").map(id => id === "summary"
    ? accountingSummary(env, accounting) : accountingModels(env, accounting)));
}

function usageSummary(env) {
  const { view, msg } = env;
  const usage = view.usage;
  const metric = usage?.overall;
  const reported = finite(metric?.total) && metric.total > 0 && finite(metric?.rate)
    && metric.rate >= 0 && metric.rate <= 1;
  const panel = v_flex().w_full().min_w(0).flex_none().p(12).gap(7).rounded(10)
    .border(1).border_color(env.t.border).bg(env.t.chrome)
    .child(section(env, msg("ui.usage.title"), null,
      button(env, "usage-refresh", msg("ui.header.refresh"),
        cx => view.refreshUsage(cx), { disabled: view.usageBusy, accessible: msg("ui.usage.refreshAccessible") })))
    .child(line(env, msg("ui.usage.scope"), env.t.muted).text_size(10))
    .child(line(env, reported ? msg("ui.usage.rate", {
      value: (metric.rate * 100).toFixed(2),
    }) : msg("ui.usage.notReported"), reported ? env.t.foreground : env.t.muted).font_medium().text_size(14).tooltip(msg("ui.usage.coverage")));
  if (metric && finite(metric.cacheRead) && finite(metric.total)) {
    panel.child(line(env, msg("ui.usage.tokens", {
      read: env.number(metric.cacheRead), total: env.number(metric.total),
    }), env.t.muted).text_size(11));
    if (metric.total === 0) panel.child(line(env, msg("ui.usage.noEligibleTokens"), env.t.muted).text_size(10));
  }
  if (finite(metric?.cacheUnknown) && metric.cacheUnknown > 0) {
    panel.child(line(env, msg("ui.usage.unknownExcluded", { count: env.number(metric.cacheUnknown) }), env.t.muted).text_size(10));
  }
  if (usage) {
    panel.child(line(env, msg("ui.usage.since", {
      time: scalar(usage.since) ? safeText(env, env.date(usage.since)) : msg("ui.notReported"),
    }), env.t.muted).text_size(10));
    if (finite(usage.calls)) panel.child(line(env, msg("ui.usage.calls", { count: env.number(usage.calls) }), env.t.muted).text_size(10));
  }
  if (view.usageError) {
    panel.child(line(env, msg("ui.usage.error", { message: safeText(env, view.usageError) }), env.t.blocked).text_size(11));
  } else if (view.usageBusy && !usage) {
    panel.child(line(env, msg("ui.usage.loading"), env.t.muted).text_size(11));
  } else if (!usage) {
    panel.child(line(env, msg("ui.usage.empty"), env.t.muted).text_size(11));
  }
  return panel;
}


function accountLabel(env, candidate, index) {
  if (!candidate) return env.msg("ui.account.notReported");
  if (candidate.kind === "provider") return present(env, candidate.provider, env.msg("ui.account.providerCandidate"));
  if (env.masked) return env.msg("ui.account.masked", { index: index + 1 });
  return safeText(env, scalar(candidate.name) || scalar(candidate.who) || scalar(candidate.id), env.msg("ui.account.notReported"));
}

function restText(env, rest) {
  if (!rest || typeof rest !== "object" || typeof rest.key === "string") return safeText(env, rest, "");
  const facts = [];
  if (rest.why) facts.push(safeText(env, rest.why));
  if (finite(rest.status)) facts.push(env.msg("ui.httpStatus", { status: String(rest.status) }));
  if (scalar(rest.until)) facts.push(env.msg("ui.rest.until", { time: env.date(rest.until) }));
  if (finite(rest.failures)) facts.push(env.msg("ui.rest.failures", { count: rest.failures }));
  if (rest.rate === true) facts.push(env.msg("ui.rest.rateLimited"));
  if (rest.probed === true) facts.push(env.msg("ui.rest.probed"));
  return facts.join(env.msg("ui.separator"));
}

function candidateView(env, route, candidate, index, remaining) {
  const attempt = list(route.tries).find(value => value.candidate === candidate
    || (Boolean(scalar(candidate.id)) && value.id === candidate.id
      && (!scalar(value.model) || !scalar(candidate.model) || value.model === candidate.model)));
  const notes = [];
  if (candidate.plan) notes.push(safeText(env, candidate.plan));
  const rest = restText(env, candidate.rest);
  if (rest) notes.push(env.msg("ui.rest.note", { reason: rest }));
  if (percentage(candidate.used) !== null) notes.push(env.msg("ui.quota.used", { value: env.number(candidate.used, { maximumFractionDigits: 0 }) }));
  if (list(candidate.renews).length) notes.push(env.msg("ui.quota.reset", { time: candidate.renews.map(value => env.date(value)).join(env.msg("ui.listSeparator")) }));
  if (candidate.fallback === true) notes.push(env.msg("ui.candidate.fallback"));
  const modelIcon = modelIconPath(candidate.model);
  const providerIcon = providerIconPath(candidate.provider);
  return v_flex().w_full().min_w(0).gap(4).p(10).rounded(10).bg(env.t.chrome)
    .child(h_flex().w_full().min_w(0).items_center().gap(6)
      .child(div().text_size(10).text_color(env.t.muted).child(env.number(index + 1)))
      .when(Boolean(modelIcon), el => el.child(brandIcon(modelIcon, 14)))
      .child(clipped(env, present(env, candidate.model, env.msg("ui.model.notReported"))).text_size(12).flex_1())
      .child(badge(env, env.msg(attempt ? "ui.candidate.attempted" : remaining ? "ui.candidate.remaining" : "ui.candidate.candidate"), attempt ? env.t.accent : env.t.muted)))
    .child(brandedLine(env, present(env, candidate.provider, env.msg("ui.provider.upstreamMissing")), providerIcon, 12, env.t.muted).text_size(11))
    .child(line(env, accountLabel(env, candidate, index), env.t.muted).text_size(11))
    .when(notes.length > 0, el => el.child(line(env, notes.join(env.msg("ui.separator")), env.t.muted).text_size(11)));
}

function ruleView(env, rule) {
  const body = v_flex().w_full().min_w(0).gap(7);
  if (!rule) return body.child(line(env, env.msg("ui.rule.missing"), env.t.muted).text_size(11));
  if (rule.waits) body.child(line(env, env.msg("ui.rule.waiting"), env.t.working).text_size(11));
  if (rule.held) body.child(line(env, env.msg("ui.rule.held"), env.t.muted).text_size(11));
  if (Number.isInteger(rule.n) && rule.n > 0) body.child(line(env, env.msg("ui.rule.matched", { number: rule.n })).text_size(11));
  const conditions = list(rule.when).map(value => safeText(env, value, "")).filter(Boolean);
  if (conditions.length) body.child(field(env, env.msg("ui.rule.conditions"), conditions.join(env.msg("ui.conditionSeparator"))));
  const facts = [];
  if (finite(rule.turn)) facts.push(env.msg("ui.rule.turn", { number: rule.turn }));
  if (finite(rule.tokens)) facts.push(env.msg("ui.rule.tokens", { count: rule.tokens }));
  if (facts.length) body.child(line(env, facts.join(env.msg("ui.separator")), env.t.muted).text_size(10));
  if (!conditions.length && !(rule.n > 0) && !rule.waits && !rule.held && !facts.length) {
    body.child(line(env, env.msg("ui.rule.noMatch"), env.t.muted).text_size(11));
  }
  return body;
}

function classificationText(env, value, limit = 160) {
  const text = safeText(env, value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function classifierScore(env, value) {
  return finite(value) && value >= 0 && value <= 3
    ? env.msg("ui.classifier.scoreValue", { value: env.number(value) }) : env.msg("ui.notReported");
}


function classifierView(env, classifier) {
  const body = v_flex().w_full().min_w(0).gap(9);
  if (!classifier) return body.child(line(env, env.msg("ui.notReported"), env.t.muted).text_size(11));
  if (classifier.failed === true) body.child(line(env, env.msg("ui.classifier.failed"), env.t.blocked).text_size(11));
  const flag = value => env.msg(value === true ? "ui.classifier.yes" : value === false ? "ui.classifier.no" : "ui.notReported");
  const intents = list(classifier.intents).map(value => classificationText(env, value));
  return body
    .child(field(env, env.msg("ui.classifier.model"), classificationText(env, classifier.by), false, modelIconPath(classifier.by)))
    .child(field(env, env.msg("ui.classifier.intent"), classificationText(env, classifier.intent)))
    .child(field(env, env.msg("ui.classifier.effort"), classificationText(env, classifier.effort)))
    .child(field(env, env.msg("ui.classifier.score"), classifierScore(env, classifier.score)))
    .child(field(env, env.msg("ui.classifier.confidence"), finite(classifier.sure) && classifier.sure >= 0 && classifier.sure <= 1
      ? env.msg("ui.classifier.confidenceValue", { value: (classifier.sure * 100).toFixed(1) }) : env.msg("ui.notReported")))
    .child(field(env, env.msg("ui.classifier.latency"), duration(env, classifier.ms)))
    .child(field(env, env.msg("ui.classifier.decisionReuse"), flag(classifier.cached)))
    .child(line(env, env.msg("ui.classifier.reuseNote"), env.t.muted).text_size(10))
    .child(field(env, env.msg("ui.classifier.previousIntent"), classificationText(env, classifier.after)))
    .child(field(env, env.msg("ui.classifier.previousEffort"), classificationText(env, classifier.afterEffort)))
    .child(field(env, env.msg("ui.classifier.parentEffort"), classificationText(env, classifier.above)))
    .child(field(env, env.msg("ui.classifier.intents"), intents.length ? intents.join(env.msg("ui.listSeparator")) : env.msg("ui.notReported")))
    .child(field(env, env.msg("ui.classifier.fallbackPolicy"), classificationText(env, classifier.fallback)));
}

function classifierSection(env, routes, selected) {
  let route = selected;
  if (!route) {
    let latestTime = NaN;
    for (const candidate of routes) {
      if (!candidate.classifier) continue;
      const time = Date.parse(candidate.time);
      if (!route || (finite(time) && (!finite(latestTime) || time > latestTime))) {
        route = candidate;
        latestTime = time;
      }
    }
  }
  const classifier = route?.classifier;
  const expanded = env.view.classifierExpanded === true;
  const summary = classifier ? env.msg("ui.classifier.summary", {
    model: classificationText(env, classifier.by, 64),
    effort: classificationText(env, classifier.effort, 32),
    score: classifierScore(env, classifier.score),
  }) : env.msg("ui.notReported");
  const context = route ? env.msg(selected ? "ui.classifier.selectedContext" : "ui.classifier.latestContext", {
    id: classificationText(env, route.id, 48), time: safeText(env, env.date(route.time)),
  }) : env.msg("ui.classifier.emptyContext");
  const icon = modelIconPath(classifier?.by);
  return v_flex().w_full().min_w(0).flex_none().p(12).gap(7).rounded(10)
    .border(1).border_color(env.t.border).bg(env.t.chrome)
    .child(h_flex().w_full().min_w(0).items_center().gap(8)
      .child(v_flex().min_w(0).flex_1().gap(4)
        .child(line(env, env.msg("ui.classifier.title")).font_semibold().text_size(13))
        .child(h_flex().w_full().min_w(0).items_center().gap(5)
          .when(Boolean(icon), el => el.child(brandIcon(icon, 12)))
          .child(clipped(env, summary, env.t.muted).text_size(10).flex_1())))
      .child(button(env, "classifier-toggle", env.msg(expanded ? "ui.classifier.collapse" : "ui.classifier.expand"),
        cx => env.view.toggleClassifier(cx), {
          kind: "quiet", selected: expanded,
          accessible: env.msg(expanded ? "ui.classifier.collapseAccessible" : "ui.classifier.expandAccessible"),
        }).flex_none()))
    .child(clipped(env, context, env.t.muted).text_size(10).w_full())
    .when(expanded, el => el.child(v_flex().w_full().min_w(0).pt(9).border_t(1).border_color(env.t.border)
      .child(classifierView(env, classifier))));
}

function details(env, route) {
  const tries = list(route.tries);
  const candidates = list(route.candidates);
  const left = list(route.left);
  const metrics = [];
  if (finite(route.status) && route.status > 0) metrics.push(env.msg("ui.httpStatus", { status: String(route.status) }));
  if (finite(route.ms)) metrics.push(env.msg("ui.details.totalDuration", { duration: duration(env, route.ms) }));
  if (finite(route.ttft_ms)) metrics.push(env.msg("ui.details.firstToken", { duration: duration(env, route.ttft_ms) }));
  const panel = v_flex().w_full().min_w(0).flex_none().p(12).gap(12).rounded(10).border(1).border_color(env.t.border).bg(env.t.raised)
    .child(section(env, env.msg("ui.details.title", { id: String(route.id) }), env.date(route.time)))
    .child(h_flex().w_full().min_w(0).gap(12)
      .child(field(env, env.msg("ui.details.requestedModel"), safeText(env, route.asked)).flex_1())
      .child(field(env, env.msg("ui.details.routingGroup"), safeText(env, route.group)).flex_1()))
    .child(field(env, env.msg(route.done ? "ui.details.lastAttemptModel" : "ui.details.currentAttemptModel"),
      safeText(env, route.model, env.msg("ui.model.awaitingSelection")), true, modelIconPath(route.model)))
    .child(field(env, env.msg("ui.details.responseModel"),
      safeText(env, route.served, env.msg(route.done ? "ui.model.responseMissing" : "ui.model.awaitingResponse")), false, modelIconPath(route.served)))
    .child(h_flex().w_full().min_w(0).gap(12)
      .child(field(env, env.msg("ui.details.requestedEffort"), safeText(env, route.asked_effort)).flex_1())
      .child(field(env, env.msg("ui.details.actualEffort"), safeText(env, route.effort)).flex_1()))
    .child(field(env, env.msg("ui.details.actualUpstream"), present(env, providerOf(route)), false, providerIconPath(providerOf(route))))
    .child(line(env, route.session ? env.msg("ui.details.sourceSession", { session: shortSession(route.session) })
      : env.msg("ui.details.unassignedSession"), env.t.muted).text_size(11))
    .when(metrics.length > 0, el => el.child(line(env, metrics.join(env.msg("ui.separator")), env.t.muted).text_size(11)))
    .when(Boolean(route.error), el => el.child(notice(env, env.msg(status(env, route).token === "blocked" ? "ui.details.requestError" : "ui.details.gatewayRecord"),
      safeText(env, route.error), status(env, route).token === "blocked")))
    .child(v_flex().w_full().min_w(0).gap(7).pt(10).border_t(1).border_color(env.t.border)
      .child(section(env, env.msg("ui.details.routingRules"))).child(ruleView(env, route.rule)))
    .child(v_flex().w_full().min_w(0).gap(7).pt(10).border_t(1).border_color(env.t.border)
      .child(section(env, env.msg("ui.details.attempts", { count: tries.length })))
      .children(tries.map((attempt, index) => {
        const state = attemptState(env, attempt);
        const stateColor = state.token === "working" ? env.t.live : env.t[state.token];
        const modelIcon = modelIconPath(attempt.model);
        const facts = [attemptOutcome(env, route, attempt, index)];
        if (finite(attempt.status) && attempt.status > 0) facts.push(env.msg("ui.httpStatus", { status: String(attempt.status) }));
        if (finite(attempt.ms)) facts.push(duration(env, attempt.ms));
        if (finite(attempt.ttft_ms)) facts.push(env.msg("ui.details.firstToken", { duration: duration(env, attempt.ttft_ms) }));
        const error = present(env, attempt.fail, "") || present(env, attempt.error, "");
        return v_flex().w_full().min_w(0).gap(5).p(10).rounded(10).bg(env.t.chrome)
          .child(h_flex().w_full().min_w(0).items_center().gap(6)
            .child(dot(env, stateColor, unfinished(route) && attempt.done !== true && state.token === "working" && env.animate))
            .when(Boolean(modelIcon), el => el.child(brandIcon(modelIcon, 14)))
            .child(clipped(env, env.msg("ui.attempt.model", { index: index + 1, model: present(env, attempt.model, env.msg("ui.model.notReported")) })).text_size(12).font_medium().flex_1())
            .child(badge(env, env.msg(index > 0 ? "ui.attempt.fallback" : "ui.attempt.first"), stateColor)))
          .child(line(env, facts.join(env.msg("ui.separator")), stateColor).text_size(11))
          .child(brandedLine(env, env.msg("ui.attempt.upstreamAccount", {
            provider: present(env, attempt.candidate?.provider), account: accountLabel(env, attempt.candidate, index),
          }), providerIconPath(attempt.candidate?.provider), 12, env.t.muted).text_size(11))
          .child(line(env, env.msg("ui.attempt.effort", { effort: present(env, attempt.effort) }), env.t.muted).text_size(11))
          .when(Boolean(attempt.served), el => el.child(brandedLine(env, env.msg("ui.attempt.responseModel", { model: safeText(env, attempt.served) }),
            modelIconPath(attempt.served), 12, env.t.muted).text_size(11)))
          .when(Boolean(error), el => el.child(line(env, env.msg(index < tries.length - 1 ? "ui.attempt.continuationRecord" : "ui.attempt.record", { message: safeText(env, error) }),
            stateColor).text_size(11)))
          .when(Boolean(attempt.rest), el => el.child(line(env, env.msg("ui.attempt.restRecord", {
            reason: restText(env, attempt.rest) || env.msg("ui.attempt.noRestReason"),
          }), env.t.muted).text_size(11)));
      }))
      .when(tries.length === 0, el => el.child(line(env, env.msg("ui.attempt.none"), env.t.muted).text_size(11))));
  panel.child(v_flex().w_full().min_w(0).gap(7).pt(10).border_t(1).border_color(env.t.border)
    .child(section(env, env.msg("ui.details.candidateOrder", { count: candidates.length }), env.msg("ui.details.candidateOrderNote")))
    .children(candidates.map((candidate, index) => candidateView(env, route, candidate, index, false)))
    .when(candidates.length === 0, el => el.child(line(env, env.msg("ui.details.noCandidates"), env.t.muted).text_size(11)))
    .when(left.length > 0, el => el.child(section(env, env.msg("ui.details.remainingCandidates", { count: left.length }))))
    .children(left.map((candidate, index) => candidateView(env, route, candidate, index, true))));
  return panel;
}

function requestRow(env, route) {
  const state = status(env, route);
  const stateColor = state.token === "working" ? env.t.live : env.t[state.token];
  const modelIcon = modelIconPath(route.model);
  const provider = providerOf(route);
  const providerIcon = providerIconPath(provider);
  const selected = env.view.selectedId !== null && String(env.view.selectedId) === routeKey(route);
  const summary = env.msg("ui.request.summary", {
    model: present(env, route.model, env.msg("ui.model.awaitingRouting")), status: state.label, id: String(route.id),
  });
  const row = button(env, `route-${encodeURIComponent(routeKey(route))}`, summary,
    cx => env.view.selectRoute(route.id, cx), {
      kind: "row", selected, custom: true, height: "auto", padding: 10,
      accessible: env.msg(selected ? "ui.request.collapseAccessible" : "ui.request.expandAccessible", { summary }),
      tooltip: env.msg("ui.request.routeTooltip", {
        asked: present(env, route.asked), model: present(env, route.model, env.msg("ui.model.awaitingActual")),
        provider: present(env, provider, env.msg("ui.provider.upstreamMissing")),
      }),
    });
  // Expanded details sit outside the row's single activation target.
  return v_flex().w_full().min_w(0).flex_none().gap(7)
    .child(row.w_full().py(10).rounded(10).justify_start()
      .child(v_flex().w_full().min_w(0).gap(6)
        .child(h_flex().w_full().min_w(0).items_center().gap(7)
          .child(dot(env, stateColor, unfinished(route) && env.animate))
          .when(Boolean(modelIcon), el => el.child(brandIcon(modelIcon, 14)))
          .child(clipped(env, present(env, route.model, env.msg("ui.model.awaitingRouteSelection"))).font_medium().text_size(12).flex_1())
          .child(div().flex_none().text_size(11).text_color(stateColor).child(state.label)))
        .child(h_flex().w_full().min_w(0).items_center().gap(7)
          .child(h_flex().min_w(0).flex_1().items_center().gap(5)
            .child(clipped(env, env.msg("ui.request.requestedArrow", { model: present(env, route.asked) }), env.t.muted).text_size(11).flex_1())
            .when(Boolean(providerIcon), el => el.child(brandIcon(providerIcon, 12)))
            .child(clipped(env, present(env, provider, env.msg("ui.provider.upstreamMissing")), env.t.muted).text_size(11).flex_1()))
          .child(div().flex_none().text_size(11).text_color(env.t.muted).child(finite(route.ms) ? duration(env, route.ms) : env.msg("ui.request.id", { id: String(route.id) }))))
        .child(h_flex().w_full().min_w(0).items_center().gap(6)
          .child(clipped(env, env.view.scope === "all"
            ? env.msg("ui.request.agentSession", { agent: agentOf(env, route), session: route.session ? shortSession(route.session) : env.msg("ui.session.unassigned") })
            : env.msg("ui.request.id", { id: String(route.id) }), env.t.muted).text_size(10).flex_1())
          .child(div().flex_none().text_size(10).text_color(env.t.muted).child(env.date(route.time, true)))
          .when(list(route.tries).length > 1, el => el.child(badge(env, env.msg("ui.request.attemptCount", { count: route.tries.length }), env.t.accent))))))
    .when(selected, el => el.child(details(env, route)));
}

function requests(env, title, routes, empty) {
  return v_flex().w_full().min_w(0).flex_none().gap(7)
    .child(section(env, title, null, badge(env, env.number(routes.length))))
    .children(routes.map(route => requestRow(env, route)))
    .when(routes.length === 0, el => el.child(line(env, empty, env.t.muted).text_size(11).py(5)));
}

function recentRequests(env, recent) {
  const { view } = env;
  const pageCount = Math.max(1, Math.ceil(recent.length / 5));
  view.setRecentPageCount(pageCount);
  const expandable = recent.length > 3;
  const expanded = expandable && view.recentExpanded === true;
  const page = view.recentPage;
  const visible = expanded ? recent.slice(page * 5, page * 5 + 5) : recent.slice(0, 3);
  const trailing = h_flex().flex_none().items_center().gap(7)
    .child(badge(env, env.number(recent.length)))
    .when(expandable, el => el.child(button(env, "recent-toggle", env.msg(expanded ? "ui.recent.collapse" : "ui.recent.viewAll", { count: recent.length }),
      cx => view.toggleRecent(cx), {
        kind: "quiet", accessible: env.msg(expanded ? "ui.recent.collapseAccessible" : "ui.recent.expandAccessible", { count: recent.length }),
      })));
  const panel = v_flex().w_full().min_w(0).flex_none().gap(7)
    .child(section(env, env.msg("ui.recent.title"), null, trailing))
    .children(visible.map(route => requestRow(env, route)));
  if (recent.length === 0) {
    const filterGroup = scalar(view.modelFilter) && view.modelFilter !== "all" ? shortGroup(view.modelFilter) : "";
    const empty = list(view.routes()).length > 0 ? env.msg("ui.recent.noCompleted")
      : filterGroup ? env.msg("ui.recent.noGroup", { group: filterGroup }) : env.msg("ui.recent.empty");
    panel.child(line(env, empty, env.t.muted).text_size(11).py(5));
  }
  if (expanded) {
    panel.child(h_flex().w_full().min_w(0).items_center().gap(8).pt(3)
      .child(button(env, "recent-prev", env.msg("ui.recent.previous"), cx => view.setRecentPage(page - 1, cx), {
        disabled: page === 0, accessible: env.msg("ui.recent.previousAccessible"),
      }).flex_none())
      .child(v_flex().min_w(0).flex_1().items_center().gap(2)
        .child(div().text_size(11).text_color(env.t.foreground).child(env.msg("ui.recent.page", { page: page + 1, pages: pageCount })))
        .child(div().text_size(10).text_color(env.t.muted).child(env.msg("ui.recent.total", { count: recent.length }))))
      .child(button(env, "recent-next", env.msg("ui.recent.next"), cx => view.setRecentPage(page + 1, cx), {
        disabled: page >= pageCount - 1, accessible: env.msg("ui.recent.nextAccessible"),
      }).flex_none()));
  }
  return panel;
}

function percentage(value) {
  return finite(value) && value >= 0 && value <= 100 ? value : null;
}

function walletValue(env, value) {
  if (finite(value)) return env.number(value, { maximumFractionDigits: 4 });
  return present(env, value, "") ? safeText(env, value) : null;
}

function quotaWindow(env, windowValue, card, key) {
  const error = Boolean(present(env, card.error, ""));
  const text = windowValue.text === true ? safeText(env, windowValue.display, env.msg("ui.quota.textMissing"))
    : typeof windowValue.text === "string" || typeof windowValue.text === "object" ? safeText(env, windowValue.text, "") : "";
  const display = safeText(env, windowValue.display, "");
  const wallet = walletValue(env, windowValue.balance ?? (card.kind === "balance" ? card.balance : null));
  const unlimited = windowValue.unlimited === true;
  const used = error || unlimited || text || wallet !== null ? null : percentage(windowValue.used);
  const remaining = error || unlimited || text || wallet !== null ? null : percentage(windowValue.remaining);
  const bar = used !== null ? used : remaining !== null ? 100 - remaining : null;
  let value = error ? env.msg("ui.quota.readFailedUnknown") : unlimited ? env.msg("ui.quota.unlimited")
    : text || (wallet !== null ? env.msg("ui.quota.balance", { balance: wallet }) : "");
  if (!value) value = remaining !== null ? env.msg("ui.quota.remaining", { value: env.number(remaining, { maximumFractionDigits: 0 }) })
    : used !== null ? env.msg("ui.quota.used", { value: env.number(used, { maximumFractionDigits: 0 }) }) : display || env.msg("ui.quota.unknown");
  const color = bar !== null && bar >= 90 ? env.t.blocked : bar !== null && bar >= 70 ? env.t.working : env.t.accent;
  const block = v_flex().w_full().min_w(0).gap(5)
    .child(h_flex().w_full().min_w(0).items_center().gap(8)
      .child(line(env, present(env, windowValue.name, env.msg("ui.quota.window")), env.t.muted).text_size(11).flex_1())
      .child(line(env, value, error ? env.t.blocked : env.t.foreground).text_size(11).flex_1()));
  if (bar !== null) {
    block.child(Progress.new(`magpie-quota-${key}`).value(bar).accessibility_label(env.msg("ui.quota.progressAccessible", {
      provider: present(env, card.provider), window: present(env, windowValue.name, env.msg("ui.quota.window")),
      value: env.number(bar, { maximumFractionDigits: 0 }),
    })).w_full().child(ProgressTrack.new().w_full().h(4).rounded(2).bg(env.t.border)
        .child(ProgressIndicator.new().w(`${bar}%`).h(4).rounded(2).bg(color))));
  } else {
    block.child(div().w_full().h(4).rounded(2).bg(env.t.border));
  }
  const facts = [];
  if (scalar(windowValue.resetsAt)) facts.push(env.msg("ui.quota.reset", { time: env.date(windowValue.resetsAt) }));
  if (finite(windowValue.amount) && finite(windowValue.limit)) {
    facts.push(env.msg("ui.quota.amount", {
      amount: env.number(windowValue.amount), limit: env.number(windowValue.limit), unit: present(env, windowValue.unit, ""),
    }).trim());
  }
  if (display && display !== value && !error && !text) facts.push(display);
  if (facts.length) block.child(line(env, facts.join(env.msg("ui.separator")), env.t.muted).text_size(10));
  return block;
}

function quotaCard(env, card, index) {
  const windows = list(card.windows);
  const account = env.masked ? env.msg("ui.account.masked", { index: index + 1 })
    : safeText(env, scalar(card.alias) || scalar(card.seat) || scalar(card.user) || scalar(card.name), env.msg("ui.account.notReported"));
  const plan = safeText(env, card.plan, "");
  const readAt = scalar(card.asOf) || scalar(card.readAt);
  const wallet = walletValue(env, card.balance);
  const providerIcon = providerIconPath(card.provider);
  return v_flex().w_full().min_w(0).flex_none().p(12).gap(10).rounded(10).border(1).border_color(env.t.border).bg(env.t.chrome)
    .child(h_flex().w_full().min_w(0).items_center().gap(7)
      .when(Boolean(providerIcon), el => el.child(brandIcon(providerIcon, 14)))
      .child(clipped(env, present(env, card.provider, env.msg("ui.provider.notReported"))).text_size(12).font_medium().flex_1())
      .when(Boolean(plan), el => el.child(badge(env, plan))))
    .child(line(env, account, env.t.muted).text_size(11))
    .when(Boolean(card.error), el => el.child(line(env, env.msg("ui.quota.readFailed", { message: safeText(env, card.error) }), env.t.blocked).text_size(11)))
    .children(windows.map((windowValue, windowIndex) => quotaWindow(env, windowValue, card, `${index}-${windowIndex}`)))
    .when(windows.length === 0, el => el.child(line(env, present(env, card.error, "") ? env.msg("ui.quota.unknown")
      : card.kind === "balance" && wallet !== null ? env.msg("ui.quota.balance", { balance: wallet }) : env.msg("ui.quota.noWindows"), env.t.muted).text_size(11)))
    .when(Boolean(card.readDeferred), el => el.child(line(env, env.msg("ui.quota.deferred"), env.t.muted).text_size(10)))
    .when(Boolean(readAt), el => el.child(line(env, env.msg("ui.quota.accountReading", { time: env.date(readAt) }), env.t.muted).text_size(10)));
}

function quotas(env) {
  const { view } = env;
  const cards = list(view.quotas);
  return v_flex().w_full().min_w(0).flex_none().gap(10)
    .child(section(env, env.msg("ui.quota.title"), env.msg("ui.quota.subtitle"),
      button(env, "quota-refresh", env.msg(view.quotaBusy ? "ui.quota.reading" : "ui.quota.refresh"), cx => view.refreshQuotas(cx), {
        disabled: view.quotaBusy, accessible: env.msg("ui.quota.refreshAccessible"), tooltip: env.msg("ui.quota.refreshTooltip"),
      }).flex_none()))
    .when(Boolean(view.quotaError), el => el.child(notice(env, env.msg("ui.quota.errorTitle"), safeText(env, view.quotaError), true)))
    .children(cards.map((card, index) => quotaCard(env, card, index)))
    .when(cards.length === 0, el => el.child(line(env, env.msg(view.quotaBusy ? "ui.quota.loading" : "ui.quota.empty"), env.t.muted).text_size(11)))
    .when(Boolean(view.quotasUpdated), el => el.child(line(env, env.msg("ui.quota.cacheReading", { time: env.date(view.quotasUpdated) }), env.t.muted).text_size(10)));
}

function footer(env) {
  const totals = env.view.trace?.totals;
  const facts = [];
  if (finite(totals?.requests)) facts.push(env.msg("ui.footer.requests", { count: totals.requests }));
  if (finite(totals?.rerouted)) facts.push(env.msg("ui.footer.rerouted", { count: totals.rerouted }));
  if (finite(totals?.errors)) facts.push(env.msg("ui.footer.errors", { count: totals.errors }));
  return v_flex().w_full().min_w(0).flex_none().px(14).py(10).gap(4).border_t(1).border_color(env.t.border).bg(env.t.surface)
    .when(facts.length > 0, el => el.child(line(env, env.msg("ui.footer.global", { facts: facts.join(env.msg("ui.separator")) }), env.t.muted).text_size(10)))
    .child(line(env, env.msg("ui.footer.cache"), env.t.muted).text_size(10));
}

export function renderRouting(view, cx) {
  if (!(view.focusHandles instanceof Map)) view.focusHandles = new Map();
  const routes = list(view.routes());
  const live = routes.filter(unfinished);
  const recent = routes.filter(route => !unfinished(route));
  const selected = view.selectedId === null || view.selectedId === undefined ? null
    : routes.find(route => routeKey(route) === String(view.selectedId)) ?? null;
  const colors = theme();
  const t = {
    ...colors,
    chrome: colors.chrome ?? colors.surface,
    raised: colors.raised ?? colors.surface,
    hover: colors.hover ?? colors.raised ?? colors.surface,
    live: colors.ansi10 ?? colors.accent,
    working: colors.working ?? colors.accent,
    done: colors.done ?? colors.accent,
    blocked: colors.blocked ?? colors.foreground,
  };
  const env = { ...view.i18n, view, t, masked: view.masked !== false, cache: view.usage,
    identities: privacyValues(view, routes), width: finite(view.graphWidth) && view.graphWidth > 0 ? view.graphWidth : 420,
    animate: view.connection === "live" && view.motion === true };
  const headerNode = header(env, live);
  const usagePage = view.page === "usage";
  const content = v_flex().id(view.editingPanels ? `magpie-order-scroll-${view.page}`
    : usagePage ? "magpie-accounting-scroll" : "magpie-routing-scroll").w_full().min_w(0).min_h(0).flex_1()
    .overflow_y_scrollbar().px(14).py(14).gap(18);
  if (view.editingPanels) {
    content.child(panelOrderEditor(env));
  } else if (usagePage) {
    content.child(accountingPage(env));
  } else {
    if (view.configError || view.error) {
      content.child(notice(env, env.msg(view.configError ? "ui.notice.configUnavailable" : "ui.notice.routingReadFailed"),
        safeText(env, view.configError || view.error), true));
    }
    if (view.connection === "offline" && routes.length > 0) {
      content.child(notice(env, env.msg("ui.notice.lastObserved"), env.msg("ui.notice.offline")));
    }
    if (view.scope === "session" && !view.session) {
      content.child(notice(env, env.msg(view.bindingBusy ? "ui.notice.binding" : "ui.notice.unbound"),
        safeText(env, view.reason, env.msg("ui.notice.bindingHelp"))));
    } else if (view.connection === "connecting" && routes.length === 0) {
      content.child(notice(env, env.msg("ui.notice.connecting"), env.msg("ui.notice.awaitingRequests")));
    }
    const panels = {
      cache: () => usageSummary(env),
      routing: () => renderRoutingGraph(env, routes, selected),
      active: () => requests(env, env.msg("ui.requests.active"), live, env.msg("ui.requests.noneActive")),
      quotas: () => quotas(env),
      classifier: () => classifierSection(env, routes, selected),
      recent: () => recentRequests(env, recent),
    };
    content.children(view.panelOrder("routing").map(id => v_flex().id(`magpie-panel-routing-${id}`)
      .w_full().min_w(0).flex_none().child(panels[id]())));
  }
  const root = v_flex().id("magpie-routing").size_full().min_w(0).min_h(0).bg(t.surface)
    .text_color(t.foreground).text_size(12).line_height(1.4)
    .on_size_change((size, nextCx) => {
      if (finite(size.width) && size.width > 0 && Math.abs((view.graphWidth ?? 420) - size.width) >= 1) {
        view.graphWidth = size.width;
        nextCx.notify();
      }
    })
    .child(headerNode).child(content).when(!usagePage, el => el.child(footer(env)));
  return root;
}
