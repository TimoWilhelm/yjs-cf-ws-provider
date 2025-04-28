import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
	plugins: [cloudflare({

	})],
	resolve: {
		conditions: ['workerd', 'edge'],
	},
	build: {
		target: 'esnext',
		minify: true,
	},
});
