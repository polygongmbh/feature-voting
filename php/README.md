# PHP-Port für Hosting ohne Node und Docker (z.B. HestiaCP)

Betrieb des gemeinsamen Frontends aus `public/` mit einem PHP-Backend statt `server.js`.
Nicht hier: Bedienung, `config.json`, Wertung, Datenschutz (siehe `../README.md`), Node-Deployment (siehe `../CLAUDE.md`).

## Unterschiede zur Node-Version

- Backend ist `api.php` (PHP >= 8.1 mit `pdo_sqlite`), Wertung und Validierung spiegeln `server.js`
- Live-Ansicht holt alle 2 s neue Daten (Polling) statt SSE,
  weil lange offene Verbindungen PHP-FPM-Worker blockieren
- Live-Ansicht heißt `live.html?token=…` statt `/live`,
  CSV-Export `api.php?a=export&token=…`
- Admin-Token steht in `private/feature-voting/admin-token`
  (oder Umgebungsvariable `FV_ADMIN_TOKEN`), nicht in `.env`
- Rate-Limit über gehashte IPs in SQLite, nach 10 Minuten gelöscht,
  weil PHP keinen Arbeitsspeicher zwischen Requests teilt

Das Frontend wird nicht kopiert gepflegt:
`build.sh` setzt `<meta name="fv-backend" content="php">`,
`public/backend.js` schaltet daran Endpunkte und Transport um.

## Bauen

```bash
npm install          # einmalig, für SortableJS
php/build.sh         # erzeugt php/dist/, beim ersten Mal mit neuem Admin-Token
```

```
php/dist/
  public_html/                -> /home/USER/web/DOMAIN/public_html/
  private/feature-voting/     -> /home/USER/web/DOMAIN/private/feature-voting/
    config.json               Kopie der config.json aus dem Repo-Root
    admin-token               bleibt bei erneutem Build erhalten
    data/responses.db         entsteht auf dem Server beim ersten Aufruf
```

Lokal testen:
`php -S 127.0.0.1:8000 -t php/dist/public_html`,
dann `/` und `/live.html?token=…`.

## Auf HestiaCP installieren

1. Web-Domain anlegen, Let's Encrypt aktivieren,
   PHP-Backend-Template mit PHP 8.1 oder neuer wählen.
2. SQLite prüfen: `php8.3 -m | grep pdo_sqlite` (Version anpassen).
   Falls leer: `apt install php8.3-sqlite3 && systemctl restart php8.3-fpm`.
3. Hestia-Standardseite entfernen und hochladen:
   ```bash
   ssh SERVER rm /home/USER/web/DOMAIN/public_html/index.html
   rsync -av --delete php/dist/public_html/ SERVER:/home/USER/web/DOMAIN/public_html/
   rsync -av --exclude data php/dist/private/feature-voting SERVER:/home/USER/web/DOMAIN/private/
   ```
4. Rechte setzen:
   ```bash
   chown -R USER:USER /home/USER/web/DOMAIN/public_html /home/USER/web/DOMAIN/private/feature-voting
   chmod 750 /home/USER/web/DOMAIN/private/feature-voting
   ```
5. Testen:
   ```bash
   curl https://DOMAIN/api.php?a=config
   curl "https://DOMAIN/api.php?a=stats&token=TOKEN"
   ```

`config.json` lässt sich auf dem Server direkt ändern, sie wird bei jedem Request neu gelesen.
Beim nächsten Upload aus dem Repo wird sie überschrieben.

Kommt `config.json nicht gefunden`:
`open_basedir` des PHP-FPM-Pools erlaubt den `private`-Ordner nicht.
Dann den Pfad im Pool (`/etc/php/8.x/fpm/pool.d/DOMAIN.conf`) ergänzen
oder `FV_PRIVATE_DIR` auf einen erlaubten Ordner setzen.
