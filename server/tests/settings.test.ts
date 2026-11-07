import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { initDb } from '../src/db/index.js';
import { settingsRoutes } from '../src/modules/settings/settings.routes.js';

test('sampling settings persist zero/low temperatures and reject invalid values atomically', async () => {
  const db = initDb(':memory:');
  db.run(sql`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const app = Fastify();
  await app.register(settingsRoutes);
  try {
    for (const temperature of [0, 0.1, 0.25, 0.35]) {
      const res = await app.inject({ method: 'PATCH', url: '/', payload: {
        generationTemperature: temperature, generationRepetitionPenalty: 1.12,
        generationFrequencyPenalty: 0.3, generationPresencePenalty: 0.15,
      } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.generationTemperature, temperature);
      assert.equal(res.json().data.generationRepetitionPenalty, 1.12);
    }
    for (const payload of [
      { generationTemperature: -0.1 }, { generationTemperature: 2.1 },
      { generationRepetitionPenalty: 0 }, { generationRepetitionPenalty: -1 },
      { generationFrequencyPenalty: 3 }, { generationPresencePenalty: '0.2' },
    ]) {
      const res = await app.inject({ method: 'PATCH', url: '/', payload });
      assert.equal(res.statusCode, 400);
    }
    const saved = (await app.inject({ method: 'GET', url: '/' })).json().data;
    assert.equal(saved.generationTemperature, 0.35);
    assert.equal(saved.generationRepetitionPenalty, 1.12);
  } finally { await app.close(); }
});
