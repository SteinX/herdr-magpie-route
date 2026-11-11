import { en as uiEN, zhCN as uiZH } from "./locales/ui.js";
import { en as graphEN, zhCN as graphZH } from "./locales/graph.js";
import { en as systemEN, zhCN as systemZH } from "./locales/system.js";

export const messages = {
  en: { ...uiEN, ...graphEN, ...systemEN },
  "zh-CN": { ...uiZH, ...graphZH, ...systemZH },
};

export function normalizeLocale(value) {
  return typeof value === "string" && /^zh(?:[-_]|$)/i.test(value) ? "zh-CN" : "en";
}

// Errors carry keys until presentation, so existing notices change language too.
export function messageError(key, values = {}) {
  return Object.assign(new Error(key), { messageKey: key, messageValues: values });
}

export function createI18n(value) {
  const locale = normalizeLocale(value);
  const tag = locale === "zh-CN" ? "zh-CN" : "en-US";
  const catalog = messages[locale];

  function number(value, options) {
    return typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString(tag, options) : String(value ?? "");
  }

  function messageValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof value.key === "string") {
      return msg(value.key, value.values);
    }
    return value === null || value === undefined || typeof value === "object" ? "" : String(value);
  }

  function msg(key, values = {}) {
    let template = catalog[key] ?? messages.en[key];
    if (template && typeof template === "object") {
      template = values.count === 1 ? template.one : template.other;
    }
    if (typeof template !== "string") return key;
    return template.replace(/\{([A-Za-z]\w*)\}/g, (token, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) return token;
      return typeof values[name] === "number" ? number(values[name]) : messageValue(values[name]);
    });
  }

  function date(value, compact = false) {
    if (value === null || value === undefined || value === "") return msg("system.unavailable");
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) return msg("system.unavailable");
    return parsed.toLocaleString(tag, compact
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  return { locale, msg, messageValue, number, date };
}
