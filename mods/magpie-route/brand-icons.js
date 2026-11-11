import { svg, image } from "gpui-kit";

// Official Magpie assets, copied without changing geometry or colors from:
// https://raw.githubusercontent.com/yetone/magpie/cfd49e36aeba5d4ac0e4f712807b620bafea5046/internal/gui/assets/icons/
const iconRoot = "mods/magpie-route/icons/";
const icons = {
  openai: `${iconRoot}openai.svg`,
  codex: `${iconRoot}codex-color.svg`,
  devin: `${iconRoot}devin.svg`,
  claude: `${iconRoot}claude-color.svg`,
  anthropic: `${iconRoot}anthropic.svg`,
  gemini: `${iconRoot}gemini-color.svg`,
  google: `${iconRoot}google-color.svg`,
  deepseek: `${iconRoot}deepseek-color.svg`,
};

// These currentColor assets are monochrome masks; svg inherits the surrounding
// theme foreground. Colored SVGs use image to preserve their official colors.
const monochrome = new Set([icons.openai, icons.devin, icons.anthropic]);

export function modelIconPath(model) {
  if (typeof model !== "string") return null;
  const normalized = model.trim().toLowerCase();
  // Routing groups name a selection policy, not a model family.
  if (/(?:^|\/)group\//.test(normalized)) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (name.startsWith("gpt") || name.startsWith("codex") || /^o[134](?:$|[-.])/.test(name)) {
    return icons.openai;
  }
  if (name.startsWith("claude")) return icons.claude;
  if (name.startsWith("gemini") || name.startsWith("gemma")) return icons.gemini;
  if (name.startsWith("deepseek")) return icons.deepseek;
  return null;
}

export function providerIconPath(provider) {
  if (typeof provider !== "string") return null;
  const name = provider.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(icons, name) ? icons[name] : null;
}

export function brandIcon(path, size = 14) {
  return (monochrome.has(path) ? svg(path) : image(path)).size(size).flex_none();
}
