import { blob, integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const docUpdates = sqliteTable('doc_updates', {
	id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
	data: blob('data', { mode: 'buffer' }).notNull(),
});
