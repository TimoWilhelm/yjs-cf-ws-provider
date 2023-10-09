import type { Env } from './env';
import { Router, error, type IRequest } from 'itty-router';
import index from './index.html';

export { YjsProvider } from './durable/YjsProvider';

type CF = [env: Env, context: ExecutionContext];

type RoomIdRequest = {
  roomid: string;
} & IRequest;

const router = Router<IRequest, CF>();

router
  .get(
    '/',
    () =>
      new Response(index, {
        headers: { 'Content-Type': 'text/html' },
      }),
  )
  .get<RoomIdRequest, CF>('/yjs/:roomid', (request, env) => {
    const { roomid } = request;

    const id = env.DURABLE_YJSPROVIDER.idFromName(roomid);
    const obj = env.DURABLE_YJSPROVIDER.get(id);

    const doUrl = new URL('https://example.com/connect');

    doUrl.searchParams.set('username', String(request.cf?.country) ?? 'Anonymous'); //TODO: Here you could get the username from the request session

    const req = new Request(doUrl, request);

    return obj.fetch(req);
  })
  .get<RoomIdRequest, CF>('/yjs/:roomid/snapshot', (request, env) => {
    const { roomid } = request;

    const id = env.DURABLE_YJSPROVIDER.idFromName(roomid);
    const obj = env.DURABLE_YJSPROVIDER.get(id);

    const doUrl = new URL('https://example.com/snapshot');
    const req = new Request(doUrl, request);
    return obj.fetch(req);
  })

  .all('*', () => error(404));

export default {
  fetch: (req, ...args) => router.handle(req, ...args).catch(error),
} satisfies ExportedHandler<Env>;
