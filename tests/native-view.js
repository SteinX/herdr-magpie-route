import { mock } from "bun:test";

export function element() {
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
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element, Button: { new: element }, Popup: { new: element },
  Progress: { new: element }, ProgressTrack: { new: element }, ProgressIndicator: { new: element } }));
