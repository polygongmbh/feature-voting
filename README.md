# Feature-Voting

Kleine selbst gehostete Umfrage-App für beliebig viele Umfragen: Teilnehmende ziehen die Zeilen einer flachen, vertikalen Liste in die Abschnitte **Das will ich! / Das wäre nett / Brauche ich nicht** (die ganze Zeile ist ziehbar, auf dem Handy kurz halten; Antippen öffnet weitere Optionen). Alle Optionen starten in der Mitte ("Das wäre nett"), für alle in einer eigenen, zufälligen Reihenfolge, damit die Position die Wertung nicht beeinflusst. Teilnehmende können eigene Ideen ergänzen. "Abschicken" speichert die Antwort sofort; auf der Danke-Seite (optional mit Link, z. B. zur TestFlight-Beta) lassen sich danach optional Name und E-Mail zur eigenen Antwort ergänzen (der Browser bekommt dafür einen Schlüssel, der Server speichert nur dessen Hash). Für dich gibt es eine Live-Auswertung im Mentimeter-Stil.

- Node >= 22.13, SQLite eingebaut (`node:sqlite`); im Browser SortableJS, d3-force und qrcode-generator, ausgeliefert aus `node_modules`
- Inhalte einer Umfrage in genau einer Sprache, frei wählbar; Bedienelemente Deutsch und Englisch (Umschalter oben rechts, Sprache wird automatisch erkannt)
- Hell und dunkel, mobil optimiert, Tastatur-bedienbar
- Keine externen Requests (keine Google Fonts, kein CDN), also DSGVO-freundlich

## Seiten

| URL | Wofür |
| --- | --- |
| `/` | Startseite: was das Tool macht und wie es funktioniert |
| `/admin` | Alle Umfragen, neue Umfrage anlegen (fragt nach dem Token) |
| `/<umfrage>` | Die Umfrage, z. B. `/semino` |
| `/<umfrage>?reset` | Lokalen Entwurf und "schon abgestimmt" zurücksetzen (zum Testen) |
| `/<umfrage>/live` | Live-Auswertung für den Beamer, öffentlich. Tabs: **Diagramm**, **Cluster**, **QR** (bildschirmfüllend QR-Code und Adresse; automatisch bis zur ersten Antwort, sonst Taste Q, Klick oder Esc geht zurück), **Optionen** (Titel, Texte, Link und Optionen bearbeiten) und **Antworten** (einzelne Einsendungen mit Kommentaren ansehen und löschen); die letzten beiden fragen nach dem Token. Der Tab steht in der Adresse (`#cluster`), ein Reload bleibt dort. |
| `/<umfrage>/live?token=DEIN_TOKEN` | Wie oben, ohne Nachfrage und mit CSV-Button |
| `/api/surveys/<umfrage>/export.csv?token=DEIN_TOKEN` | Alle Antworten als CSV (öffnet sauber in Excel) |

Der Token schützt Verwaltung, Bearbeiten, den Tab Antworten und den CSV-Export (die letzten beiden enthalten Namen und E-Mail-Adressen). Er wird nach dem Öffnen aus der Adresszeile entfernt.

## Umfragen anlegen und bearbeiten

Neue Umfragen entstehen unter `/admin` mit einem Titel (die Adresse wird daraus abgeleitet) und starten ohne Optionen.
Alles Weitere passiert im Tab **Optionen** der Live-Ansicht: Titel, Einleitung, Text und Link für die Danke-Seite, Optionen mit Titel und Beschreibung.
Die Texte sind einfache Zeichenketten in der Sprache der Umfrage.
Bestehende Optionen behalten beim Bearbeiten ihre `id` (Antworten verweisen darauf), neue bekommen eine aus dem Titel.
Neue Optionen landen bei Leuten mit gespeichertem Entwurf automatisch unter "Das wäre nett".

Umfragen liegen mit den Antworten in `data/responses.db`.
Die erste Umfrage der App (vorher fest in der `config.json`) wird beim ersten Start als `semino` übernommen, beschrieben in `migrations/semino.json`.

## `config.json`

Nur noch Einstellungen für alle Umfragen, ohne Neustart übernommen:

- `privacy`: Datenschutzhinweis neben Name und E-Mail, `de` und `en`
- `maxCustomIdeas`: wie viele eigene Ideen jemand hinzufügen darf

## Lokal starten

```bash
npm install
ADMIN_TOKEN=geheim node server.js
# Umfragen: http://localhost:3000/admin?token=geheim
```

## Auf dem Server (Docker)

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 16)" > .env
mkdir -p data && sudo chown 1000:1000 data   # Container läuft als User "node"
docker compose up -d --build
```

Dahinter einen Reverse Proxy (Caddy, Traefik, nginx) mit HTTPS hängen. Für die Live-Ansicht wichtig: Der Proxy darf Server-Sent Events nicht puffern. Bei nginx:

```nginx
location ~ ^/api/surveys/[^/]+/stream$ {
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

Gespeichert werden nur die Sortierung, eigene Ideen, Kommentare (💬 pro Option) und die freiwilligen Angaben (Name, E-Mail, Sprache), keine IP-Adressen. Die IP wird nur kurz im Arbeitsspeicher für ein Rate-Limit (20 Antworten pro 10 Minuten) genutzt. Daten liegen in `data/responses.db`.
