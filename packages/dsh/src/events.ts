/**
 * The durable session event that carries one chart.
 *
 * A chart is produced in a single shot, so this is a one-event family: the
 * client Definition uses the event's own `seq` as its identity, and the payload
 * is a whole-value checkpoint. Replaying the log rebuilds the identical chart
 * without needing the events around it — which is exactly what the conversation
 * node engine requires of a pure renderer.
 *
 * @module tukey/events
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { ChartKind, JsonValue } from '@tukey/core'

/** Every event type this plugin appends to session logs. */
export const PLUGIN_EVENT_TYPES = ['tukey/attach', 'tukey/chart', 'tukey/report'] as const

/**
 * Register this plugin's event vocabulary with the persistence read path.
 *
 * Without this, a session containing an `tukey/chart` event LOADS while
 * the host process lives (in-memory replay) but is REFUSED on the next cold
 * start: the persistence coordinator checks every stored event against
 * `KNOWN_SESSION_EVENT_TYPES` and `Session.append()` exposes no way to mark an
 * event `ignorable`. The harness's own comment defers a plugin registration
 * surface "until such a consumer exists" — this plugin is that consumer, so
 * until the official surface lands, the known-types set (a mutable runtime
 * Set) is extended directly.
 *
 * CAVEAT: this only works when the plugin resolves the SAME `dsh-session`
 * module instance the host runtime uses (true for a normal profile install,
 * where the package is a peer dependency). A second copy of dsh-session in
 * the plugin's own tree would receive the registration into the wrong Set —
 * which is why `registerPluginEvents` verifies nothing and callers treat a
 * still-failing cold load as this exact symptom.
 */
export function registerPluginEvents(): void {
  try {
    const registry = KNOWN_SESSION_EVENT_TYPES as Set<string>
    for (const type of PLUGIN_EVENT_TYPES) registry.add(type)
  } catch {
    // A frozen or foreign Set must not stop the plugin from loading; the
    // failure mode is the pre-existing one (cold session loads refuse).
  }
}

export interface ChartEventData {
  /** Human-facing chart title, already resolved by the core. */
  readonly title: string
  readonly kind: ChartKind
  /** Alias of the dataset the chart was built from. */
  readonly source: string
  /** Data points inlined in the spec. */
  readonly rowCount: number
  /**
   * A complete Vega-Lite v5 specification with its data inlined.
   *
   * Kept as one opaque JSON value on purpose: the renderer hands it to
   * Vega-Lite verbatim, so adding an encoding channel in the core needs no
   * change here and no migration of already-logged events.
   */
  readonly vegaLite: JsonValue
}

/** Durable record of one attached dataset. */
export interface AttachEventData {
  readonly alias: string
  /** File path, connection string (redacted), or `<inline>`. */
  readonly origin: string
  readonly rowCount: number
  readonly columns: readonly { readonly name: string; readonly sqlType: string }[]
}

/** Durable record of one generated HTML report. */
export interface ReportEventData {
  /** Absolute path the report was written to. */
  readonly path: string
  readonly title: string
  readonly sources: readonly string[]
  readonly chartCount: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Publishes one rendered chart into the conversation.
     * @mode emit
     * @param data - the complete chart, including its inlined data.
     */
    /**
     * Records one attached dataset, so the workbench panel can list this
     * session's sources without a host round trip.
     * @mode emit
     * @param data - the dataset's identity and shape.
     */
    'tukey/attach': AttachEventData
    'tukey/chart': ChartEventData
    /**
     * Records one generated HTML report, so session surfaces (the workbench
     * panel) can list past reports without a host round trip.
     * @mode emit
     * @param data - where the report landed and what it contains.
     */
    'tukey/report': ReportEventData
  }
}
