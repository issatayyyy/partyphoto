# PartyPhoto

Сервис альбомов мероприятий. **Текущий этап: стартовый каркас, не готовый production.**
Есть стартовая адаптивная страница, liveness API, Prisma schema, S3 helper,
Dockerfile, локальный Compose и production override. Авторизация, галереи,
загрузка, worker и админ-панель ещё не реализованы. Миграций и проверенного
package-lock.json пока нет. Сборка и контейнеры в текущей среде не запускались.

## Стек

Next.js 16 / React 19 / TypeScript; PostgreSQL 17 + Prisma 6;
S3 API (локально MinIO, production R2/AWS S3); Sharp для превью;
PostgreSQL-очередь + отдельный Node worker; Docker Compose, Nginx, Certbot.
Prisma CLI и клиент закреплены на одной версии. Перед production необходимо
зафиксировать все зависимости lockfile и пройти проверку уязвимостей.

## Локальный запуск каркаса

Нужны Node.js 22 и Docker Compose 2.24.4+.

```bash
cp .env.example .env
npm install
docker compose up -d db storage
npm run db:validate
npm run db:migrate -- --name init
npm run dev
```

Открыть http://localhost:3000. MinIO console: http://localhost:9001.
Создать **приватный** bucket `partyphoto` через консоль с данными из `.env`.
Для запуска приложения в контейнере: `docker compose up -d --build`.
Пока миграции создаются отдельной командой выше; приложение не меняет схему при старте.
S3 helper сейчас предназначен для серверного использования. До выдачи локальных
signed URLs браузеру потребуется отдельный публичный S3 endpoint: имя `storage`
доступно только внутри Docker. В production managed S3 endpoint доступен браузеру.

```bash
npm run db:generate
npm run typecheck
npm run build
```

После успешной установки сохранить `package-lock.json`, заменить `npm install`
на `npm ci` в Dockerfile. Не коммитить `.env` и секреты.

## Структура

```text
src/app/                 Стартовая страница, layout, CSS, API health
src/lib/db.ts            Prisma client
src/lib/storage.ts       S3 client и краткоживущая ссылка на оригинал
prisma/schema.prisma     Модель данных
docs/architecture.md     Связи, права, потоки и этапы разработки
docs/deployment.md       VPS, DNS, TLS, резервное копирование
infra/nginx/             Конфигурация обратного прокси
compose.yaml             Локальная инфраструктура
compose.production.yaml  Настройки для managed S3
Dockerfile               Многоэтапная сборка Next.js
.env.example             Переменные окружения
```
