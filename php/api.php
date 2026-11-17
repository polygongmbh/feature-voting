<?php
/**
 * Feature-Voting API (PHP >= 8.0 mit pdo_sqlite)
 *
 *   GET  api.php?a=config                  öffentliche Umfrage-Konfiguration
 *   POST api.php?a=submit                  Antwort speichern
 *   GET  api.php?a=stats&token=...         Auswertung (Live-Ansicht)
 *   GET  api.php?a=export&token=...        alle Antworten als CSV
 *
 * Konfiguration, Admin-Token und Datenbank liegen außerhalb des Web-Roots in PRIVATE_DIR:
 *   config.json   gleiche Datei wie in der Node-Version
 *   admin-token   eine Zeile, mindestens 16 Zeichen (oder Umgebungsvariable FV_ADMIN_TOKEN)
 *   data/         SQLite-Datenbank, entsteht automatisch
 *
 * Wertung und Validierung spiegeln server.js; Änderungen dort hier nachziehen.
 */
declare(strict_types=1);

// Hestia-Struktur: /home/<user>/web/<domain>/public_html  +  /home/<user>/web/<domain>/private
define('PRIVATE_DIR', getenv('FV_PRIVATE_DIR') ?: __DIR__ . '/../private/feature-voting');
const BUCKETS = ['want', 'nice', 'no'];

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg]);
    exit;
}

function json_out(mixed $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cfg(): array {
    static $c = null;
    if ($c === null) {
        $raw = @file_get_contents(PRIVATE_DIR . '/config.json');
        if ($raw === false) fail(500, 'config.json nicht gefunden');
        $c = json_decode($raw, true);
        if (!is_array($c) || !isset($c['features']) || !is_array($c['features'])) fail(500, 'config.json ungültig');
    }
    return $c;
}

function txt(mixed $v, string $lang = 'de'): string {
    if (is_string($v)) return $v;
    if (is_array($v)) return (string)($v[$lang] ?? $v['de'] ?? (reset($v) ?: ''));
    return '';
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dir = PRIVATE_DIR . '/data';
        if (!is_dir($dir) && !@mkdir($dir, 0750, true)) fail(500, 'Datenordner nicht beschreibbar');
        $pdo = new PDO('sqlite:' . $dir . '/responses.db');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 3000');
        $pdo->exec('CREATE TABLE IF NOT EXISTS responses (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
            name TEXT, email TEXT, lang TEXT, payload TEXT NOT NULL)');
        // nur gehashte IPs, nach 10 Minuten gelöscht (Rate-Limit)
        $pdo->exec('CREATE TABLE IF NOT EXISTS hits (ip_hash TEXT NOT NULL, at INTEGER NOT NULL)');
    }
    return $pdo;
}

function admin_token(): string {
    static $t = null;
    if ($t === null) {
        $t = trim((string)(getenv('FV_ADMIN_TOKEN') ?: @file_get_contents(PRIVATE_DIR . '/admin-token')));
    }
    return $t;
}

function is_admin(): bool {
    $expected = admin_token();
    $given = (string)($_GET['token'] ?? '');
    if (strlen($expected) < 16) return false;
    return $given !== '' && hash_equals($expected, $given);
}

function rate_limited(): bool {
    $pdo = db();
    $now = time();
    $hash = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? 'x') . '|' . admin_token());
    $pdo->prepare('DELETE FROM hits WHERE at < ?')->execute([$now - 600]);
    $pdo->prepare('INSERT INTO hits (ip_hash, at) VALUES (?, ?)')->execute([$hash, $now]);
    $st = $pdo->prepare('SELECT COUNT(*) FROM hits WHERE ip_hash = ?');
    $st->execute([$hash]);
    return (int)$st->fetchColumn() > 20;
}

function uuid4(): string {
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function clean_text(mixed $v, int $max): string {
    $s = trim(preg_replace('/\s+/u', ' ', (string)$v) ?? '');
    return mb_substr($s, 0, $max);
}

function validate(array $body): array|string {
    $cfg = cfg();
    $featureIds = array_flip(array_map(fn($f) => (string)$f['id'], $cfg['features']));
    $maxCustom = (int)($cfg['maxCustomIdeas'] ?? 5);

    $custom = is_array($body['custom'] ?? null) ? $body['custom'] : [];
    if (count($custom) > $maxCustom) return 'too many custom ideas';
    $customIds = [];
    $cleanCustom = [];
    foreach ($custom as $c) {
        $id = is_array($c) ? (string)($c['id'] ?? '') : '';
        if (!preg_match('/^c_[a-z0-9]{4,20}$/i', $id)) return 'bad custom id';
        $text = clean_text($c['text'] ?? '', 140);
        if ($text === '') continue;
        $customIds[$id] = true;
        $cleanCustom[] = ['id' => $id, 'text' => $text];
    }

    $buckets = [];
    $seen = [];
    $sorted = 0;
    foreach (BUCKETS as $b) {
        $buckets[$b] = [];
        $list = is_array($body['buckets'][$b] ?? null) ? $body['buckets'][$b] : [];
        foreach ($list as $id) {
            if (!is_string($id) || isset($seen[$id])) continue;
            if (!isset($featureIds[$id]) && !isset($customIds[$id])) continue;
            $seen[$id] = true;
            $buckets[$b][] = $id;
            $sorted++;
        }
    }
    if ($sorted === 0) return 'nothing sorted';

    $name = clean_text($body['name'] ?? '', 80);
    $email = clean_text($body['email'] ?? '', 120);
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) return 'invalid email';
    $lang = in_array($body['lang'] ?? null, ['de', 'en'], true) ? $body['lang'] : null;

    return [
        'buckets' => $buckets, 'custom' => $cleanCustom,
        'name' => $name ?: null, 'email' => $email ?: null, 'lang' => $lang,
    ];
}

function aggregate(): array {
    $cfg = cfg();
    $lang = $cfg['defaultLang'] ?? 'de';
    $stats = [];
    foreach ($cfg['features'] as $f) {
        $stats[$f['id']] = ['id' => $f['id'], 'title' => $f['title'], 'want' => 0, 'nice' => 0, 'no' => 0, 'rankSum' => 0.0];
    }
    $ideas = [];
    $rows = db()->query('SELECT created_at, payload FROM responses ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);

    foreach ($rows as $r) {
        $p = json_decode($r['payload'], true);
        if (!is_array($p)) continue;
        foreach (BUCKETS as $b) {
            $known = array_values(array_filter($p['buckets'][$b] ?? [], fn($id) => isset($stats[$id])));
            $n = count($known);
            foreach ($known as $i => $id) {
                $stats[$id][$b]++;
                // Position in "will ich": Platz 1 zählt voll, letzter Platz halb
                if ($b === 'want') $stats[$id]['rankSum'] += $n > 1 ? 1 - ($i / ($n - 1)) * 0.5 : 1;
            }
        }
        foreach ($p['custom'] ?? [] as $c) {
            $bucket = null;
            foreach (BUCKETS as $b) if (in_array($c['id'], $p['buckets'][$b] ?? [], true)) { $bucket = $b; break; }
            $ideas[] = ['text' => $c['text'], 'bucket' => $bucket, 'at' => $r['created_at']];
        }
    }

    $features = [];
    foreach ($stats as $s) {
        $n = $s['want'] + $s['nice'] + $s['no'];
        // Punkte: will ich = 2 + Positionsbonus (0.5..1), nett = 1, brauche ich nicht = -1
        $avg = $n ? ($s['want'] * 2 + $s['rankSum'] + $s['nice'] - $s['no']) / $n : 0;
        $features[] = [
            'id' => $s['id'], 'title' => $s['title'],
            'want' => $s['want'], 'nice' => $s['nice'], 'no' => $s['no'], 'n' => $n,
            'score' => $n ? (int)round((($avg + 1) / 4) * 100) : 0,
            'lean' => $n ? ($s['want'] + $s['nice'] * 0.5) / $n : 0.5,
        ];
    }
    usort($features, fn($a, $b) => [$b['score'], $b['n']] <=> [$a['score'], $a['n']]);

    return [
        'title' => txt($cfg['title'] ?? '', $lang),
        'total' => count($rows),
        'features' => $features,
        'ideas' => array_reverse(array_slice($ideas, -40)),
        'updatedAt' => gmdate('c'),
    ];
}

// ---------- Routing ----------
try {
    $action = $_GET['a'] ?? '';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($action === 'config' && $method === 'GET') {
        $c = cfg();
        json_out([
            'defaultLang' => $c['defaultLang'] ?? 'de',
            'title' => $c['title'] ?? '', 'intro' => $c['intro'] ?? '', 'privacy' => $c['privacy'] ?? '',
            'testflight' => $c['testflight'] ?? null, 'maxCustomIdeas' => (int)($c['maxCustomIdeas'] ?? 5),
            'features' => $c['features'],
        ]);
    }

    if ($action === 'submit' && $method === 'POST') {
        $raw = file_get_contents('php://input', false, null, 0, 32 * 1024 + 1);
        if ($raw === false || strlen($raw) > 32 * 1024) fail(413, 'too large');
        $body = json_decode($raw, true);
        if (!is_array($body)) fail(400, 'invalid json');
        if (rate_limited()) fail(429, 'rate limited');
        $clean = validate($body);
        if (is_string($clean)) fail(400, $clean);
        db()->prepare('INSERT INTO responses (id, created_at, name, email, lang, payload) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([
                uuid4(), gmdate('Y-m-d\TH:i:s') . sprintf('.%03dZ', (int)(microtime(true) * 1000) % 1000),
                $clean['name'], $clean['email'], $clean['lang'],
                json_encode(['buckets' => $clean['buckets'], 'custom' => $clean['custom']], JSON_UNESCAPED_UNICODE),
            ]);
        json_out(['ok' => true], 201);
    }

    if ($action === 'stats' && $method === 'GET') {
        if (!is_admin()) fail(401, 'unauthorized');
        json_out(aggregate());
    }

    if ($action === 'export' && $method === 'GET') {
        if (!is_admin()) fail(401, 'unauthorized');
        $ids = array_map(fn($f) => (string)$f['id'], cfg()['features']);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="feature-voting.csv"');
        $out = fopen('php://output', 'w');
        fwrite($out, "\xEF\xBB\xBF");
        fputcsv($out, ['id', 'created_at', 'name', 'email', 'lang', ...$ids, 'custom_ideas'], ',', '"', '');
        foreach (db()->query('SELECT * FROM responses ORDER BY created_at ASC') as $r) {
            $p = json_decode($r['payload'], true) ?: ['buckets' => [], 'custom' => []];
            $cells = [];
            foreach ($ids as $id) {
                $cell = '';
                foreach (BUCKETS as $b) {
                    $i = array_search($id, $p['buckets'][$b] ?? [], true);
                    if ($i !== false) { $cell = $b === 'want' ? 'want #' . ($i + 1) : $b; break; }
                }
                $cells[] = $cell;
            }
            $custom = [];
            foreach ($p['custom'] ?? [] as $c) {
                $bucket = 'unsorted';
                foreach (BUCKETS as $b) if (in_array($c['id'], $p['buckets'][$b] ?? [], true)) { $bucket = $b; break; }
                $custom[] = $c['text'] . ' [' . $bucket . ']';
            }
            fputcsv($out, [$r['id'], $r['created_at'], $r['name'], $r['email'], $r['lang'], ...$cells, implode(' | ', $custom)], ',', '"', '');
        }
        exit;
    }

    fail(404, 'not found');
} catch (Throwable $e) {
    error_log('[feature-voting] ' . $e->getMessage());
    fail(500, 'server error');
}
