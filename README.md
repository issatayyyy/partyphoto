# PartyPhoto

Сервис альбомов мероприятий. **Текущий этап: база данных и авторизация организатора.**
Есть адаптивные страницы регистрации и входа, защищённый кабинет с профилем,
выход с отзывом сессии, liveness API, Prisma schema, S3 helper, Dockerfile,
локальный Compose и production override. События, галереи, загрузка, worker
и управление контентом ещё не реализованы. Зависимости установлены,
package-lock.json создан, TypeScript и сборка Next.js проверены. PostgreSQL подключён;
начальная миграция применена, запись/чтение связей и откат транзакции проверены.
Локальный MinIO пока не запущен: указанный готовый образ недоступен.

## Стек

Next.js 16 / React 19 / TypeScript; PostgreSQL 17 + Prisma 6;
S3 API (локально MinIO, production R2/AWS S3); Sharp для превью;
PostgreSQL-очередь + отдельный Node worker; Docker Compose, Nginx, Certbot.
Prisma CLI и клиент закреплены на одной версии. Перед production необходимо
устранить оставшиеся предупреждения npm audit в зависимостях Prisma.

## Локальный запуск каркаса

Нужны Node.js 22 и Docker Compose 2.24.4+.

```bash
# Только при первом запуске; существующий .env не перезаписывать.
cp -n .env.example .env
npm ci
docker compose up -d db
npm run db:validate
npm run db:deploy
npm run db:generate
npm run dev
```

Открыть http://localhost:3000. Если Docker требует системных прав, использовать
`sudo docker compose up -d db`. Пока запускается только БД: образ MinIO требует
замены, поэтому `docker compose up` без списка сервисов ещё не работает.
Сохранённые миграции применяются через `db:deploy`; новые изменения схемы
оформляются через `npm run db:migrate -- --name <change>`.
Приложение не меняет схему при старте.
S3 helper сейчас предназначен для серверного использования. До выдачи локальных
signed URLs браузеру потребуется отдельный публичный S3 endpoint: имя `storage`
доступно только внутри Docker. В production managed S3 endpoint доступен браузеру.

```bash
npm run db:generate
npm run typecheck
npm run build
```

Dockerfile устанавливает закреплённые зависимости через `npm ci`.
Не коммитить `.env` и секреты.

## Авторизация

Открыть http://localhost:3000/register, указать имя, email и пароль длиной
12–128 символов. Новый аккаунт получает роль `ORGANIZER` и автоматически
попадает в `/dashboard`. Для повторного входа: `/login`. Кнопка выхода удаляет
сессию в БД; кабинет без действующей сессии перенаправляет на вход.

`APP_URL` должен совпадать с адресом в браузере: `localhost` и `127.0.0.1`
считаются разными адресами. После изменения `.env` перезапустить dev-сервер.
Локально использовать `npm run dev`; для production (`npm start`) необходим
HTTPS в `APP_URL`. Это включает защищённые cookies и проверку Origin запросов.

Пароли хешируются Argon2id. В БД сохраняется SHA-256 хеш случайного токена
сессии, cookie имеет HttpOnly/SameSite=Lax и живёт 7 дней. Отключённые аккаунты
и истёкшие сессии теряют доступ. Лимит попыток хранится в PostgreSQL и действует
между процессами приложения: 10 входов на email за 15 минут, 5 регистраций
на email за час, 60 регистраций в час и 120 попыток в минуту на весь сервис.
Для public production лимиты нужно согласовать с нагрузкой и добавить
подтверждение email, восстановление пароля и управление аккаунтами.

Проверки выполняются с запущенным `npm run dev` и локальной БД:

```bash
npm run test:auth
# Браузерная проверка использует установленный Google Chrome.
npm run test:ui
```

Тесты создают и удаляют только собственные аккаунты с доменом `example.invalid`.
Проверки предназначены для локального HTTP-адреса и используют `.env` проекта.

## Структура

```text
src/app/                 Страницы, кабинет, CSS, API auth/health
src/components/          Формы входа/регистрации и выход
src/lib/auth*.ts         Сессии, проверка запросов, валидация и лимиты
src/lib/password.ts      Хеширование и проверка паролей
src/lib/db.ts            Prisma client
src/lib/storage.ts       S3 client и краткоживущая ссылка на оригинал
prisma/schema.prisma     Модель данных
prisma/migrations/       Начальная схема и лимит попыток входа
tests/                   HTTP/БД и браузерные проверки авторизации
docs/architecture.md     Связи, права, потоки и этапы разработки
docs/deployment.md       VPS, DNS, TLS, резервное копирование
infra/nginx/             Конфигурация обратного прокси
compose.yaml             Локальная инфраструктура
compose.production.yaml  Настройки для managed S3
Dockerfile               Многоэтапная сборка Next.js
.env.example             Переменные окружения
```
