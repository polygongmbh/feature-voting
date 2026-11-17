# Offene Punkte

Was noch zu entscheiden oder zu tun ist, Stand 17.11.2026.
Nicht hier: wie es dazu kam (siehe `docs/history.md`), wie die App heute funktioniert (siehe `README.md`).

Erledigte Punkte hier löschen, nicht abhaken.

## Diagramm respektiert die Rangfolge nicht

Janek (12:54): Will ich > Nett > Brauche ich nicht ist eine klare Hierarchie,
die divergierenden Balken in `public/live.js` (`renderRanking`) brechen sie,
weil "Brauche ich nicht" links und "Will ich" + "Nett" rechts der Achse stehen.

Welche Darstellung er stattdessen will, ist offen.
**Vor dem Bauen mit Janek abstimmen.**
Kandidaten:

- Gestapelter Balken in Rangfolge, links nach rechts Will ich → Nett → Brauche ich nicht,
  Legende in derselben Reihenfolge
- Auswertung aufgebaut wie die Umfrage:
  🔥 / ✨ / 💤 untereinander, Features darunter nach Mehrheit einsortiert und nach Score gereiht
- Kombination: Abschnitte wie in der Umfrage, in jedem Abschnitt Balken in Rangfolge

Projektor-Lesbarkeit bleibt harte Anforderung (Janek, 11:59).

## Inhalte in `config.json`

- Echte Feature-Liste (bisher Platzhalter)
- Titel und Intro an die App anpassen
- Link auf der Danke-Seite zeigt auf `https://campus.polygon.gmbh`;
  klären, ob dort noch ein TestFlight-Link hin soll (ursprüngliche Anforderung, 11:04)

## Wertung unberührter Features

Alles startet in "Das wäre nett",
ein nicht angefasstes Feature zählt also als "nett".
Janek wurde darauf hingewiesen, hat noch nicht entschieden.
Alternative: als "keine Stimme" werten,
dann muss das Frontend mitschicken, welche Karten bewegt wurden.

## Nicht getestet

- Touch-Drag am Griff in echtem iOS Safari
  (getestet nur mit Playwright/Chromium im iPhone-Viewport)
