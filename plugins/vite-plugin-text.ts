import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Plugin } from 'vite';

export default (extensions: string[]): Plugin => {
	return {
		name: 'vite-plugin-text',
		enforce: 'pre',

		async transform(_src, id) {
			const ext = path.extname(id);
			if (!extensions.includes(ext)) return null;

			const data = await readFile(id);
			return `export default ${JSON.stringify(data.toString())};`;

		},
	} satisfies Plugin;
};
