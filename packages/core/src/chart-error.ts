/** Chart construction failures, shared by both engines' builders. */
export class ChartError extends Error {
  override readonly name = 'ChartError'
}
