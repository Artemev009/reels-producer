# Reels Finder

Минимальный веб-проект для будущего сервиса Reels Producer.

## Локальный запуск

Без Docker:

```powershell
npx --yes serve . -l 3000
```

После запуска страница доступна по адресу `http://localhost:3000`.

С Docker:

```powershell
docker build -t reels-finder .
docker run --rm -e PORT=8080 -p 8080:8080 reels-finder
```

Страница будет доступна по адресу `http://localhost:8080`.

## Публикация

Файл `render.yaml` описывает бесплатный Docker-сервис Render. Изменения ветки `main` автоматически запускают новую сборку и деплой.
