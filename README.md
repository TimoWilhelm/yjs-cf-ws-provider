# Yjs WebSocket Provider

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TimoWilhelm/yjs-cf-ws-provider)

> [!NOTE]
> This project is intended for learning purposes and demonstration of the Cloudflare Workers and Durable Objects APIs.
> If you are looking for a production-ready solution, check out [PartyKit](https://docs.partykit.io/guides/deploy-to-cloudflare/) which also
> supports the [Yjs API](https://docs.partykit.io/reference/y-partykit-api/).

This project implements a Serverless Yjs WebSocket provider using Cloudflare Workers + Durable Objects to relay messages between clients. It is fully compatible with the [Yjs WebSocket Connector](https://github.com/yjs/y-websocket).

![Architecture Diagram](org/architecture.png)

This project uses the Cloudflare Durable Objects WebSocket Hibernation API to terminate WebSocket connections to avoid incurring duration charges when the connection is idle.

![WebSocket Hibernation](org/websocket_hibernation.png)

It also periodically saves the Yjs document state to a Cloudflare R2 storage bucket and clears the partial updates from the Durable Object storage. The vacuum interval can be configured with the YJS_VACUUM_INTERVAL_IN_MS environment variable. The default is 30 seconds.

## Run locally

```bash
npm install
npm run dev
```

This will start a local server using the Wrangler CLI and serve a demo app. You can open a browser
to the URL that is displayed in the console to test it with a simple [TipTap](https://tiptap.dev/)
editor.
