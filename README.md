# 🎲 Steam Челендж

Сайт для челенджу друзів із сімейною бібліотекою Steam: кожен ролить випадкову гру, сайт сам рахує час у грі через Steam API, нараховує бали за складність і швидкість проходження. Хто в кінці місяця має найменше балів — купує гру.

**Сайт:** https://iflafyi.github.io/steam-challenge/ (GitHub Pages, папка `docs/`)
**API/сервер:** https://steam-challenge-family.netlify.app (Netlify Functions + Blobs, тут же дзеркало сайту)

## Як це працює
- **Гравці** додаються з ніком і посиланням на профіль Steam (профіль і «Інформація про ігри» мають бути відкриті).
- **Пул ігор** — усі ігри учасників (Steam не віддає сімейну бібліотеку напряму, тому пул = об'єднання ігор усіх гравців). Онлайн-ігри (MMO, F2P, PvP) автоматично виключені, але їх можна повернути.
- **Час у грі** береться з `GetOwnedGames` + `GetRecentlyPlayedGames` кожні 30 хв (scheduled function) або кнопкою «Оновити». Якщо Steam не бачить гру (позичена через сім'ю) — можна вписати години вручну.
- **Складність 1–3**: теги SteamSpy (Souls-like, Difficult, Roguelike ↑; Casual, Cozy ↓) + рідкість ачівок.
- **Бали** = (10 × складність + 2 × √очікувані_год) × швидкість (0.7–1.5). Здатися = −5. Усе редагується на вкладці «Правила».

## Технічно
- `docs/index.html` — весь інтерфейс (GitHub Pages віддає його з `docs/`, запити йдуть на Netlify API)
- `netlify/functions/api.mts` — API (`/api/state`, `join`, `roll`, `sync`, `finish`, `manual`, `game`, `settings`, `remove-player`)
- `netlify/functions/sync-cron.mts` — автооновлення часу кожні 30 хв
- `netlify/lib/core.mts` — Steam API, формула складності і балів, сховище (Netlify Blobs)
- `data/meta.json` — передзібрані теги/медіанний час/ачівки для стартового пулу
- Ключ Steam API зберігається тільки в змінній оточення Netlify `STEAM_API_KEY` (не в коді).
