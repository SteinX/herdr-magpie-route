# Herdr Magpie Route

A native [Herdr](https://herdr.dev) sidebar for [Magpie](https://github.com/yetone/magpie) routing, model attempts and account quotas.

[简体中文](README.zh-CN.md) · [Rebuild recipe](RECIPE.md)

![Live native routing from OMP to model branches](preview.gif)

Recorded from real gateway requests, with moving points on active paths and distinct candidate/completed states. [Full sidebar screenshot](preview.png). Session identifiers are removed.

## Features

- Follow the current local OMP session or inspect all retained gateway requests.
- See actual model destinations, effort, candidate branches and live native flow animation.
- Inspect request attempts and routing details; preview three recent requests or expand into five-request pages.
- View global account quotas, remaining capacity, reset times and cached readings.
- Distinguish model-family icons from upstream-provider icons.
- Switch between English (default) and Simplified Chinese. The choice is remembered; notices, labels and date/number formatting follow the selected language.
- Hide account identities by default and turn animation off when preferred.

## Requirements

- Herdr App, verified with **0.1.15**, with native path painting and frame animation support. This is a Herdr mod, not an npm package or browser extension.
- A running local Magpie gateway exposing the trace and quota APIs listed below. The earliest compatible Magpie release has not been established.
- For current-session binding: a local OMP process, Python 3, `hc` and `lsof`. The resolver uses Python's standard library.

macOS is the verified platform. Linux has not been validated; Windows session binding is not supported by the current Unix process/file discovery code. Global request browsing does not require successful OMP session binding.

## Install

Clone this repository, then copy the mod into your Herdr App home:

```sh
git clone https://github.com/SteinX/herdr-magpie-route.git
cd herdr-magpie-route
herdr_app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$herdr_app_home/mods"
if test -e "$herdr_app_home/mods/magpie-route"; then
  printf '%s\n' 'magpie-route already exists; back it up before updating.'
else
  cp -R mods/magpie-route "$herdr_app_home/mods/"
fi
```

Keep the folder name `magpie-route`. Add this block beside the terminal block in a horizontal row of a **personal layout**:

```json
{
  "id": "magpie-route-panel",
  "type": "block",
  "content": { "mod": "magpie-route" },
  "size": { "px": 420 },
  "min": 340,
  "max": 680,
  "padding": 6
}
```

The row should allow resizing. The node ID must remain `magpie-route-panel` because the mod uses it to suspend work while hidden. Copying files alone does not dock the panel: its manifest uses `place: none`.

Clone a shipped layout before changing its structure; do not edit Herdr's shipped files. Keep `RECIPE.md` and `preview.png` in the repository, outside the installed mod folder.

Validate the installed mod:

```sh
herdr-app check "$herdr_app_home/mods/magpie-route"
```

These examples use the `herdr-app` CLI. If it is not on PATH, use the executable inside your installed Herdr.app with the same arguments. Herdr hot reloads personal mods; a restart is not required.

## Use

Choose a local OMP tab for **Current session**, or select **All requests** to browse the gateway's retained cache. If your gateway does not use `codex-adaptive`, switch the model filter to **All models**.

Click a request to expand its details and pin its route. Recent history starts with three rows; **Show all** enables five rows per page. Filtering resets the page. Global-history pagination survives changing the active terminal tab.

The language button shows **中文** in English and **EN** in Chinese. It changes only the mod's language. Account-identity visibility and motion are separate controls. All controls retain native keyboard focus behavior.

Quotas are global: changing session or model filters does not narrow the quota cards. Automatic reads use gateway cache; **Refresh quotas** explicitly asks the gateway to refresh provider readings. Unknown quota is never displayed as zero usage.

Native mod commands `magpie-route.refresh` and `magpie-route.locale` can also be invoked with `herdr-app do` or assigned keys in your own `keys.json`. The locale command toggles the same saved language preference as the button.

## Data access and privacy

The mod:

- Reads only the gateway port from `~/.config/magpie/settings.json`, defaulting to 3425.
- Uses loopback HTTP at `127.0.0.1:<port>/v1/magpie/`: `GET trace?after=…`, `GET quotas?kept=1`, and explicit `POST quotas/refresh`.
- Runs `python3`, `hc get --json` and `lsof` to bind a local terminal's foreground OMP process to its uniquely open root session.
- Reads at most 16 KiB / four leading lines of candidate session files under `~/.omp/agent/sessions`; it does not scan full conversation history.
- Retains a narrowed set of routing fields rather than full trace prompt metadata. Account names are masked by default. Provider-supplied raw text keeps its original language.

The request list is the gateway's recent cache, not a complete session archive. No telemetry or external icon downloads occur at runtime. This repository contains no user settings, account credentials, session files or personal layouts. The preview is a redacted capture of the native panel.

## Development

Runtime source lives in `mods/magpie-route/`. Locale dictionaries are grouped by UI, graph and system diagnostics in `locales/`; both languages must expose the same keys and interpolation parameters. `i18n.js` handles message descriptors, plurals and selected-locale date/number formatting. Do not place translated UI text directly in JavaScript renderers or the Python resolver.

Herdr's installed `herdr.d.ts` and `gpui-kit.d.ts` define the available native APIs. Generated SDK declarations and local app state are intentionally excluded. Run `herdr-app check` and inspect real narrow/wide panels in both languages after changing the UI.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream attribution and brand-mark notices. This is an independent community mod.
