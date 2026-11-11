export const PANEL_DEFAULTS = Object.freeze({
  routing: Object.freeze(["cache", "routing", "active", "quotas", "classifier", "recent"]),
  usage: Object.freeze(["summary", "models"]),
});

/** Restore complete, independent page orders from this mod's saved preference. */
export function normalizePanelOrders(serialized) {
  let saved = serialized;
  if (typeof saved === "string") {
    try { saved = JSON.parse(saved); }
    catch { saved = null; }
  }
  const orders = {};
  for (const [page, defaults] of Object.entries(PANEL_DEFAULTS)) {
    const seen = new Set();
    const order = [];
    const source = saved && typeof saved === "object" && Array.isArray(saved[page]) ? saved[page] : [];
    for (const id of source) {
      if (defaults.includes(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    for (const id of defaults) {
      if (!seen.has(id)) order.push(id);
    }
    orders[page] = order;
  }
  return orders;
}

/** Insert relative to the target after removing the source; preserve no-op identity. */
export function movePanel(order, source, target, edge = "before") {
  if (!Array.isArray(order) || source === target || edge !== "before" && edge !== "after") return order;
  const from = order.indexOf(source);
  const targetIndex = order.indexOf(target);
  if (from < 0 || targetIndex < 0) return order;
  const to = targetIndex - (from < targetIndex ? 1 : 0) + (edge === "after" ? 1 : 0);
  if (from === to) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
