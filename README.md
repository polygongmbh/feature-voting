# Feature-Voting

Kleine selbst gehostete Umfrage-App: Teilnehmende ziehen die Zeilen einer flachen, vertikalen Liste in die Abschnitte **Das will ich! / Das wäre nett / Brauche ich nicht** (die ganze Zeile ist ziehbar, auf dem Handy kurz halten; Antippen öffnet weitere Optionen). Alle Features starten in der Mitte ("Das wäre nett"), für alle in einer eigenen, zufälligen Reihenfolge, damit die Position die Wertung nicht beeinflusst. Teilnehmende können eigene Ideen ergänzen und optional Name und E-Mail angeben. Am Ende gibt es den TestFlight-Link. Für dich gibt es eine Live-Auswertung im Mentimeter-Stil.

- Node >= 22.13, SQLite eingebaut (`node:sqlite`), einzige Abhängigkeit: SortableJS
- Deutsch und Englisch (Umschalter oben rechts, Sprache wird automatisch erkannt)
- Hell und dunkel, mobil optimiert, Tastatur-bedienbar
- Keine externen Requests (keine Google Fonts, kein CDN), also DSGVO-freundlich

## Seiten

| URL | Wofür |
| --- | --- |
| `/` | Die Umfrage |
| `/?lang=en` | Umfrage direkt auf Englisch |
| `/?reset` | Lokalen Entwurf und "schon abgestimmt" zurücksetzen (zum Testen) |
| `/live` | Live-Auswertung für den Beamer, öffentlich. Tabs: **Diagramm**, **Cluster**, **QR** (bildschirmfüllend QR-Code und Adresse der Umfrage; automatisch bis zur ersten Antwort, sonst Taste Q, Klick oder Esc geht zurück) und **Optionen** (Features bearbeiten, fragt nach dem Token). |
| `/live?token=DEIN_TOKEN` | Wie oben, Optionen ohne Nachfrage und zusätzlich mit CSV-Button |
| `/api/export.csv?token=DEIN_TOKEN` | Alle Antworten als CSV (öffnet sauber in Excel) |

Der Token schützt den CSV-Export (enthält Namen und E-Mail-Adressen) und das Bearbeiten der Optionen. Er wird nach dem Öffnen aus der Adresszeile entfernt.

## Anpassen: `config.json`

- `title`, `intro`, `privacy`: Texte, jeweils `de` und `en` (oder einfach ein String)
- `testflight.url`: dein TestFlight-Link, `testflight.text`: Text auf der Danke-Seite
- `features`: Liste mit `id` (kurz, eindeutig, nicht mehr ändern sobald Antworten da sind), `title` und `desc`
- `maxCustomIdeas`: wie viele eigene Ideen jemand hinzufügen darf

Änderungen an der `config.json` werden ohne Neustart übernommen. Sobald die Optionen im Tab **Optionen** der Live-Ansicht gespeichert wurden, gilt für `features` stattdessen `data/features.json`; die übrigen Texte kommen weiter aus der `config.json`. Beim Bearbeiten bleiben die `id`s bestehender Optionen erhalten, neue bekommen eine aus dem Titel. Neue Features landen bei Leuten mit gespeichertem Entwurf automatisch unter "Das wäre nett".

## Lokal starten

```bash
npm install
ADMIN_TOKEN=geheim node server.js
# Umfrage:  http://localhost:3000/
# Live:     http://localhost:3000/live
# CSV:      http://localhost:3000/api/export.csv?token=geheim
```

## Auf dem Server (Docker)

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 16)" > .env
mkdir -p data && sudo chown 1000:1000 data   # Container läuft als User "node"
docker compose up -d --build
```

Dahinter einen Reverse Proxy (Caddy, Traefik, nginx) mit HTTPS hängen. Für die Live-Ansicht wichtig: Der Proxy darf Server-Sent Events nicht puffern. Bei nginx:

```nginx
location /api/stream {
  proxy_pass http://127.0.0.1:3000;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

Caddy und Traefik brauchen dafür keine Extra-Einstellung.

## Wie gewertet wird

Pro Feature und Antwort:

- **Das will ich!** = 2 Punkte plus Positionsbonus (Platz 1 = +1, letzter Platz = +0,5)
- **Das wäre nett** = 1 Punkt
- **Brauche ich nicht** = -1 Punkt

Wer ein Feature nicht anfasst, wertet es also als "nett". Das ist bewusst neutral.

Der Durchschnitt wird auf **0 bis 100** umgerechnet. Im Cluster liegt jede Blase horizontal dort, wohin die Stimmen tendieren; die Größe zeigt, wie viele Leute das Feature einsortiert haben.

## Datenschutz

Gespeichert werden nur die Sortierung, eigene Ideen und die freiwilligen Angaben (Name, E-Mail, Sprache), keine IP-Adressen. Die IP wird nur kurz im Arbeitsspeicher für ein Rate-Limit (20 Antworten pro 10 Minuten) genutzt. Daten liegen in `data/responses.db`.
