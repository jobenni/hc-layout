import type { Register } from 'claude-code'

const FILL_RETRY_MS = 500
const FILL_GIVE_UP_AFTER_MS = 10 * 60 * 1000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const draft = await $.env.get('CLAUDE_PROMPT_DRAFT')
    if (!draft) return started

    void (async () => {
      const giveUpAt = (await $.clock.now()) + FILL_GIVE_UP_AFTER_MS
      while ((await $.clock.now()) < giveUpAt) {
        const box = await $.prompt.read()
        if (box.text !== '') break
        const { isFilled } = await $.prompt.fill({ text: draft, mode: 'replace' })
        if (isFilled) break
        await $.clock.sleep(FILL_RETRY_MS)
      }
      await $.env.set('CLAUDE_PROMPT_DRAFT', undefined)
    })()

    return started
  })
}
