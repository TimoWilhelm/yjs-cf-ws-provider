import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import text from './plugins/vite-plugin-text';

export default defineConfig({
	plugins: [text(['.sql']), cloudflare()],
	resolve: {
		conditions: ['workerd', 'edge'],
	},
	build: {
		target: 'esnext',
		minify: true,
	},
});
