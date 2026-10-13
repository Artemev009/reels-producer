# Reels Finder

Рабочий MVP сервиса для сбора Reels конкурентов, подготовки ремиксов и хранения сценариев.

## Архитектура

```text
Browser UI → Express REST API → PostgreSQL
                         ↘ Apify (после добавления токена)
```

- `public/` — интерфейс без сборщика;
- `src/app.js` — REST API;
- `src/apify.js` — подготовленная интеграция с Apify;
- `db/migrations/` — SQL-схема и начальные демонстрационные данные;
- `render.yaml` — Docker web service и связанный Render Postgres.

## Локальный запуск

Требуются Node.js 22+ и PostgreSQL.

```powershell
npm install
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/reels_finder"
$env:DB_SSL = "false"
npm start
```

Сервер сам применяет новые SQL-миграции. Интерфейс открывается по адресу `http://localhost:3000`.

## API

- `GET/POST /api/competitors`
- `POST /api/competitors/:id/sync`
- `GET /api/reels`
- `GET/PATCH/DELETE /api/reels/:id`
- `GET/POST /api/scripts`
- `PATCH/DELETE /api/scripts/:id`
- `GET /health`

Все данные приложения хранятся в PostgreSQL. API использует параметризованные SQL-запросы.

## Apify

В окружении сервера нужно задать:

- `APIFY_API_TOKEN` — секретный токен;
- `APIFY_ACTOR_ID` — идентификатор Actor. По умолчанию используется официальный `apify/instagram-reel-scraper`.

После этого кнопка синхронизации запускает Actor, получает до 20 записей из Dataset и делает UPSERT в таблицу `reels`.

## Render

`render.yaml` описывает бесплатный Docker-сервис и PostgreSQL. `DATABASE_URL` передаётся серверу через приватное подключение Render. Изменения `main` автоматически запускают новый деплой.
