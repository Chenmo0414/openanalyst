/**
 * OpenAnalyst — the DeepSeek Harness browser half.
 *
 * Renders `openanalyst/chart` events as real charts inside the conversation.
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
 * @module openanalyst/client
 */

import { createElement, useEffect, useRef, type ReactElement } from 'react'
import type {
  ClientContext,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChartEventData } from '../events.ts'

const NODE_KIND = 'openanalyst-chart'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'openanalyst-chart': ChartEventData
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
    event.type === 'openanalyst/chart' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'openanalyst/chart') {
      throw new Error('openanalyst-chart requires an openanalyst/chart event')
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

export function ChartNodeView({ node }: ChatNodeViewProps<'openanalyst-chart'>): ReactElement {
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
      options?: { actions?: boolean; renderer?: 'canvas' | 'svg' },
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
          actions: false,
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
    { className: 'openanalyst-chart', style: { margin: '0.5rem 0' } },
    createElement('div', { ref: host }),
    createElement(
      'figcaption',
      { style: { fontSize: '0.8em', opacity: 0.7, marginTop: '0.25rem' } },
      `${title} · ${rowCount} point(s) from ${source}`,
    ),
  )
}

export const name = 'openanalyst-client'
export const inject = ['conversationEvents', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(chartDefinition)
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, ChartNodeView),
  )
}
