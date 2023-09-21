import type { Env } from './env';

export { YjsProvider } from './durable/YjsProvider';
import { Router, error } from 'itty-router';
import index from './index.html';

export default {
  async fetch(request: Request, env: Env) {
    const router = Router();

    router
      .get(
        '/',
        () =>
          new Response(index, {
            headers: { 'Content-Type': 'text/html' },
          }),
      )
      .get('/yjs/:roomid', ({ roomid }) => {
        const id = env.DURABLE_YJSPROVIDER.idFromName(roomid);
        const obj = env.DURABLE_YJSPROVIDER.get(id);

        const doUrl = new URL('https://example.com/connect');

        doUrl.searchParams.set('username', String(request.cf?.country) ?? 'Anonymous'); //TODO: Here you could get the username from the request session

        const req = new Request(doUrl, request);

        return obj.fetch(req);
      })
      .get('/yjs/:roomid/snapshot', ({ roomid }) => {
        const id = env.DURABLE_YJSPROVIDER.idFromName(roomid);
        const obj = env.DURABLE_YJSPROVIDER.get(id);

        const doUrl = new URL('https://example.com/snapshot');
        const req = new Request(doUrl, request);
        return obj.fetch(req);
      })

      .all('*', () => error(404));

    const url = new URL(request.url);

    return router.handle(request, url.pathname);
  },
} satisfies ExportedHandler<Env>;
