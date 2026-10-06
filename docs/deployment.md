# Развёртывание на VPS

Это инструкция для будущего публичного выпуска. Авторизация, события, загрузка,
галерея, оригиналы, модерация, лайки и ZIP реализованы локально. Полный Docker runtime и
развёртывание на домене пока не проверены; сбор просмотров ещё не реализован.
Необходимы VPS с Docker Compose 2.24.4+, Nginx/Certbot, домен и приватный S3 bucket.

1. DNS: `A photos → IPv4 сервера`; `AAAA` добавлять только при рабочем IPv6.
   Для алиаса `CNAME www → photos.example.com`. Для `slug.photos.example.com`
   нужна `CNAME * → photos.example.com` в зоне photos или wildcard A.
   Сам DNS не реализует маршрутизацию альбомов — потребуется разбор Host в приложении.
2. На сервере склонировать репозиторий. Создать `.env` из `.env.example`,
   установить уникальные случайные пароли, `APP_URL=https://photos.example.com` и S3 credentials
   с доступом только к bucket проекта. URL-кодировать пароль внутри DATABASE_URL;
   для Compose-интерполяции удобнее использовать случайный hex-пароль.
   S3 permissions для приложения/worker: операции чтения, записи и удаления
   объектов, `ListBucket`, `ListBucketMultipartUploads` и `AbortMultipartUpload`.
   Bucket остаётся приватным. Задать подходящие `MAX_ZIP_BYTES` и `MAX_ZIP_PHOTOS`
   (по умолчанию 1 ГБ оригиналов и 10000 фото); временные ZIP занимают дополнительное
   место вне квоты оригиналов/превью альбома и действуют час с постановки в очередь.
3. Перед релизом создать, проверить и закоммитить миграции и package-lock.json.
   Запуск миграций отдельным release шагом (`npm run db:deploy`) с установленными
   devDependencies и DATABASE_URL для сервера. Перед миграцией сделать backup.
4. Собрать и запустить:

   ```bash
   docker compose -f compose.yaml -f compose.production.yaml up -d --build app worker
   ```

   Postgres доступен только на loopback; managed S3 заменяет локальный SeaweedFS.
   Приложение доступно Nginx на `127.0.0.1:3000`. Проверить `/api/health`.
   Сейчас это только liveness, не проверка готовности БД/хранилища.
   `worker` использует тот же образ, внутренний Postgres и managed S3 endpoint;
   он не открывает HTTP-порт. Проверить `docker compose -f compose.yaml -f compose.production.yaml logs worker`:
   worker должен работать, обрабатывать ZIP и повторять ошибки очистки.
   Следить за DELETING и истёкшими PROCESSING: при отсутствии worker они удерживают квоту.
   Проверить QUEUED/RUNNING ZIP, попытки, зависшие lease и очистку архивов/частей
   multipart upload. После подтверждённой очистки истёкшего ZIP список фото удаляется,
   а небольшая запись задачи хранится до 7 дней. Недействительные архивы также удаляются.
   Оригиналы и превью выдаёт приложение через свой API, публичный S3 endpoint
   для браузера не требуется. Bucket должен оставаться приватным.
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
   модерация → гостевой просмотр/лайки → original → ZIP/прогресс → отзыв доступа →
   expiry → очистка worker. Выполнить `test:engagement` вместе с проверками auth/events/media/ui,
   затем повторить сценарий на реальном домене и с production S3.

Откат: предыдущий образ приложения; совместимые миграции expand/contract.
Не откатывать схему вслепую, удаляя пользовательские данные.
