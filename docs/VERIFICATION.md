# Live verification record — M1

Date: 2026-08-20 · dsh `0.1.0-rc.8` · Windows 10 · Node v24.14.1

## What was verified

The full chain, inside a real `dsh web` session (not a unit-test double):

1. **Plugin install & load** — host half activates from the web profile, no boot errors.
2. **Client half discovery** — `/plugins/tukey/client.js` appears in
   `window.__DSH_BOOT__.entries` with the `dsh.client.inject` edges, is served
   with HTTP 200, and its factory registers with `window.__ModuleLoader__`
   (probe: a second execution reports *duplicate factory registration*, proving
   the boot-time one succeeded).
3. **Tool execution** — a scripted mock LLM drove one conversation turn through
   `data_attach → data_profile → data_chart(bar) → data_chart(line) → text`.
   All five requests completed in order; the session shows zero failed steps.
4. **Chart rendering** — two `figure.tukey-chart` conversation nodes
   rendered, each holding a Vega canvas (1260×490, 54% non-background pixels).
   Exports: `docs/assets/chart-bar-region.png`, `chart-line-trend.png`.

## How to reproduce

```bash
# 1. Install the plugin into the web profile (verified equivalent: a junction
#    at $DSH_HOME/profiles/web/node_modules/tukey -> packages/dsh)
pnpm exec dsh plugin --profile web add D:\Code\tukey\packages\dsh

# 2. Start the scripted mock LLM (drives attach -> profile -> chart -> chart -> text)
node scripts/mock-llm-scripted.mjs 8471

# 3. Boot dsh web against it. Launcher flags MUST precede app flags.
DEEPSEEK_BASE_URL=http://127.0.0.1:8471/v1 DEEPSEEK_API_KEY=mock-key \
  pnpm exec dsh --profile web --patch scripts/verify-live.patch.yml --no-open

# 4. In the browser: pick the workspace, switch the agent preset to 标准模式
#    (Standard), send any message, watch the charts render.
```

## Hard-won facts (each cost a failed attempt)

- **The client bundle is NOT an ESM file.** The browser runtime is a lazy CJS
  module table: a plugin bundle must execute
  `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` and pull
  shared singletons (react, the `@deepseek-ai/dsh-client-*` platform modules)
  through the injected `require`. A bare `import "react"` fails — the page has
  no import map. `scripts/bundle-client.mjs` reproduces the banner/footer
  contract from the harness's own `packages/client/tsdown.client.ts`.
- **Plugin names resolve from the profile directory**, `$DSH_HOME/profiles/web/`,
  not from the invoking project. A `--patch` row naming an npm-style package
  only works after the package is installed (or linked) into the profile.
  `file:` specs break on the `workspace:^` dependency; bare paths become
  `link:` and work.
- **PTC 模式 (Code Mode) blocks direct tool calls** — every tool call fails
  with *only `run_code` is callable directly*. Verification must run under the
  Standard preset, or the model must wrap calls in a `run_code` program. The
  error message itself confirmed tool registration.
- **`session-title-llm` steals a scripted response.** The title generator fires
  its own model call on the first prompt; against a FIFO-scripted server it
  consumes the first entry and shifts everything off by one. Disable the row
  (`scripts/verify-live.patch.yml`) — the harness's own e2e scaffold does the
  same.
- **Launcher flag order is load-bearing.** `--patch`/`--profile` must precede
  app flags (`--no-open`, `--port`); the first unrecognized token starts the
  app's argv. `dsh web --patch x` errors; `dsh --profile web --patch x` works.
- **A hidden browser tab renders 0-width charts.** `width: 'container'`
  measures 0 while `document.hidden`; a resize event after the pane becomes
  visible fixes it (Vega re-measures). Not a plugin bug, but worth knowing for
  headless screenshotting.

## Verified install equivalences

`dsh plugin --profile web add <abs-path>` (writes a `link:` dependency and
appends to `dsh.profile.bundles`) ≡ a manual junction under the profile's
`node_modules` plus a `--patch` overlay inserting the row. The former is the
user-facing story; the latter is what CI can do without touching pnpm.
