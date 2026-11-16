import {
  load, save, syncActive, computeGame, scoreFor, expected, monthKey,
  resolveSteamId, summary, playtime, fetchMeta, eligible, addOwnedToPool, refreshLibraries,
  monthScores, monthResults, hasState, importFrom, playerBadges, pinHash, validPin, modFor, MODS, BADGES,
  type State, type Assignment, type Game, type Player,
} from "./core.ts"

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

// the page is served from GitHub Pages, so the API must allow that origin
const ALLOWED = ["https://iflafyi.github.io", "http://localhost:8787"]
let corsOrigin = ""
const cors = () => (corsOrigin ? {
  "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
} : {}) as Record<string, string>
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors() })
const err = (msg: string, status = 400, extra: object = {}) => json({ error: msg, ...extra }, status)
const uid = () => Math.random().toString(36).slice(2, 10)

class Fail extends Error {
  constructor(msg: string, public status = 400, public code?: string, public dirty = false) { super(msg) }
}

function publicState(s: State) {
  const month = monthKey(Date.now())
  const scores = monthScores(s)
  const results = monthResults(s, scores)
  const games = Object.values(s.games).map(g => ({
    appid: g.appid, name: g.name, owners: g.owners, excluded: g.excluded,
    difficulty: g.difficulty, stars: g.stars, expectedHours: expected(g),
    tags: g.tags.slice(0, 6), shareable: g.shareable, reason: g.excludeReason ?? null, manual: g.excludedManual !== undefined,
  })).sort((a, b) => a.name.localeCompare(b.name))
  const players = s.players.map(({ pinHash, pinFails, pinLockUntil, ...p }) => ({ ...p, hasPin: !!pinHash }))
  const mod = modFor(s, month)
  return {
    libraries: s.libraries ?? [], players, assignments: s.assignments, games, settings: s.settings,
    scores, results, month, lastSync: s.lastSync,
    bonuses: s.bonuses ?? [], duels: s.duels ?? [], notes: s.notes ?? {},
    mods: MODS.map(({ id, icon, name, desc }) => ({ id, icon, name, desc })),
    monthMods: s.mods ?? {}, mod: mod.id, rerollsAllowed: s.settings.rerollsPerMonth * (mod.rerolls ?? 1),
    badgeList: BADGES, badges: playerBadges(s, results),
  }
}

/** Checks the player's PIN. 5 wrong tries → locked for 10 minutes. */
async function auth(s: State, playerId: unknown, pin: unknown): Promise<Player> {
  const p = s.players.find(x => x.id === playerId)
  if (!p) throw new Fail("Гравця не знайдено")
  if (!p.pinHash) throw new Fail(`${p.nick} ще не поставив PIN`, 403, "NO_PIN")
  if ((p.pinLockUntil ?? 0) > Date.now())
    throw new Fail(`Забагато неправильних спроб. Спробуй через ${Math.ceil((p.pinLockUntil! - Date.now()) / 60000)} хв`, 429)
  if (typeof pin !== "string" || (await pinHash(p.id, pin)) !== p.pinHash) {
    p.pinFails = (p.pinFails ?? 0) + 1
    if (p.pinFails >= 5) { p.pinLockUntil = Date.now() + 10 * 60e3; p.pinFails = 0 }
    throw new Fail("Неправильний PIN", 403, "BAD_PIN", true)
  }
  if (p.pinFails) p.pinFails = 0
  return p
}

/** Site admin: password from the Supabase secret ADMIN_PASSWORD; 5 wrong tries per instance → 10 min pause */
let adminFails = 0, adminLockUntil = 0
async function admin(password: unknown) {
  const real = Deno.env.get("ADMIN_PASSWORD")
  if (!real) throw new Fail("Панель розробника вимкнена: додай секрет ADMIN_PASSWORD у Supabase", 403)
  if (adminLockUntil > Date.now()) throw new Fail("Забагато спроб, зачекай 10 хв", 429)
  if (password !== real) {
    if (++adminFails >= 5) { adminLockUntil = Date.now() + 10 * 60e3; adminFails = 0 }
    throw new Fail("Неправильний пароль адміна", 403, "BAD_ADMIN")
  }
  adminFails = 0
}
/** "YYYY-MM-DD" from the panel → noon Warsaw-ish that day; empty → now */
const atTime = (d: unknown) => {
  const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 11) : Date.now()
}

const activeOf = (s: State, pid: string) => s.assignments.find(a => a.playerId === pid && a.status === "active")

/** Random completable game that every listed player can get and none of them has had before */
async function pickGame(s: State, ps: Player[], skip: number[] = []): Promise<Game> {
  const mod = modFor(s, monthKey(Date.now()))
  const busy = new Set([...s.assignments.filter(a => a.status === "active").map(a => a.appid), ...skip])
  const had = new Set(s.assignments.filter(a => ps.some(p => p.id === a.playerId)).map(a => a.appid))
  let pool = Object.values(s.games).filter(g => !g.excluded && ps.every(p => eligible(g, p.steamId)) && !busy.has(g.appid) && !had.has(g.appid))
  if (mod.filter) pool = pool.filter(g => (g as any).needsMeta || mod.filter!(g))
  if (!pool.length) throw new Fail(mod.filter ? `Під модифікатор «${mod.name}» не лишилось ігор` : "Пул ігор порожній")
  for (let tries = 0; tries < 8 && pool.length; tries++) {
    const i = Math.floor(Math.random() * pool.length)
    let c = pool[i] as Game & { needsMeta?: boolean }
    if (c.needsMeta) {
      c = computeGame(c.appid, await fetchMeta(c.appid, c.name), c.owners, c)
      s.games[String(c.appid)] = c
    }
    if (!c.excluded && (!mod.filter || mod.filter(c))) return c
    pool.splice(i, 1)  // turned out not completable / not matching the modifier
  }
  throw new Fail("Не вдалося знайти гру, спробуй ще раз", 400, undefined, true)
}

async function newAssignment(s: State, p: Player, g: Game, duelId?: string): Promise<Assignment> {
  const mod = modFor(s, monthKey(Date.now()))
  const mult = mod.mult?.(g) ?? 1
  const base = await playtime(p.steamId, g.appid).catch(() => null)
  const a: Assignment = {
    id: uid(), playerId: p.id, appid: g.appid, name: g.name, status: "active",
    rolledAt: Date.now(), baseline: base ?? 0, current: base ?? 0, tracked: base !== null,
    difficulty: g.difficulty, expectedHours: expected(g),
    ...(mult !== 1 ? { mult, modLabel: mod.name } : {}), ...(duelId ? { duelId } : {}),
  }
  s.assignments.push(a)
  return a
}

const candidates = (s: State, p: Player) =>
  Object.values(s.games).filter(g => !g.excluded && eligible(g, p.steamId)).sort(() => Math.random() - 0.5).slice(0, 40).map(x => ({ appid: x.appid, name: x.name }))

/** First finished duel game wins the bonus; if everyone quit, the duel ends without a winner */
function settleDuel(s: State, a: Assignment) {
  const d = (s.duels ?? []).find(x => x.id === a.duelId)
  if (!d || d.status !== "active") return
  if (a.status === "done" && !d.winner) {
    d.winner = a.playerId; d.status = "done"
    const other = s.players.find(p => p.id === (d.from === a.playerId ? d.to : d.from))
    s.bonuses ??= []
    s.bonuses.push({ id: uid(), playerId: a.playerId, points: s.settings.duelBonus, reason: `Перемога в дуелі з ${other?.nick ?? "?"} (${d.name})`, at: Date.now(), assignmentId: a.id })
  } else if (s.assignments.filter(x => x.duelId === d.id).every(x => x.status !== "active")) d.status = "done"
}

const rerollsUsed = (s: State, pid: string) =>
  s.assignments.filter(a => a.playerId === pid && a.status === "rerolled" && a.finishedAt && monthKey(a.finishedAt) === monthKey(Date.now())).length

const needsMeta = (g: Game) => !!(g as Game & { needsMeta?: boolean }).needsMeta
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let enriching = false

/** Fetch tags/categories for games added by new players, so the "not completable" filter
 *  applies before anyone rolls them. Works in time-boxed batches; the cron picks up the rest. */
async function enrich(budgetMs = 90_000) {
  if (enriching) return
  enriching = true
  try {
    const start = Date.now()
    const todo = Object.values((await load()).games).filter(needsMeta)
    const done: Record<string, Game> = {}
    for (const g of todo) {
      if (Date.now() - start > budgetMs) break
      try { done[g.appid] = computeGame(g.appid, await fetchMeta(g.appid, g.name), g.owners, g) } catch { /* retry next time */ }
      await sleep(1200) // Steam store rate limit
    }
    if (!Object.keys(done).length) return
    const fresh = await load() // merge into latest state (others may have rolled meanwhile)
    for (const [id, g] of Object.entries(done)) if (fresh.games[id]) fresh.games[id] = { ...g, owners: fresh.games[id].owners }
    await save(fresh)
  } finally { enriching = false }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? ""
  corsOrigin = ALLOWED.includes(origin) ? origin : ""
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() })
  const action = new URL(req.url).pathname.split("/").filter(Boolean).pop()
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {}
  const s = await load()
  const enrichLater = () => {
    if (Object.values(s.games).some(needsMeta)) EdgeRuntime.waitUntil(enrich().catch(() => {}))
  }
  // any registered player with a PIN may change shared things (rules, pool…)
  const anyone = () => auth(s, body.playerId, body.pin)

  try {
    switch (action) {
      case "state":
        return json(publicState(s))

      // ---------- PIN ----------
      case "set-pin": {  // first PIN for players who joined before PINs existed
        const p = s.players.find(x => x.id === body.playerId)
        if (!p) return err("Гравця не знайдено")
        if (p.pinHash) return err("PIN уже встановлено")
        if (!validPin(body.pin)) return err("PIN — це 4–6 цифр")
        p.pinHash = await pinHash(p.id, body.pin)
        await save(s)
        return json({ ok: true, state: publicState(s) })
      }
      case "login": {
        await auth(s, body.playerId, body.pin)
        await save(s)
        return json({ ok: true })
      }
      case "change-pin": {
        const p = await auth(s, body.playerId, body.pin)
        if (!validPin(body.newPin)) return err("PIN — це 4–6 цифр")
        p.pinHash = await pinHash(p.id, body.newPin)
        await save(s)
        return json({ ok: true })
      }
      case "reset-pin": {  // a friend vouches with their own PIN
        const by = await auth(s, body.byId, body.byPin)
        const p = s.players.find(x => x.id === body.playerId)
        if (!p) return err("Гравця не знайдено")
        if (p.id === by.id) return err("Скинути PIN може тільки інший гравець")
        p.pinHash = undefined; p.pinFails = 0; p.pinLockUntil = undefined
        await save(s)
        return json({ ok: true, state: publicState(s) })
      }

      case "join": {
        const nick = String(body.nick ?? "").trim().slice(0, 24)
        if (!nick) return err("Впиши нік")
        const steamId = await resolveSteamId(String(body.steam ?? ""))
        const sum = await summary(steamId)
        if (!sum.public) return err("Профіль Steam закритий — відкрий його в налаштуваннях приватності")
        let p = s.players.find(x => x.steamId === steamId)
        if (p?.pinHash) await auth(s, p.id, body.pin)
        else if (!validPin(body.pin)) return err("Придумай PIN — 4–6 цифр")
        if (p) { p.nick = nick; p.persona = sum.persona; p.avatar = sum.avatar }
        else { p = { id: uid(), nick, steamId, persona: sum.persona, avatar: sum.avatar, joinedAt: Date.now() }; s.players.push(p) }
        if (!p.pinHash) p.pinHash = await pinHash(p.id, body.pin)
        s.libraries = (s.libraries ?? []).filter(l => l.steamId !== steamId)  // now a player
        const count = await addOwnedToPool(s, steamId)
        await save(s)
        enrichLater()
        const { pinHash: _h, ...pub } = p
        return json({ player: pub, gamesAdded: count, state: publicState(s) })
      }

      // ---------- rolling ----------
      case "roll": {
        const p = await auth(s, body.playerId, body.pin)
        if (activeOf(s, p.id)) return err("У тебе вже є активна гра — пройди її або здайся")
        const g = await pickGame(s, [p])
        const a = await newAssignment(s, p, g)
        await save(s)
        return json({ assignment: a, candidates: candidates(s, p), state: publicState(s) })
      }

      case "reroll": {
        const p = await auth(s, body.playerId, body.pin)
        const old = activeOf(s, p.id)
        if (!old) return err("Немає активної гри")
        if (old.duelId) return err("У дуелі ре-рол заборонено")
        const allowed = s.settings.rerollsPerMonth * (modFor(s, monthKey(Date.now())).rerolls ?? 1)
        if (rerollsUsed(s, p.id) >= allowed) return err(`Ре-роли на цей місяць закінчились (${allowed})`)
        const g = await pickGame(s, [p], [old.appid])
        old.status = "rerolled"; old.finishedAt = Date.now()
        old.points = -s.settings.rerollPenalty; old.breakdown = `Ре-рол: −${s.settings.rerollPenalty}`
        const a = await newAssignment(s, p, g)
        await save(s)
        return json({ assignment: a, candidates: candidates(s, p), state: publicState(s) })
      }

      case "import": {  // one-time: only while the table is still empty
        if (await hasState()) return err("Дані вже перенесено")
        const st = await importFrom("https://steam-challenge-family.netlify.app/api/state")
        await save(st)
        if (Object.values(st.games).some(needsMeta)) EdgeRuntime.waitUntil(enrich().catch(() => {}))
        return json({ ok: true, players: st.players.length, games: Object.keys(st.games).length })
      }

      case "cron": {  // called by pg_cron every 30 minutes
        const daily = Date.now() - (s.lastLibraryRefresh ?? 0) > 24 * 3600e3
        if (daily) await refreshLibraries(s)   // pick up newly bought games once a day
        if (s.assignments.some(a => a.status === "active")) await syncActive(s)
        await save(s)
        if (Object.values(s.games).some(needsMeta)) await enrich(100_000)
        return json({ ok: true })
      }

      case "sync": {
        await syncActive(s)
        await save(s)
        return json(publicState(s))
      }

      case "finish": {
        const a = s.assignments.find(x => x.id === body.id && x.status === "active")
        if (!a) return err("Активну гру не знайдено")
        const p = await auth(s, a.playerId, body.pin)
        const m = await playtime(p.steamId, a.appid).catch(() => null)
        if (m !== null) { a.current = Math.max(a.current, m); a.tracked = true }
        if (body.giveUp) {
          a.status = "gaveup"; a.points = -s.settings.giveUpPenalty; a.breakdown = `Здався: −${s.settings.giveUpPenalty}`
        } else {
          if (!a.tracked && a.manualMinutes === undefined && body.manualHours === undefined)
            return err("Steam не бачить час у цій грі — впиши години вручну")
          if (a.tracked && a.manualMinutes === undefined && body.manualHours === undefined && a.current - a.baseline < 6)
            return err("Steam показує, що ти майже не грав у цю гру. Пограй або впиши години вручну")
          if (body.manualHours !== undefined) {
            a.manualMinutes = Math.round(Number(body.manualHours) * 60)
            a.manualOk = s.players.length < 2; a.confirmedBy = undefined
          }
          a.status = "done"
          Object.assign(a, scoreFor(a, s.settings))
        }
        a.finishedAt = Date.now()
        settleDuel(s, a)
        await save(s)
        return json(publicState(s))
      }

      case "manual": {
        const a = s.assignments.find(x => x.id === body.id)
        if (!a) return err("Не знайдено")
        await auth(s, a.playerId, body.pin)
        if (body.hours === null || body.hours === "") { a.manualMinutes = undefined; a.manualOk = undefined; a.confirmedBy = undefined }
        else {
          a.manualMinutes = Math.round(Number(body.hours) * 60)
          a.manualOk = s.players.length < 2; a.confirmedBy = undefined
        }
        if (a.status === "done") Object.assign(a, scoreFor(a, s.settings))
        await save(s)
        return json(publicState(s))
      }

      case "confirm": {  // a friend confirms (ok) or rejects manually entered hours
        const by = await auth(s, body.playerId, body.pin)
        const a = s.assignments.find(x => x.id === body.id)
        if (!a || a.manualMinutes === undefined) return err("Немає годин на підтвердження")
        if (a.playerId === by.id) return err("Свої години підтверджують друзі")
        if (body.ok) { a.manualOk = true; a.confirmedBy = by.id }
        else {
          a.manualMinutes = undefined; a.manualOk = undefined; a.confirmedBy = undefined
          if (a.status === "done") {
            s.bonuses = (s.bonuses ?? []).filter(b => b.assignmentId !== a.id)
            if (activeOf(s, a.playerId)) {  // already playing something else → this one scores 0
              a.status = "gaveup"; a.points = 0; a.breakdown = "Години відхилено другом: 0"; a.speed = undefined
            } else {  // back to active: finish again with real Steam time or new hours
              a.status = "active"; a.points = a.breakdown = a.finishedAt = a.speed = undefined
            }
            const d = (s.duels ?? []).find(x => x.id === a.duelId)
            if (d && d.winner === a.playerId) {
              d.winner = undefined; d.status = "active"
              const rival = s.assignments.find(x => x.duelId === d.id && x.id !== a.id && x.status === "done")
              if (rival) settleDuel(s, rival)   // the rival had finished too → the win is theirs now
              else if (a.status !== "active") settleDuel(s, a)
            }
          }
        }
        await save(s)
        return json(publicState(s))
      }

      // ---------- duels ----------
      case "duel-challenge": {
        const p = await auth(s, body.playerId, body.pin)
        const to = s.players.find(x => x.id === body.to)
        if (!to || to.id === p.id) return err("Обери суперника")
        if (activeOf(s, p.id)) return err("Спочатку пройди або здай свою активну гру")
        s.duels ??= []
        if (s.duels.some(d => d.status === "pending" && [d.from, d.to].includes(p.id) && [d.from, d.to].includes(to.id)))
          return err("Виклик уже надіслано")
        s.duels.push({ id: uid(), from: p.id, to: to.id, status: "pending", createdAt: Date.now() })
        await save(s)
        return json(publicState(s))
      }
      case "duel-accept": {
        const p = await auth(s, body.playerId, body.pin)
        const d = (s.duels ?? []).find(x => x.id === body.duelId && x.status === "pending")
        if (!d || d.to !== p.id) return err("Виклик не знайдено")
        const from = s.players.find(x => x.id === d.from)
        if (!from) return err("Суперника вже немає")
        if (activeOf(s, p.id)) return err("Спочатку пройди або здай свою активну гру")
        if (activeOf(s, from.id)) return err(`${from.nick} зараз грає іншу гру — прийми виклик, коли він її закінчить`)
        const g = await pickGame(s, [from, p])
        d.status = "active"; d.appid = g.appid; d.name = g.name
        await newAssignment(s, from, g, d.id)
        const a = await newAssignment(s, p, g, d.id)
        await save(s)
        return json({ assignment: a, candidates: candidates(s, p), state: publicState(s) })
      }
      case "duel-decline": {
        const p = await auth(s, body.playerId, body.pin)
        const d = (s.duels ?? []).find(x => x.id === body.duelId && x.status === "pending")
        if (!d || (d.to !== p.id && d.from !== p.id)) return err("Виклик не знайдено")
        d.status = "declined"
        await save(s)
        return json(publicState(s))
      }

      // ---------- month ----------
      case "mod": {
        await anyone()
        const month = monthKey(Date.now())
        s.mods ??= {}
        if (body.mod === "random") {
          if (s.mods[month]) return err("Модифікатор цього місяця вже обрано")
          const pool = MODS.filter(m => m.id !== "none")
          s.mods[month] = pool[Math.floor(Math.random() * pool.length)].id
        } else {
          if (!MODS.some(m => m.id === body.mod)) return err("Невідомий модифікатор")
          s.mods[month] = body.mod
        }
        await save(s)
        return json(publicState(s))
      }
      case "note": {
        await anyone()
        if (!/^\d{4}-\d{2}$/.test(String(body.month))) return err("Невідомий місяць")
        s.notes ??= {}
        s.notes[body.month] = String(body.text ?? "").slice(0, 120)
        await save(s)
        return json(publicState(s))
      }

      // ---------- developer panel (site admin, password in Supabase secret ADMIN_PASSWORD) ----------
      case "admin-check": {
        await admin(body.password)
        return json({ ok: true })
      }
      case "admin-points": {  // add or take away points
        await admin(body.password)
        const p = s.players.find(x => x.id === body.target)
        const pts = Math.round(Number(body.points))
        if (!p) return err("Гравця не знайдено")
        if (!pts) return err("Вкажи кількість балів (можна з мінусом)")
        s.bonuses ??= []
        s.bonuses.push({ id: uid(), playerId: p.id, points: pts, reason: String(body.reason || "Від адміна").slice(0, 120), at: atTime(body.date) })
        await save(s)
        return json(publicState(s))
      }
      case "admin-game": {  // count a game finished outside the site, scored by the normal formula
        await admin(body.password)
        const p = s.players.find(x => x.id === body.target)
        const g = s.games[String(body.appid)]
        const hours = Number(body.hours)
        if (!p) return err("Гравця не знайдено")
        if (!g) return err("Гру не знайдено в пулі")
        if (!(hours > 0)) return err("Вкажи години")
        const at = atTime(body.date)
        const a: Assignment = {
          id: uid(), playerId: p.id, appid: g.appid, name: g.name, status: "done",
          rolledAt: at, finishedAt: at, baseline: 0, current: 0, tracked: false,
          manualMinutes: Math.round(hours * 60), manualOk: true, confirmedBy: "admin",
          difficulty: g.difficulty, expectedHours: expected(g),
        }
        const sc = scoreFor(a, s.settings)
        Object.assign(a, sc, { breakdown: "Зараховано адміном: " + sc.breakdown })
        if (body.preview) return json({ preview: a })
        s.assignments.push(a)
        await save(s)
        return json(publicState(s))
      }
      case "admin-remove": {  // undo a bonus or a finished/given-up game entry
        await admin(body.password)
        const before = (s.bonuses ?? []).length + s.assignments.length
        s.bonuses = (s.bonuses ?? []).filter(b => b.id !== body.id)
        s.assignments = s.assignments.filter(a => !(a.id === body.id && a.status !== "active"))
        if ((s.bonuses.length + s.assignments.length) === before) return err("Запис не знайдено")
        await save(s)
        return json(publicState(s))
      }
      case "admin-reset-pin": {
        await admin(body.password)
        const p = s.players.find(x => x.id === body.target)
        if (!p) return err("Гравця не знайдено")
        p.pinHash = undefined; p.pinFails = 0; p.pinLockUntil = undefined
        await save(s)
        return json(publicState(s))
      }

      // ---------- shared settings (any player's PIN) ----------
      case "game": {
        await anyone()
        const g = s.games[String(body.appid)]
        if (!g) return err("Гру не знайдено")
        if (typeof body.excluded === "boolean") { g.excluded = body.excluded; g.excludedManual = body.excluded }
        if (body.expectedHours !== undefined) g.expectedOverride = body.expectedHours === null ? undefined : Number(body.expectedHours)
        if (body.difficulty !== undefined) {
          g.difficultyOverride = body.difficulty === null ? undefined : Math.max(1, Math.min(3, Number(body.difficulty)))
          s.games[String(g.appid)] = computeGame(g.appid, g, g.owners, g)
        }
        await save(s)
        return json(publicState(s))
      }

      case "settings": {
        await anyone()
        const v = body.values ?? {}
        for (const k of Object.keys(s.settings) as (keyof State["settings"])[])
          if (v[k] !== undefined && !isNaN(Number(v[k]))) s.settings[k] = Number(v[k])
        await save(s)
        return json(publicState(s))
      }

      case "add-library": {
        await anyone()
        const steamId = await resolveSteamId(String(body.steam ?? ""))
        const sum = await summary(steamId)
        if (!sum.public) return err("Профіль Steam закритий")
        s.libraries ??= []
        if (!s.libraries.some(l => l.steamId === steamId) && !s.players.some(p => p.steamId === steamId))
          s.libraries.push({ steamId, persona: sum.persona, addedAt: Date.now() })
        const count = await addOwnedToPool(s, steamId)
        await save(s)
        enrichLater()
        return json({ gamesAdded: count, state: publicState(s) })
      }

      case "refresh-libraries": {
        await refreshLibraries(s)
        await save(s)
        enrichLater()
        return json(publicState(s))
      }

      case "remove-player": {
        await anyone()
        const id = body.target
        s.players = s.players.filter(p => p.id !== id)
        s.assignments = s.assignments.filter(a => a.playerId !== id)
        s.bonuses = (s.bonuses ?? []).filter(b => b.playerId !== id)
        s.duels = (s.duels ?? []).filter(d => d.from !== id && d.to !== id)
        await save(s)
        return json(publicState(s))
      }

      default:
        return err("Unknown action", 404)
    }
  } catch (e: any) {
    if (e instanceof Fail) {
      if (e.dirty) await save(s).catch(() => {})   // keep wrong-PIN counters / fetched metadata
      return err(e.message, e.status, e.code ? { code: e.code } : {})
    }
    return err(e?.message ?? "Помилка сервера", 500)
  }
})
