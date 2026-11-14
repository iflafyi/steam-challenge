import { getStore } from "@netlify/blobs"
import seedMeta from "../../data/meta.json" with { type: "json" }
import curatedRaw from "../../data/curated.json" with { type: "json" }
// hand-checked decisions for games the automatic rules get wrong
const curated = curatedRaw as Record<string, { in: boolean; reason?: string }>

// ---------- types ----------
export type Meta = {
  name: string; tags: string[]; median: number; average: number
  pos: number; neg: number; ach: number[]
  type?: string | null; cats?: string[]; genres?: string[]
}
export type Game = Meta & {
  appid: number; owners: string[]; excluded: boolean
  difficulty: number; stars: number; expectedHours: number; expectedOverride?: number; difficultyOverride?: number
  excludeReason?: string | null; excludedManual?: boolean
  shareable: boolean  // can be borrowed via Steam Family; false → only owners can get it
}
export type Player = { id: string; nick: string; steamId: string; persona: string; avatar: string; joinedAt: number }
export type Assignment = {
  id: string; playerId: string; appid: number; name: string
  status: "active" | "done" | "gaveup"
  rolledAt: number; finishedAt?: number
  baseline: number          // minutes at roll time
  current: number           // latest seen minutes
  tracked: boolean          // Steam ever reported this game for the player
  manualMinutes?: number    // manual override
  difficulty: number; expectedHours: number
  points?: number; breakdown?: string
}
export type Settings = {
  basePerDifficulty: number   // points per difficulty unit (difficulty 1..3)
  lengthMultiplier: number    // bonus = mult * sqrt(expected hours)
  speedMin: number; speedMax: number
  giveUpPenalty: number
}
export type Library = { steamId: string; persona: string; addedAt: number }
export type State = {
  libraries?: Library[]   // family members who share games but do not play the challenge
  lastLibraryRefresh?: number
  players: Player[]; assignments: Assignment[]
  games: Record<string, Game>; settings: Settings; lastSync?: number
}

// libraries the starting pool was built from (until these people join as players)
const SEED_LIBRARIES: Library[] = [
  { steamId: "76561198429562745", persona: "Вуйчіч", addedAt: 0 },
  { steamId: "76561198983634521", persona: "Jackpot", addedAt: 0 },
]

export const DEFAULT_SETTINGS: Settings = {
  basePerDifficulty: 10, lengthMultiplier: 2, speedMin: 0.7, speedMax: 1.5, giveUpPenalty: 5,
}

// ---------- difficulty ----------
const HARD: Record<string, number> = {
  "Difficult": 0.8, "Souls-like": 0.9, "Masocore": 1.0, "Precision Platformer": 0.7,
  "Bullet Hell": 0.6, "Roguelike": 0.4, "Rogue-like": 0.4, "Roguelite": 0.3, "Rogue-lite": 0.3,
  "Permadeath": 0.4, "Perma Death": 0.4, "Action Roguelike": 0.3, "Soulslike": 0.9,
  "Hardcore": 0.4, "Metroidvania": 0.2, "Survival": 0.15, "Tactical": 0.1,
  "Strategy": 0.1, "Grand Strategy": 0.3, "Puzzle": 0.1, "Turn-Based Tactics": 0.15,
}
const EASY: Record<string, number> = {
  "Casual": -0.4, "Relaxing": -0.45, "Cozy": -0.45, "Walking Simulator": -0.5,
  "Visual Novel": -0.4, "Family Friendly": -0.2, "Clicker": -0.3, "Idler": -0.4,
  "Short": -0.15, "Interactive Fiction": -0.3, "Story Rich": -0.05,
}
// ---------- what counts as "not completable" ----------
const ONLINE = ["Massively Multiplayer", "MMORPG", "Free to Play", "PvP", "Competitive", "Battle Royale",
  "MOBA", "eSports", "Hero Shooter", "Extraction Shooter", "Social Deduction", "Party Game", "Team-Based", "Tactical Shooter"]
const ENDLESS = ["Sandbox", "Open World Survival Craft", "Clicker", "Idler", "Building", "City Builder",
  "Colony Sim", "Automation", "Life Sim", "Farming Sim", "Board Game", "Card Game", "Simulation", "Racing",
  "Sports", "Fighting", "Rhythm", "Trading Card Game", "Auto Battler"]
const NOT_GAME = ["Software", "Utilities", "Design & Illustration", "Animation & Modeling", "Video Production",
  "Audio Production", "Photo Editing", "Game Development", "Web Publishing", "Education", "Benchmark"]
const STORY = ["Story Rich", "Singleplayer", "Linear", "Narrative", "Choices Matter", "Multiple Endings", "Campaign"]

/** Returns why a game can't be "completed", or null if it can */
export function excludeReason(m: Meta): string | null {
  const t = m.tags, top = (n: number) => t.slice(0, n)
  if (m.type && m.type !== "game") return "Не гра (" + m.type + ")"
  if ([...top(6), ...(m.genres ?? [])].some(x => NOT_GAME.includes(x))) return "Програма, а не гра"
  if (m.cats && m.cats.length && !m.cats.includes("Single-player")) return "Немає одиночного режиму"
  if (top(6).some(x => ONLINE.includes(x))) return "Онлайн / PvP гра"
  if (top(4).some(x => ENDLESS.includes(x)) && !top(8).some(x => STORY.slice(0, 1).includes(x) || ["Linear", "Narrative", "Multiple Endings", "Choices Matter"].includes(x)))
    return "Немає кінця (пісочниця / симулятор)"
  if (!m.cats?.length && !t.length) return null
  return null
}

export function computeGame(appid: number, m: Meta, owners: string[], prev?: Game): Game {
  let tagScore = 0
  m.tags.forEach((t, i) => {
    const w = i < 5 ? 1 : i < 12 ? 0.7 : 0.45   // higher-voted tags weigh more
    tagScore += ((HARD[t] ?? 0) + (EASY[t] ?? 0)) * w
  })
  tagScore = Math.max(-0.6, Math.min(1.3, tagScore))
  let achScore = 0
  if (m.ach.length >= 5) {
    const s = [...m.ach].sort((a, b) => a - b)
    const med = s[Math.floor(s.length / 2)]
    achScore = Math.max(-0.3, Math.min(0.6, ((25 - med) / 25) * 0.6))
  }
  const auto = Math.round(Math.max(1, Math.min(3, 1.5 + tagScore + achScore)) * 10) / 10
  const difficulty = prev?.difficultyOverride ?? auto
  const stars = Math.min(5, Math.max(1, Math.round(((difficulty - 1) / 2) * 4) + 1))
  const med = m.median || m.average || 0
  const expectedHours = Math.round(Math.max(1, Math.min(80, med / 60)) * 10) / 10
  const c = curated[String(appid)]
  const reason = c ? (c.in ? null : c.reason ?? "Виключено") : excludeReason(m)
  return {
    ...m, appid, owners,
    excludeReason: reason, excludedManual: prev?.excludedManual,
    shareable: !m.cats?.length || m.cats.includes("Family Sharing"),
    excluded: prev?.excludedManual ?? !!reason,
    difficulty, stars, expectedHours,
    expectedOverride: prev?.expectedOverride, difficultyOverride: prev?.difficultyOverride,
  }
}
export const expected = (g: { expectedHours: number; expectedOverride?: number }) => g.expectedOverride ?? g.expectedHours

export function scoreFor(a: Assignment, s: Settings) {
  const minutes = a.manualMinutes ?? Math.max(0, a.current - a.baseline)
  const hours = Math.max(0.5, minutes / 60)
  const exp = a.expectedHours
  const base = s.basePerDifficulty * a.difficulty
  const len = s.lengthMultiplier * Math.sqrt(exp)
  const speed = Math.max(s.speedMin, Math.min(s.speedMax, exp / hours))
  const points = Math.round((base + len) * speed)
  const breakdown = `(${s.basePerDifficulty}×${a.difficulty} складн. + ${s.lengthMultiplier}×√${exp} год) × ${speed.toFixed(2)} швидкість = ${points}`
  return { points, breakdown }
}

// ---------- Steam ----------
const key = () => Netlify.env.get("STEAM_API_KEY") ?? ""
async function sj(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`Steam ${r.status}`)
  return r.json()
}
export async function resolveSteamId(input: string): Promise<string> {
  const s = input.trim()
  const m17 = s.match(/7656\d{13}/)
  if (m17) return m17[0]
  const vanity = s.match(/steamcommunity\.com\/id\/([^/?#]+)/)?.[1] ?? (/^[\w-]{2,32}$/.test(s) ? s : null)
  if (!vanity) throw new Error("Не вдалося розпізнати Steam ID або посилання")
  const j = await sj(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key()}&vanityurl=${encodeURIComponent(vanity)}`)
  if (j.response?.success !== 1) throw new Error("Steam не знайшов такий профіль")
  return j.response.steamid
}
export async function summary(steamId: string) {
  const j = await sj(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key()}&steamids=${steamId}`)
  const p = j.response?.players?.[0]
  if (!p) throw new Error("Профіль не знайдено")
  return { persona: p.personaname as string, avatar: p.avatarmedium as string, public: p.communityvisibilitystate === 3 }
}
export async function ownedGames(steamId: string): Promise<{ appid: number; name: string; playtime_forever: number }[]> {
  const j = await sj(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key()}&steamid=${steamId}&include_appinfo=1&format=json`)
  return j.response?.games ?? []
}
export async function recentGames(steamId: string): Promise<{ appid: number; playtime_forever: number }[]> {
  const j = await sj(`https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${key()}&steamid=${steamId}&count=0`)
  return j.response?.games ?? []
}
/** minutes Steam reports for this player+game, or null if Steam doesn't show it */
export async function playtime(steamId: string, appid: number): Promise<number | null> {
  const [own, rec] = await Promise.allSettled([ownedGames(steamId), recentGames(steamId)])
  let best: number | null = null
  for (const r of [own, rec]) {
    if (r.status !== "fulfilled") continue
    const g = r.value.find(x => x.appid === appid)
    if (g) best = Math.max(best ?? 0, g.playtime_forever)
  }
  return best
}
export async function fetchMeta(appid: number, name: string): Promise<Meta> {
  const [spy, ach, store] = await Promise.allSettled([
    sj(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`),
    sj(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`),
    sj(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=categories,genres,basic&l=english`),
  ])
  const st: any = store.status === "fulfilled" ? store.value?.[appid]?.data ?? {} : {}
  const s: any = spy.status === "fulfilled" ? spy.value : {}
  const a: any = ach.status === "fulfilled" ? ach.value : {}
  const tags = s.tags && !Array.isArray(s.tags) ? Object.keys(s.tags).slice(0, 20) : []
  return {
    name, tags, median: s.median_forever ?? 0, average: s.average_forever ?? 0,
    pos: s.positive ?? 0, neg: s.negative ?? 0,
    type: st.type ?? null,
    cats: (st.categories ?? []).map((c: any) => c.description),
    genres: (st.genres ?? []).map((g: any) => g.description),
    ach: (a.achievementpercentages?.achievements ?? []).map((x: any) => parseFloat(x.percent)).sort((x: number, y: number) => x - y),
  }
}

// ---------- storage ----------
const store = () => getStore({ name: "challenge", consistency: "strong" })

export async function load(): Promise<State> {
  const s = (await store().get("state", { type: "json" })) as State | null
  if (s) {
    s.settings = { ...DEFAULT_SETTINGS, ...s.settings }
    s.libraries ??= SEED_LIBRARIES.filter(l => !s.players.some(p => p.steamId === l.steamId))
    // re-apply current rules on every load (keeps manual choices); merge bundled store data if missing
    const seed = seedMeta as Record<string, Meta>
    for (const [id, g] of Object.entries(s.games)) {
      if ((g as any).needsMeta) continue
      const sm = seed[id]
      const m = g.cats === undefined && sm?.cats !== undefined ? { ...g, type: sm.type, cats: sm.cats, genres: sm.genres } : g
      s.games[id] = computeGame(g.appid, m, g.owners, g)
    }
    return s
  }
  // first run: seed the pool from bundled metadata (owners filled when players join)
  const games: Record<string, Game> = {}
  for (const [id, m] of Object.entries(seedMeta as Record<string, Meta & { owners?: string[] }>)) {
    games[id] = computeGame(Number(id), m, m.owners ?? [])
  }
  return { players: [], libraries: [...SEED_LIBRARIES], assignments: [], games, settings: DEFAULT_SETTINGS }
}
export async function save(s: State) { await store().setJSON("state", s) }

export const monthKey = (t: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit" }).format(new Date(t))

export async function syncActive(s: State) {
  const active = s.assignments.filter(a => a.status === "active")
  await Promise.all(active.map(async a => {
    const p = s.players.find(x => x.id === a.playerId)
    if (!p) return
    try {
      const m = await playtime(p.steamId, a.appid)
      if (m !== null) {
        a.current = Math.max(a.current, m); a.tracked = true
      }
    } catch { /* keep previous value */ }
  }))
  s.lastSync = Date.now()
}

/** Can this player get this game? Own it, or it is shareable through the family. */
export const eligible = (g: Game, steamId: string) => g.owners.includes(steamId) || g.shareable

export async function addOwnedToPool(s: State, steamId: string) {
  const owned = await ownedGames(steamId)
  for (const o of owned) {
    const k = String(o.appid)
    const g = s.games[k]
    if (g) { if (!g.owners.includes(steamId)) g.owners.push(steamId) }
    else s.games[k] = { ...computeGame(o.appid, { name: o.name, tags: [], median: 0, average: 0, pos: 0, neg: 0, ach: [] }, [steamId]), needsMeta: true } as Game
  }
  return owned.length
}

/** Pick up newly bought games for everyone (players + non-playing family libraries) */
export async function refreshLibraries(s: State) {
  const ids = new Set([...s.players.map(p => p.steamId), ...(s.libraries ?? []).map(l => l.steamId)])
  for (const id of ids) { try { await addOwnedToPool(s, id) } catch { /* private or Steam down */ } }
  s.lastLibraryRefresh = Date.now()
}
