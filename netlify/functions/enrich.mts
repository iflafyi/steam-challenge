import type { Config } from "@netlify/functions"
import { load, save, computeGame, fetchMeta, type Game } from "../lib/core.mts"

// Background: fetch tags/categories for games added by new players, so the
// "not completable" filter applies before anyone rolls them.
export default async () => {
  const s = await load()
  const todo = Object.values(s.games).filter(g => (g as Game & { needsMeta?: boolean }).needsMeta)
  const done: Record<string, Game> = {}
  for (const g of todo) {
    try { done[g.appid] = computeGame(g.appid, await fetchMeta(g.appid, g.name), g.owners, g) } catch { /* retry next time */ }
    await new Promise(r => setTimeout(r, 1200)) // Steam store rate limit
  }
  const fresh = await load() // merge into latest state (others may have rolled meanwhile)
  for (const [id, g] of Object.entries(done)) if (fresh.games[id]) fresh.games[id] = { ...g, owners: fresh.games[id].owners }
  await save(fresh)
}

export const config: Config = { background: true, path: "/api-enrich" }
