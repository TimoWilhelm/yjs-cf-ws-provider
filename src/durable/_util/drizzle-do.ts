import { DurableObject } from 'cloudflare:workers';
import type { Logger } from 'drizzle-orm';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

interface MigrationConfig {
  journal: {
    entries: {
      idx: number;
      when: number;
      tag: string;
      breakpoints: boolean;
    }[];
  };
  migrations: Record<string, string>;
}

export abstract class DrizzleDurableObject<
  TSchema extends Record<string, unknown>,
  TEnv = unknown,
> extends DurableObject<TEnv> {
  #migrationsApplied = false;

  protected logger: boolean | Logger | undefined = undefined;

  protected abstract readonly schema: TSchema;
  protected abstract readonly migrations: MigrationConfig;

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);

    const originalDeleteAll = this.ctx.storage.deleteAll.bind(this.ctx.storage);
    this.ctx.storage.deleteAll = async (options?: DurableObjectPutOptions) => {
      await originalDeleteAll(options);
      this.#migrationsApplied = false;
    };
  }

  protected async getDb(): Promise<DrizzleSqliteDODatabase<TSchema>> {
    const db = drizzle(this.ctx.storage, { schema: this.schema, logger: false });
    if (!this.#migrationsApplied) {
      await migrate(db, this.migrations);
      this.#migrationsApplied = true;
    }

    return db;
  }
}
