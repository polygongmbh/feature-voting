// SQLite storage: surveys and their responses.
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function openDb(dataDir, migrationsDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'responses.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT,
      email TEXT,
      lang TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS surveys (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `);
  // edit_key: hash of the key that lets a submitter add name/email afterwards
  for (const col of ['edit_key TEXT', 'survey_id TEXT']) {
    try { db.exec(`ALTER TABLE responses ADD COLUMN ${col}`); } catch { /* column exists */ }
  }
  migrateSingleSurvey(db, migrationsDir);

  const q = {
    surveys: db.prepare('SELECT id, created_at, data, (SELECT COUNT(*) FROM responses r WHERE r.survey_id = s.id) AS total FROM surveys s ORDER BY created_at DESC'),
    survey: db.prepare('SELECT id, created_at, data FROM surveys WHERE id = ?'),
    insertSurvey: db.prepare('INSERT INTO surveys (id, created_at, data) VALUES (?, ?, ?)'),
    updateSurvey: db.prepare('UPDATE surveys SET data = ? WHERE id = ?'),
    responses: db.prepare('SELECT * FROM responses WHERE survey_id = ? ORDER BY created_at ASC'),
    insertResponse: db.prepare('INSERT INTO responses (id, created_at, name, email, lang, payload, edit_key, survey_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    contact: db.prepare('UPDATE responses SET name = ?, email = ? WHERE id = ? AND edit_key = ?'),
    responseSurvey: db.prepare('SELECT survey_id FROM responses WHERE id = ?'),
    deleteResponse: db.prepare('DELETE FROM responses WHERE id = ?'),
  };
  const parse = row => row && { id: row.id, created_at: row.created_at, ...JSON.parse(row.data), ...(row.total != null ? { total: row.total } : {}) };
  return {
    listSurveys: () => q.surveys.all().map(parse),
    getSurvey: id => parse(q.survey.get(id)),
    createSurvey: (id, data) => q.insertSurvey.run(id, new Date().toISOString(), JSON.stringify(data)),
    updateSurvey: (id, data) => q.updateSurvey.run(JSON.stringify(data), id),
    responses: surveyId => q.responses.all(surveyId),
    insertResponse: (...a) => q.insertResponse.run(...a),
    setContact: (...a) => q.contact.run(...a),
    surveyOfResponse: id => q.responseSurvey.get(id)?.survey_id,
    deleteResponse: id => q.deleteResponse.run(id),
  };
}

// The app started with one survey configured in config.json. Its answers (survey_id NULL) become the
// survey described in migrations/semino.json, once.
function migrateSingleSurvey(db, migrationsDir) {
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id IS NULL').get().n;
  if (!orphans) return;
  const seed = JSON.parse(readFileSync(path.join(migrationsDir, 'semino.json'), 'utf8'));
  const { id, ...data } = seed;
  if (!db.prepare('SELECT 1 FROM surveys WHERE id = ?').get(id)) {
    db.prepare('INSERT INTO surveys (id, created_at, data) VALUES (?, ?, ?)').run(id, '2026-11-17T10:00:00.000Z', JSON.stringify(data));
  }
  db.prepare('UPDATE responses SET survey_id = ? WHERE survey_id IS NULL').run(id);
  console.log(`[migration] ${orphans} Antworten der Umfrage "${id}" zugeordnet`);
}
