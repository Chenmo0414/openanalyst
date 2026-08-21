/**
 * Tukey — the DeepSeek Harness browser half.
 *
 * Renders `tukey/chart` events as real charts inside the conversation.
 *
 * Why a conversation node rather than a tool card: the harness tool-card kinds
 * are a closed set (`generic`, `terminal`, `diff`, `search`, `web`) with no
 * chart member, so a tool result can only ever degrade a chart to text. A
 * conversation node owns its own React subtree, which is the only surface where
 * a chart can actually be drawn.
 *
 * The node is a pure function of one durable event. `match` keys on the event's
 * own `seq`, and the payload is a whole-value checkpoint, so replaying a session
 * log reproduces every chart exactly — no clock, no random, no live state.
 *
 * @module tukey/client
 */

import { createElement, useEffect, useRef, type ReactElement } from 'react'
import type {
  ClientContext,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AttachEventData, ChartEventData, ReportEventData } from '../events.ts'
import { WorkbenchHeaderAction } from './workbench.tsx'

const NODE_KIND = 'tukey-chart'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'tukey-chart': ChartEventData
    'tukey-attach': AttachEventData
    'tukey-report': ReportEventData
  }
}

type ChartState = ChartEventData

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

const chartDefinition: ConversationNodeDefinition<ChartState> = {
  kind: NODE_KIND,
  target: 'chat',
  // One event is one chart, so the event's own seq is a stable, replay-safe id.
  match: (event) =>
    event.type === 'tukey/chart' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'tukey/chart') {
      throw new Error('tukey-chart requires an tukey/chart event')
    }
    return match.event.data
  },
  // A chart never changes once drawn; a re-delivered event keeps the state.
  update: (context) => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: state,
    }
  },
}

export function ChartNodeView({ node }: ChatNodeViewProps<'tukey-chart'>): ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const { vegaLite, title, source, rowCount } = node.data

  useEffect(() => {
    const element = host.current
    if (element === null) return

    let disposed = false
    let finalize: (() => void) | undefined

    // Loaded on demand so the Vega runtime never sits in the critical boot
    // path of a session that contains no charts.
    type EmbedFn = (
      el: HTMLElement,
      spec: unknown,
      options?: {
        actions?: boolean | { export?: boolean; source?: boolean; compiled?: boolean; editor?: boolean }
        renderer?: 'canvas' | 'svg'
        i18n?: { PNG_ACTION?: string; SVG_ACTION?: string }
      },
    ) => Promise<{ finalize: () => void; view: { resize: () => { runAsync: () => Promise<unknown> } } }>

    void import('vega-embed')
      .then(async (module) => {
        if (disposed) return
        // The package's default export is typed as `embed | container`; a
        // union of call signatures is not callable, so pin it to the one
        // this plugin uses.
        const embed = module.default as unknown as EmbedFn
        // vega-embed styles the host inline-block, which collapses to 0px
        // when the pane laid out at zero width (background tab, hidden panel)
        // — and `width: 'container'` then measures 0. Pin the host to a real
        // block box before embedding, and re-measure on every size change so
        // a chart born in a hidden pane heals itself when it becomes visible.
        element.style.display = 'block'
        element.style.width = '100%'
        const result = await embed(element, vegaLite, {
          // The (…) menu keeps only PNG/SVG export — a chart someone can save
          // is a chart someone can share. Source/editor links stay off.
          actions: { export: true, source: false, compiled: false, editor: false },
          renderer: 'canvas',
        })
        if (disposed) {
          result.finalize()
          return
        }
        const observer = new ResizeObserver(() => {
          void result.view.resize().runAsync()
        })
        observer.observe(element)
        finalize = (): void => {
          observer.disconnect()
          result.finalize()
        }
      })
      .catch((cause: unknown) => {
        if (disposed) return
        element.textContent = `Chart could not be rendered: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      })

    return (): void => {
      disposed = true
      finalize?.()
    }
  }, [vegaLite])

  return createElement(
    'figure',
    {
      className: 'tukey-chart',
      // Scroll anchor for the workbench gallery; the id is the chart event's seq.
      'data-tk-chart': node.id,
      style: { margin: '0.5rem 0' },
    },
    createElement('div', { ref: host }),
    createElement(
      'figcaption',
      { style: { fontSize: '0.8em', opacity: 0.7, marginTop: '0.25rem' } },
      `${title} · ${rowCount} point(s) from ${source}`,
    ),
  )
}

/**
 * A data-only projection of one plugin event: its view renders an invisible
 * marker element carrying the payload as JSON. The workbench collects these
 * markers straight from the DOM — self-contained, with no dependency on the
 * snapshot's internals (`snapshot.chat` is guarded by the chat render
 * context and throws when read from a header slot).
 */
function headlessDefinition<Data>(
  kind: 'tukey-attach' | 'tukey-report',
  eventType: string,
): ConversationNodeDefinition<Data> {
  return {
    kind,
    target: 'chat',
    match: (event) => (event.type === eventType ? { id: String(event.seq), role: 'start' } : null),
    start: (_context, match) => match.event.data as Data,
    update: (context) => context.state,
    publication: () => 'immediate',
    buildViewNode: (context) => {
      const state = context.state
      if (state === undefined) return null
      return {
        key: context.key,
        kind,
        id: context.id,
        target: 'chat',
        anchorSeq: context.start?.event.seq ?? 0,
        location: context.start?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: state,
      }
    },
  } as ConversationNodeDefinition<Data>
}

/** Invisible marker node: publishes one event payload into the DOM. */
function markerView(kind: string) {
  return function MarkerView({ node }: { node: { id: string; data: unknown } }): ReactElement {
    return createElement('span', {
      hidden: true,
      style: { display: 'none' },
      'data-tk-kind': kind,
      'data-tk-id': node.id,
      'data-tk-json': JSON.stringify(node.data),
    })
  }
}

export const name = 'tukey-client'
export const inject = ['conversationEvents', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(chartDefinition)
  ctx.conversationEvents.register(headlessDefinition<AttachEventData>('tukey-attach', 'tukey/attach'))
  ctx.conversationEvents.register(headlessDefinition<ReportEventData>('tukey-report', 'tukey/report'))
  ctx.slots.inject('conversation.chat.node', () => [
    ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, ChartNodeView),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'tukey-attach' },
      markerView('attach') as never,
    ),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'tukey-report' },
      markerView('report') as never,
    ),
  ])
  // The workbench button in the session header: sources, chart gallery with
  // scroll-to-chart, and the report archive — collected from the marker DOM
  // this plugin's own nodes render, so it depends on nothing internal.
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'tukey-workbench' },
      WorkbenchHeaderAction as never,
    ),
  )
}
