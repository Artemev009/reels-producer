# Reels Finder

Рабочий MVP сервиса для сбора Reels конкурентов, подготовки ремиксов и хранения сценариев.

## Архитектура

```text
Browser UI → Express REST API → PostgreSQL
                         ├── Apify (асинхронный импорт Reels)
                         ├── PostgreSQL BYTEA (короткий бесплатный демо-кеш)
                         └── Cloudflare R2 (постоянные видео и обложки, опционально)
```

- `public/` — интерфейс без сборщика;
- `src/app.js` — REST API;
- `src/apify.js` — асинхронная интеграция с Apify и нормализация Dataset;
- `src/storage.js` — S3-совместимое хранение медиа в Cloudflare R2;
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

### Полностью локальная копия на компьютере

После установки Docker Desktop проект можно поднять вместе с отдельным PostgreSQL, данные которого остаются на компьютере между перезапусками:

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

Локальный сайт будет доступен только с этого компьютера по адресу `http://127.0.0.1:3000`. PostgreSQL хранится в Docker volume `reels_finder_data`; обычная команда `docker compose down` его не удаляет. Не используйте `docker compose down -v`, если хотите сохранить данные.

### Резервная копия Render на компьютер

Полная копия включает SQL-данные, сценарии, метрики, обложки и все видео, ссылки на которые ещё доступны:

```powershell
npm run backup -- https://reels-finder.onrender.com
```

Скрипт запросит пароль владельца и создаст папку `backups/<дата>/`. Папка исключена из Git и остаётся только на компьютере. Для восстановления в локальную или новую опубликованную установку:

```powershell
npm run restore -- "backups/<дата>" http://127.0.0.1:3000
```

Перед восстановлением целевая база очищается. Поэтому сначала всегда создавайте свежую копию текущей базы.

## API

- `GET/POST /api/competitors`
- `POST /api/competitors/:id/sync`
- `GET /api/sync-runs/:id`
- `GET /api/reels`
- `GET /api/export/reels.csv`
- `GET /api/admin/backup`
- `POST /api/admin/restore`
- `POST /api/admin/media/:reelId/:kind`
- `POST /api/reels/:id/cache-media`
- `GET/PATCH/DELETE /api/reels/:id`
- `GET /api/media/:reelId/:kind`
- `GET/POST /api/scripts`
- `PATCH/DELETE /api/scripts/:id`
- `GET /health`

Все данные приложения хранятся в PostgreSQL. API использует параметризованные SQL-запросы.

Публичный стенд можно просматривать без входа. Если задан `ADMIN_PASSWORD`, все изменяющие запросы (`POST`, `PATCH`, `DELETE`) и создание резервной копии доступны только владельцу после входа через интерфейс. Для подписи уникальных 12-часовых HttpOnly-сессий задайте отдельный длинный `ADMIN_SESSION_SECRET`.

## Apify

В окружении сервера нужно задать:

- `APIFY_API_TOKEN` — секретный токен;
- `APIFY_ACTOR_ID` — идентификатор Actor. По умолчанию используется официальный `apify/instagram-reel-scraper`.

После этого кнопка синхронизации создаёт фоновую задачу, запускает Actor, получает до 20 записей из Dataset и делает UPSERT в таблицу `reels`. Интерфейс показывает состояния `queued`, `running`, `importing`, `succeeded`, `partial` и `failed`.

Чтобы публичный тестовый стенд не расходовал бесплатные лимиты Apify из-за случайных повторов, сервер разрешает не более 3 импортов в час, 10 в сутки и выдерживает паузу 10 минут для одного аккаунта. Также стенд ограничен 10 конкурентами и 200 сценариями. Значения можно менять через переменные окружения `SYNC_HOURLY_LIMIT`, `SYNC_DAILY_LIMIT`, `SYNC_COOLDOWN_MINUTES`, `COMPETITOR_LIMIT` и `SCRIPT_LIMIT`.

Hook, основной текст и CTA формируются из описания Reel без платного AI. Если явный призыв к действию не найден, редактор показывает понятную подсказку вместо пустого блока.

По умолчанию до 5 рилсов кешируются в PostgreSQL, чтобы тестовый стенд не зависел от истекающих Instagram CDN-ссылок. Владелец может закрепить другое видео прямо на странице рилса: самое старое из пяти сохранённых видео вернётся к внешней ссылке, а выбранное займёт его место. Это намеренно ограниченный временный вариант для демонстрации, а не долговременное медиахранилище. Лимиты регулируются переменными `DATABASE_MEDIA_REELS_LIMIT`, `DATABASE_MEDIA_TOTAL_BYTES` и `DATABASE_MEDIA_VIDEO_MAX_BYTES`.

CSV-экспорт всех рилсов доступен из раздела конкурентов и не требует платных сервисов.

Для постоянного хранения видео и обложек задайте параметры Cloudflare R2:

- `R2_ACCOUNT_ID`;
- `R2_ACCESS_KEY_ID`;
- `R2_SECRET_ACCESS_KEY`;
- `R2_BUCKET`;
- `R2_PUBLIC_BASE_URL`.

Без полного набора R2-переменных остальные рилсы продолжают использовать внешние ссылки и предупреждают, что ссылка источника может истечь.

## Render

`render.yaml` описывает бесплатный Docker-сервис и PostgreSQL. `DATABASE_URL` передаётся серверу через приватное подключение Render. Изменения `main` автоматически запускают новый деплой.

Бесплатная Render PostgreSQL истекает через 30 дней и не имеет резервных копий. Команда `npm run backup` является обязательной страховкой: архив можно восстановить в новый Render Postgres, локальный Docker или любой PostgreSQL-совместимый хостинг.
