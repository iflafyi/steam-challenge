import type { Config, Context } from "@netlify/functions"
import {
  load, save, syncActive, computeGame, scoreFor, expected, monthKey,
  resolveSteamId, summary, ownedGames, playtime, fetchMeta,
  type State, type Assignment, type Game,
} from "../lib/core.mts"

const err = (msg: string, status = 400) => Response.json({ error: msg }, { status })
const uid = () => Math.random().toString(36).slice(2, 10)

function publicState(s: State) {
  const month = monthKey(Date.now())
  const scores: Record<string, Record<string, number>> = {}
  for (const a of s.assignments) {
    if (a.status === "active" || a.points === undefined || !a.finishedAt) continue
    const m = monthKey(a.finishedAt)
    scores[m] ??= {}
    scores[m][a.playerId] = (scores[m][a.playerId] ?? 0) + a.points
  }
  const games = Object.values(s.games).map(g => ({
    appid: g.appid, name: g.name, owners: g.owners, excluded: g.excluded,
    difficulty: g.difficulty, stars: g.stars, expectedHours: expected(g),
    tags: g.tags.slice(0, 6), reason: g.excludeReason ?? null, manual: g.excludedManual !== undefined,
  })).sort((a, b) => a.name.localeCompare(b.name))
  return { players: s.players, assignments: s.assignments, games, settings: s.settings, scores, month, lastSync: s.lastSync }
}

async function addOwnedToPool(s: State, steamId: string) {
  const owned = await ownedGames(steamId)
  for (const o of owned) {
    const k = String(o.appid)
    const g = s.games[k]
    if (g) { if (!g.owners.includes(steamId)) g.owners.push(steamId) }
    else s.games[k] = { ...computeGame(o.appid, { name: o.name, tags: [], median: 0, average: 0, pos: 0, neg: 0, ach: [] }, [steamId]), needsMeta: true } as Game & { needsMeta?: boolean }
  }
  return owned.length
}

export default async (req: Request, context: Context) => {
  const action = context.params["0"] ?? new URL(req.url).pathname.split("/").pop()
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {}
  const s = await load()

  try {
    switch (action) {
      case "state":
        return Response.json(publicState(s))

      case "join": {
        const nick = String(body.nick ?? "").trim().slice(0, 24)
        if (!nick) return err("Впиши нік")
        const steamId = await resolveSteamId(String(body.steam ?? ""))
        const sum = await summary(steamId)
        if (!sum.public) return err("Профіль Steam закритий — відкрий його в налаштуваннях приватності")
        let p = s.players.find(x => x.steamId === steamId)
        if (p) { p.nick = nick; p.persona = sum.persona; p.avatar = sum.avatar }
        else { p = { id: uid(), nick, steamId, persona: sum.persona, avatar: sum.avatar, joinedAt: Date.now() }; s.players.push(p) }
        const count = await addOwnedToPool(s, steamId)
        await save(s)
        // classify the newly added games in the background
        if (Object.values(s.games).some((g: any) => g.needsMeta))
          context.waitUntil(fetch(new URL("/api-enrich", req.url), { method: "POST" }).catch(() => {}))
        return Response.json({ player: p, gamesAdded: count, state: publicState(s) })
      }

      case "roll": {
        const p = s.players.find(x => x.id === body.playerId)
        if (!p) return err("Гравця не знайдено")
        if (s.assignments.some(a => a.playerId === p.id && a.status === "active"))
          return err("У тебе вже є активна гра — пройди її або здайся")
        const busy = new Set(s.assignments.filter(a => a.status === "active").map(a => a.appid))
        const done = new Set(s.assignments.filter(a => a.playerId === p.id).map(a => a.appid))
        const pool = Object.values(s.games).filter(g => !g.excluded && !busy.has(g.appid) && !done.has(g.appid))
        if (!pool.length) return err("Пул ігор порожній")
        let g: (Game & { needsMeta?: boolean }) | null = null
        for (let tries = 0; tries < 6 && pool.length; tries++) {
          const i = Math.floor(Math.random() * pool.length)
          let c = pool[i] as Game & { needsMeta?: boolean }
          if (c.needsMeta) {
            c = computeGame(c.appid, await fetchMeta(c.appid, c.name), c.owners, c)
            s.games[String(c.appid)] = c
          }
          if (!c.excluded) { g = c; break }
          pool.splice(i, 1)  // turned out not completable — try another
        }
        if (!g) { await save(s); return err("Не вдалося знайти гру, спробуй ще раз") }
        const base = await playtime(p.steamId, g.appid).catch(() => null)
        const a: Assignment = {
          id: uid(), playerId: p.id, appid: g.appid, name: g.name, status: "active",
          rolledAt: Date.now(), baseline: base ?? 0, current: base ?? 0, tracked: base !== null,
          difficulty: g.difficulty, expectedHours: expected(g),
        }
        s.assignments.push(a)
        await save(s)
        return Response.json({ assignment: a, candidates: pool.slice(0, 40).map(x => ({ appid: x.appid, name: x.name })), state: publicState(s) })
      }

      case "sync": {
        await syncActive(s)
        await save(s)
        return Response.json(publicState(s))
      }

      case "finish": {
        const a = s.assignments.find(x => x.id === body.id && x.status === "active")
        if (!a) return err("Активну гру не знайдено")
        const p = s.players.find(x => x.id === a.playerId)
        if (p) {
          const m = await playtime(p.steamId, a.appid).catch(() => null)
          if (m !== null) { a.current = Math.max(a.current, m); a.tracked = true }
        }
        if (body.giveUp) {
          a.status = "gaveup"; a.points = -s.settings.giveUpPenalty; a.breakdown = `Здався: −${s.settings.giveUpPenalty}`
        } else {
          if (!a.tracked && a.manualMinutes === undefined && body.manualHours === undefined)
            return err("Steam не бачить час у цій грі — впиши години вручну")
          if (body.manualHours !== undefined) a.manualMinutes = Math.round(Number(body.manualHours) * 60)
          a.status = "done"
          Object.assign(a, scoreFor(a, s.settings))
        }
        a.finishedAt = Date.now()
        await save(s)
        return Response.json(publicState(s))
      }

      case "manual": {
        const a = s.assignments.find(x => x.id === body.id)
        if (!a) return err("Не знайдено")
        a.manualMinutes = body.hours === null || body.hours === "" ? undefined : Math.round(Number(body.hours) * 60)
        if (a.status === "done") Object.assign(a, scoreFor(a, s.settings))
        await save(s)
        return Response.json(publicState(s))
      }

      case "game": {
        const g = s.games[String(body.appid)]
        if (!g) return err("Гру не знайдено")
        if (typeof body.excluded === "boolean") { g.excluded = body.excluded; g.excludedManual = body.excluded }
        if (body.expectedHours !== undefined) g.expectedOverride = body.expectedHours === null ? undefined : Number(body.expectedHours)
        if (body.difficulty !== undefined) {
          g.difficultyOverride = body.difficulty === null ? undefined : Math.max(1, Math.min(3, Number(body.difficulty)))
          s.games[String(g.appid)] = computeGame(g.appid, g, g.owners, g)
        }
        await save(s)
        return Response.json(publicState(s))
      }

      case "settings": {
        for (const k of Object.keys(s.settings) as (keyof State["settings"])[])
          if (body[k] !== undefined && !isNaN(Number(body[k]))) s.settings[k] = Number(body[k])
        await save(s)
        return Response.json(publicState(s))
      }

      case "remove-player": {
        s.players = s.players.filter(p => p.id !== body.playerId)
        s.assignments = s.assignments.filter(a => a.playerId !== body.playerId)
        await save(s)
        return Response.json(publicState(s))
      }

      default:
        return err("Unknown action", 404)
    }
  } catch (e: any) {
    return err(e?.message ?? "Помилка сервера", 500)
  }
}

export const config: Config = { path: "/api/*" }
