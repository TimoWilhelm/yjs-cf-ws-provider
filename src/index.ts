import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/yjs/:roomId', (c) => {
	const roomId = c.req.param('roomId');

	const id = c.env.DURABLE_YJSPROVIDER.idFromName(roomId);
	const obj = c.env.DURABLE_YJSPROVIDER.get(id);

	const doUrl = new URL('https://example.com/ws');

	const req = new Request(doUrl, { headers: c.req.raw.headers });
	return obj.fetch(req);
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { YjsProvider } from './durable/YjsProvider';
