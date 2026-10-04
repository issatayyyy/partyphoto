# Развёртывание на VPS

Это инструкция для будущего выпуска. Текущий каркас не реализует функционал сервиса.
Необходимы VPS с Docker Compose 2.24.4+, Nginx/Certbot, домен и приватный S3 bucket.

1. DNS: `A photos → IPv4 сервера`; `AAAA` добавлять только при рабочем IPv6.
   Для алиаса `CNAME www → photos.example.com`. Для `slug.photos.example.com`
   нужна `CNAME * → photos.example.com` в зоне photos или wildcard A.
   Сам DNS не реализует маршрутизацию альбомов — потребуется разбор Host в приложении.
2. На сервере склонировать репозиторий. Создать `.env` из `.env.example`,
   установить уникальные случайные пароли, production APP_URL и S3 credentials
   с доступом только к bucket проекта. URL-кодировать пароль внутри DATABASE_URL;
   для Compose-интерполяции удобнее использовать случайный hex-пароль.
3. Перед релизом создать, проверить и закоммитить миграции и package-lock.json.
   Запуск миграций отдельным release шагом (`npm run db:deploy`) с установленными
   devDependencies и DATABASE_URL для сервера. Перед миграцией сделать backup.
4. Собрать и запустить:

   ```bash
   docker compose -f compose.yaml -f compose.production.yaml up -d --build app
   ```

   Postgres доступен только на loopback; managed S3 заменяет локальный MinIO.
   Приложение доступно Nginx на `127.0.0.1:3000`. Проверить `/api/health`.
   Сейчас это только liveness, не проверка готовности БД/хранилища.
5. Заменить домен в `infra/nginx/partyphoto.conf`, установить файл в
   `/etc/nginx/sites-available/partyphoto`, включить через `sites-enabled`.
   Для дистрибутивов без sites-enabled использовать `/etc/nginx/conf.d/`.
   Проверить `sudo nginx -t`, затем перезагрузить Nginx.
6. Открыть TCP 80/443, выполнить:

   ```bash
   sudo certbot --nginx -d photos.example.com --redirect
   sudo certbot renew --dry-run
   ```

   Certbot добавит SSL-конфигурацию и HTTP→HTTPS redirect. Проверить timer
   автоматического обновления. Для wildcard сертификата нужен DNS-01 challenge
   с плагином DNS-провайдера; HTTP-01 для wildcard не подходит.
7. Настроить ежедневные зашифрованные резервные копии Postgres во внешнее хранилище,
   retention, S3 versioning/lifecycle и тест восстановления. Docker volume не backup.
   Добавить мониторинг HTTP/readiness, свободного диска, ошибок и очереди worker.
8. До выпуска проверить: создание события → QR → пароль → bulk upload →
   модерация → гостевой просмотр → original/ZIP → отзыв доступа → expiry.

Откат: предыдущий образ приложения; совместимые миграции expand/contract.
Не откатывать схему вслепую, удаляя пользовательские данные.
