import type { Config } from "@netlify/functions"
import { load, save, syncActive } from "../lib/core.mts"

// Every 30 minutes (UTC; interval-based, so no local-time conversion needed)
export default async () => {
  const s = await load()
  if (!s.assignments.some(a => a.status === "active")) return
  await syncActive(s)
  await save(s)
}

export const config: Config = { schedule: "*/30 * * * *" }
