import path from 'node:path';

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	out: path.relative(process.cwd(), path.join(__dirname, 'drizzle')).replaceAll(path.sep, path.posix.sep),
	schema: path.relative(process.cwd(), path.join(__dirname, 'schema.ts')).replaceAll(path.sep, path.posix.sep),
	dialect: 'sqlite',
	driver: 'durable-sqlite',
});
