import type { Config } from "@netlify/functions"
import { load, save, syncActive, refreshLibraries } from "../lib/core.mts"

// Every 30 minutes (UTC; interval-based, so no local-time conversion needed)
export default async () => {
  const s = await load()
  const daily = Date.now() - (s.lastLibraryRefresh ?? 0) > 24 * 3600e3
  if (daily) await refreshLibraries(s)   // pick up newly bought games once a day
  if (s.assignments.some(a => a.status === "active")) await syncActive(s)
  await save(s)
  if (daily && Object.values(s.games).some((g: any) => g.needsMeta))
    await fetch(new URL("/api-enrich", Netlify.env.get("URL") ?? "https://steam-challenge-family.netlify.app"), { method: "POST" }).catch(() => {})
}

export const config: Config = { schedule: "*/30 * * * *" }
