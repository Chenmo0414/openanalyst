/**
 * Full-page screenshot of charts inside a live dsh conversation, via headless
 * Chrome. Drives the same UI a user sees: opens the session, waits for the
 * conversation nodes to replay and vega to draw, scrolls a chart into view,
 * and captures the whole app frame — sidebar, transcript, charts and all.
 *
 * Usage: node scripts/shoot-conversation.mjs [outPath] [viewportWidth]
 */

import puppeteer from 'puppeteer-core'

const OUT = process.argv[2] ?? 'docs/assets/conversation-full.png'
const WIDTH = Number(process.argv[3] ?? 1440)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--force-device-scale-factor=2'],
  defaultViewport: { width: WIDTH, height: 900, deviceScaleFactor: 2 },
})

try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle2', timeout: 60_000 })

  // A fresh browser context lands on a blank new session; open the recorded
  // conversation (the one whose title mentions the heatmap demo) from the
  // sidebar first.
  await page.waitForFunction(
    () => document.body.innerText.includes('heatmap'),
    { timeout: 30_000 },
  )
  const wanted = process.env.TK_SHOOT_SESSION ?? 'Analyze the sales CSV'
  await page.evaluate((title) => {
    // The sidebar row is not a <button>; click the smallest element whose own
    // text carries the session title.
    const all = [...document.querySelectorAll('a, [role="button"], li, div, span')]
    const hits = all.filter((el) => {
      const text = (el.textContent ?? '').trim()
      return text.startsWith(title) && text.length < 80
    })
    hits.sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    const target = hits[0]
    if (target instanceof HTMLElement) target.click()
  }, wanted)

  // Wait for at least two chart canvases with real dimensions.
  await page.waitForFunction(
    () => {
      const canvases = [...document.querySelectorAll('figure.tukey-chart canvas')]
      return canvases.length >= 2 && canvases.every((c) => c.width > 0)
    },
    { timeout: 45_000 },
  )

  // Scroll the first chart to the top of the transcript viewport.
  await page.evaluate(() => {
    const first = document.querySelector('figure.tukey-chart')
    first?.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -100)
  })
  await new Promise((resolve) => setTimeout(resolve, 1200))

  // Optionally open the workbench panel so the capture shows it.
  if (process.env.TK_SHOOT_WORKBENCH === '1') {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("title") === "Tukey workbench",
      )
      if (btn instanceof HTMLElement) btn.click()
    })
    await new Promise((resolve) => setTimeout(resolve, 900))
  }

  await page.screenshot({ path: OUT })
  console.log('saved', OUT)
} finally {
  await browser.close()
}
