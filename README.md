# Feature-Voting

Kleine selbst gehostete Umfrage-App: Teilnehmende sortieren eine vertikale Liste per Griff ≡ (oder Antippen) in die Abschnitte **Das will ich! / Das wäre nett / Brauche ich nicht**. Alle Features starten in der Mitte ("Das wäre nett"). Teilnehmende können eigene Ideen ergänzen und optional Name und E-Mail angeben. Am Ende gibt es den TestFlight-Link. Für dich gibt es eine Live-Auswertung im Mentimeter-Stil.

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
| `/live?token=DEIN_TOKEN` | Live-Auswertung für den Beamer (Balkendiagramm + Cluster + eigene Ideen) |
| `/api/export.csv?token=DEIN_TOKEN` | Alle Antworten als CSV (öffnet sauber in Excel) |

Der Token wird nach dem Öffnen aus der Adresszeile entfernt, damit er nicht auf dem Beamer oder in Screenshots landet.

## Anpassen: `config.json`

- `title`, `intro`, `privacy`: Texte, jeweils `de` und `en` (oder einfach ein String)
- `testflight.url`: dein TestFlight-Link, `testflight.text`: Text auf der Danke-Seite
- `features`: Liste mit `id` (kurz, eindeutig, nicht mehr ändern sobald Antworten da sind), `title` und `desc`
- `maxCustomIdeas`: wie viele eigene Ideen jemand hinzufügen darf

Änderungen an der `config.json` werden ohne Neustart übernommen. Neue Features landen bei Leuten mit gespeichertem Entwurf automatisch unter "Das wäre nett".

## Lokal starten

```bash
npm install
ADMIN_TOKEN=geheim node server.js
# Umfrage:  http://localhost:3000/
# Live:     http://localhost:3000/live?token=geheim
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
