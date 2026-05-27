import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { providers, type DbProvider } from '../../db/schema.js';
import type { Provider } from '@rpgspeak/shared';
import { v4 as uuidv4 } from 'uuid';

function now() { return new Date().toISOString(); }

function dbToProvider(row: DbProvider): Provider {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Provider['type'],
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    defaultModel: row.defaultModel,
    isEnabled: row.isEnabled,
    config: JSON.parse(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ProviderRepository {
  private get db() { return getDb(); }

  findAll(): Provider[] {
    return this.db.select().from(providers).all().map(dbToProvider);
  }

  findById(id: string): Provider | null {
    const row = this.db.select().from(providers).where(eq(providers.id, id)).get();
    return row ? dbToProvider(row) : null;
  }

  findEnabled(): Provider[] {
    return this.db.select().from(providers).where(eq(providers.isEnabled, true)).all().map(dbToProvider);
  }

  create(data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>): Provider {
    const id = uuidv4();
    const ts = now();
    const isEnabled = data.isEnabled ? 1 : 0;
    const config = JSON.stringify(data.config ?? {});
    this.db.run(
      sql`INSERT INTO providers (id, name, type, base_url, api_key, default_model, is_enabled, config, created_at, updated_at)
          VALUES (${id}, ${data.name}, ${data.type}, ${data.baseUrl}, ${data.apiKey ?? null},
                  ${data.defaultModel ?? null}, ${isEnabled}, ${config}, ${ts}, ${ts})`
    );
    return this.findById(id)!;
  }

  update(id: string, data: Partial<Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>>): Provider | null {
    const ts = now();
    if (data.name !== undefined) this.db.run(sql`UPDATE providers SET name = ${data.name}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.type !== undefined) this.db.run(sql`UPDATE providers SET type = ${data.type}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.baseUrl !== undefined) this.db.run(sql`UPDATE providers SET base_url = ${data.baseUrl}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.apiKey !== undefined) this.db.run(sql`UPDATE providers SET api_key = ${data.apiKey}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.defaultModel !== undefined) this.db.run(sql`UPDATE providers SET default_model = ${data.defaultModel}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.isEnabled !== undefined) this.db.run(sql`UPDATE providers SET is_enabled = ${data.isEnabled ? 1 : 0}, updated_at = ${ts} WHERE id = ${id}`);
    if (data.config !== undefined) this.db.run(sql`UPDATE providers SET config = ${JSON.stringify(data.config)}, updated_at = ${ts} WHERE id = ${id}`);
    return this.findById(id);
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM providers WHERE id = ${id}`);
    return true;
  }
}
