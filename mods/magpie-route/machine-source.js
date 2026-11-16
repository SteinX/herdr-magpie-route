import { appHome, exec, home, readTextFile } from "herdr";
import { messageError } from "./i18n.js";

const DEFAULT_PORT = 3425;
const EXEC_TIMEOUT = 8000;
const HELPERS = new Set(["resolve-session.py", "classifier-history.py"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length
  && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));

// Read settings on the target, and return only the port; settings may contain keys.
const REMOTE_PORT = String.raw`import json
from pathlib import Path


def load_port():
    try:
        with (Path.home() / ".config/magpie/settings.json").open("r", encoding="utf-8") as source:
            text = source.read(1024 * 1024 + 1)
    except FileNotFoundError:
        return {"ok": True, "port": 3425}
    except Exception:
        return {"ok": False, "error": "config_read"}
    try:
        if len(text) > 1024 * 1024:
            raise ValueError()
        settings = json.loads(text)
        if not isinstance(settings, dict):
            raise ValueError()
    except Exception:
        return {"ok": False, "error": "config"}
    port = settings.get("port", 3425)
    if isinstance(port, bool) or not isinstance(port, (int, float)) or not 1 <= port <= 65535 or int(port) != port:
        return {"ok": False, "error": "port"}
    return {"ok": True, "port": int(port)}


print(json.dumps(load_port(), separators=(",", ":")))
`;

// The HTTP client runs beside Magpie. Never use a proxy or follow a redirect,
// and never return an error response body or a Python exception's text.
const REMOTE_HTTP = String.raw`import json
import socket
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def request():
    try:
        if len(sys.argv) != 6:
            raise ValueError()
        port, path, method, base, seconds = sys.argv[1:]
        port = int(port)
        if not 1 <= port <= 65535 or method not in ("GET", "POST"):
            raise ValueError()
        if base not in ("/v1/magpie/", "/v1/") or seconds not in ("5", "30"):
            raise ValueError()
        if not path or path.startswith("/") or any(ord(c) <= 32 or ord(c) == 127 or c in "\\#" for c in path):
            raise ValueError()
    except Exception:
        return {"ok": False, "error": "request"}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    target = "http://127.0.0.1:%d%s%s" % (port, base, path)
    try:
        with opener.open(urllib.request.Request(target, method=method), timeout=int(seconds)) as response:
            status = response.status
            if not 200 <= status < 300:
                return {"ok": False, "error": "http", "status": status}
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                return {"ok": False, "error": "response_size"}
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return {"ok": False, "error": "http", "status": status}
    except urllib.error.URLError as error:
        return {"ok": False, "error": "timeout" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "connection"}
    except (TimeoutError, socket.timeout):
        return {"ok": False, "error": "timeout"}
    except Exception:
        return {"ok": False, "error": "connection"}
    try:
        data = json.loads(body)
        return {"ok": True, "status": status, "json": True, "data": data}
    except Exception:
        return {"ok": True, "status": status, "json": False}


result = request()
try:
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
except (ValueError, TypeError):
    print(json.dumps({"ok": True, "status": result["status"], "json": False}, separators=(",", ":")))
`;

function validPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw messageError("system.invalidPort");
  return port;
}

function invalidEnvelope() {
  return new Error("The selected machine returned an invalid transport result");
}

async function execute(machine, args, timeout) {
  let result;
  try {
    result = await exec("python3", args, { on: machine, timeout });
  } catch {
    throw new Error("Could not run Python on the selected machine");
  }
  if (!object(result) || !Number.isInteger(result.code)
    || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw invalidEnvelope();
  return result;
}

function envelope(result) {
  if (result.code !== 0) throw new Error(`Python exited on the selected machine (${result.code})`);
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw invalidEnvelope();
  }
  if (!object(data) || typeof data.ok !== "boolean") throw invalidEnvelope();
  return data;
}

function configError(code) {
  if (code === "port") return messageError("system.invalidPort");
  if (code === "config") return new Error("The Magpie settings are invalid");
  if (code === "config_read") return new Error("Could not read the Magpie settings");
  return invalidEnvelope();
}

function requestError(code) {
  if (code === "timeout") return new Error("The Magpie request timed out");
  if (code === "connection") return new Error("Could not connect to Magpie on the selected machine");
  if (code === "response_size") return new Error("The Magpie response exceeded the transport size limit");
  if (code === "request") return new Error("The Magpie request is invalid");
  return invalidEnvelope();
}

function validRequest(path, method, base) {
  if (typeof path !== "string" || !path || path.startsWith("/") || /[\u0000-\u0020\u007f\\#]/.test(path)
    || !["GET", "POST"].includes(method) || !["/v1/magpie/", "/v1/"].includes(base)) {
    throw new Error("The Magpie request is invalid");
  }
}

/** One immutable machine identity; each selection owns its independently loaded port. */
export function createMachineSource(machine = null) {
  if (machine !== null && (typeof machine !== "string" || !machine.trim())) {
    throw new Error("The selected machine is invalid");
  }
  let port = null;
  return Object.freeze({
    machine,
    get port() { return port; },

    async loadPort() {
      let next;
      if (machine === null) {
        let text;
        try {
          text = await readTextFile(home().replace(/[\\/]+$/, "") + "/.config/magpie/settings.json");
        } catch {
          throw configError("config_read");
        }
        let settings;
        try {
          settings = text === null ? {} : JSON.parse(text);
        } catch {
          throw configError("config");
        }
        if (!object(settings)) throw configError("config");
        next = Object.prototype.hasOwnProperty.call(settings, "port") ? settings.port : DEFAULT_PORT;
      } else {
        const data = envelope(await execute(machine, ["-c", REMOTE_PORT], EXEC_TIMEOUT));
        if (!data.ok) {
          if (!keys(data, ["ok", "error"]) || typeof data.error !== "string") throw invalidEnvelope();
          throw configError(data.error);
        }
        if (!keys(data, ["ok", "port"])) throw invalidEnvelope();
        next = data.port;
      }
      port = validPort(next);
      return port;
    },

    async request(path, method = "GET", base = "/v1/magpie/") {
      const requestPort = validPort(port);
      validRequest(path, method, base);
      if (machine === null) {
        let response;
        try {
          response = await fetch(`http://127.0.0.1:${requestPort}${base}${path}`, { method });
        } catch {
          throw requestError("connection");
        }
        if (!response.ok) throw messageError("system.httpError", { status: response.status });
        return { async json() {
          try { return await response.json(); } catch { throw new Error("Magpie returned invalid JSON"); }
        } };
      }
      // Refresh contacts upstream providers; cached reads should fail promptly.
      const seconds = method === "POST" && base === "/v1/magpie/" && path === "quotas/refresh" ? 30 : 5;
      const data = envelope(await execute(machine,
        ["-c", REMOTE_HTTP, String(requestPort), path, method, base, String(seconds)], seconds * 1000 + 3000));
      if (!data.ok) {
        if (data.error === "http") {
          if (!keys(data, ["ok", "error", "status"]) || !Number.isInteger(data.status)
            || data.status < 100 || data.status > 599 || data.status >= 200 && data.status < 300) throw invalidEnvelope();
          throw messageError("system.httpError", { status: data.status });
        }
        if (!keys(data, ["ok", "error"]) || typeof data.error !== "string") throw invalidEnvelope();
        throw requestError(data.error);
      }
      if (!Number.isInteger(data.status) || data.status < 200 || data.status >= 300
        || typeof data.json !== "boolean" || !keys(data, data.json
          ? ["ok", "status", "json", "data"] : ["ok", "status", "json"])) throw invalidEnvelope();
      return { async json() {
        if (!data.json) throw new Error("Magpie returned invalid JSON");
        return data.data;
      } };
    },

    async runHelper(name, args = [], timeout = EXEC_TIMEOUT) {
      if (!HELPERS.has(name) || !Array.isArray(args) || !args.every(arg => typeof arg === "string" && !arg.includes("\0"))
        || !Number.isInteger(timeout) || timeout < 1 || timeout > 600000) throw new Error("The helper request is invalid");
      const path = appHome().replace(/[\\/]+$/, "") + "/mods/magpie-route/" + name;
      let command = [path, ...args];
      if (machine !== null) {
        let source;
        try { source = await readTextFile(path); } catch { throw new Error("Could not read the installed helper"); }
        if (typeof source !== "string" || !source.trim()) throw new Error("The installed helper is unavailable");
        // Both helpers use sys.argv[1:], which is unchanged with Python's -c form.
        command = ["-c", source, ...args];
      }
      const result = await execute(machine, command, timeout);
      // A failed process may print environment details; expose only its exit code.
      return { code: result.code, stdout: result.code === 0 ? result.stdout : "", stderr: "" };
    },
  });
}
