/**
 * The durable session event that carries one chart.
 *
 * A chart is produced in a single shot, so this is a one-event family: the
 * client Definition uses the event's own `seq` as its identity, and the payload
 * is a whole-value checkpoint. Replaying the log rebuilds the identical chart
 * without needing the events around it — which is exactly what the conversation
 * node engine requires of a pure renderer.
 *
 * @module openanalyst/events
 */

import type { ChartKind, JsonValue } from '@openanalyst/core'

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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Publishes one rendered chart into the conversation.
     * @mode emit
     * @param data - the complete chart, including its inlined data.
     */
    'openanalyst/chart': ChartEventData
  }
}
