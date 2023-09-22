/* eslint-disable max-lines */
/* eslint-disable class-methods-use-this */

/*
 * ┌───────────────────────────────────────────────────────┐
 * │                                                       │
 * │  ┌───────────┐      ┌───────────┐     ┌────────────┐  │
 * │  │ Client 1  │      │  Server   │     │  Client 2  │  │
 * │  └─────┬─────┘      └─────┬─────┘     └──────┬─────┘  │
 * │        │                  │                  │        │
 * │        │◄────WebSocket───►│                  │        │
 * │        │                  │                  │        │
 * │        │                  │                  │        │
 * │        │◄────SyncStep1────┤                  │        │
 * │        │                  │                  │        │
 * │        ├─────SyncStep2───►│                  │        │
 * │        │                  │                  │        │
 * │        │                  │                  │        │
 * │        ├─────SyncStep1───►│                  │        │
 * │        │                  │                  │        │
 * │        │◄────SyncStep2────┤                  │        │
 * │        │                  │                  │        │
 * │        │                  │                  │        │
 * │        │                  │◄─────Update──────┤        │
 * │        │                  │                  │        │
 * │        │◄─────Update──────┼──────Update─────►│        │
 * │        │                  │                  │        │
 * │        │                  │                  │        │
 * │        ├──────Update─────►│                  │        │
 * │        │                  │                  │        │
 * │        │◄─────Update──────┼──────Update─────►│        │
 * │        │                  │                  │        │
 * │        │                  │                  │        │
 * │                                                       │
 * └───────────────────────────────────────────────────────┘
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as f from 'lib0/function';
import * as time from 'lib0/time';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import z from 'zod';

import type { Env } from '../env';
import {
  chunkArray,
  createSearchParamsObjSchema,
  handleWorkerErrors,
  uuidV7,
  stringToColor,
  coerceOptionalBooleanStrict,
} from '../util';

const enum MESSAGE_TYPE {
  SYNC = 0,
  AWARENESS = 1,
}

const enum SYNC_MESSAGE_TYPE {
  STEP1 = 0,
  STEP2 = 1,
  UPDATE = 2,
}

const connectArgSchema = z.object({
  username: z.string().trim().max(30),
  readonly: z.boolean().default(false),
});

const connectSearchParamsSchema = createSearchParamsObjSchema(connectArgSchema);

export class YjsProvider implements DurableObject {
  private sessions: Map<
    WebSocket,
    {
      controlledIds: Set<number>;
      username: string;
      color: string;
      readonly: boolean;
    }
  > = new Map();

  private stateAsUpdateV2: Uint8Array = new Uint8Array();

  private readonly awareness = new Awareness(new Y.Doc());

  private readonly vacuumIntervalInMs: number;

  private readonly enableGC: boolean;

  private readonly updateKeys = new Set<string>();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.vacuumIntervalInMs =
      z.number().positive().optional().parse(env.YJS_VACUUM_INTERVAL_IN_MS) ?? 30_000; // 30 seconds
    this.enableGC = coerceOptionalBooleanStrict.parse(env.YJS_ENABLE_GC) ?? true;

    this.state.getWebSockets().forEach((ws: WebSocket) => {
      const meta = ws.deserializeAttachment();
      this.sessions.set(ws, { ...meta });
    });

    // hydrate DO state
    void this.state.blockConcurrencyWhile(async () => {
      const updates = [] as Uint8Array[];

      const result = await env.R2_DEFAULT.get(`state:${this.state.id.toString()}`);
      if (result) {
        const baseUpdate = new Uint8Array(await result.arrayBuffer());
        updates.push(baseUpdate);
      }

      const partialUpdates = await this.state.storage.list<Uint8Array>({ prefix: 'doc:' });
      partialUpdates.forEach((update, key) => {
        updates.push(update);
        this.updateKeys.add(key);
      });

      this.stateAsUpdateV2 = Y.mergeUpdatesV2(updates);

      // initialize awareness
      const initialAwarenessState = await this.state.storage.get<{
        [x: string]: unknown;
      }>('awareness');
      if (initialAwarenessState) {
        this.awareness.setLocalState(initialAwarenessState);
      }
    });
  }

  fetch(request: Request) {
    return handleWorkerErrors(request, async () => {
      const url = new URL(request.url);

      switch (url.pathname) {
        case '/snapshot': {
          return new Response(this.stateAsUpdateV2);
        }

        case '/connect': {
          if (request.headers.get('upgrade') !== 'websocket') {
            return new Response('expected websocket', { status: 400 });
          }

          const result = await connectSearchParamsSchema.safeParseAsync(url.searchParams);

          if (!result.success) {
            return new Response(JSON.stringify(result.error.format()), { status: 400 });
          }

          const { username, readonly } = result.data;

          // get color from palette by username hash
          const color = stringToColor(username);

          const pair = new WebSocketPair();

          this.state.acceptWebSocket(pair[1]);
          await this.handleSession(pair[1], { username, color, readonly });

          return new Response(null, {
            status: 101,
            webSocket: pair[0],
          });
        }

        default:
          return new Response('Not found', { status: 404 });
      }
    });
  }

  // eslint-disable-next-line max-statements
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string') {
      return;
    }

    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_TYPE.SYNC: {
          const syncMessageType = decoding.readVarUint(decoder);
          switch (syncMessageType) {
            case SYNC_MESSAGE_TYPE.STEP1: {
              const encodedTargetStateVector = decoding.readVarUint8Array(decoder);

              const updateV2 = Y.diffUpdateV2(this.stateAsUpdateV2, encodedTargetStateVector);
              const updateV1 = Y.convertUpdateFormatV2ToV1(updateV2);

              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
              encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP2);
              encoding.writeVarUint8Array(encoder, updateV1);

              // If the `encoder` only contains the type of reply message and no
              // message, there is no need to send the message. When `encoder` only
              // contains the type of reply, its length is 1.
              if (encoding.length(encoder) > 1) {
                await this.send(ws, encoding.toUint8Array(encoder));
              }

              break;
            }
            case SYNC_MESSAGE_TYPE.STEP2:
            case SYNC_MESSAGE_TYPE.UPDATE: {
              const session = this.sessions.get(ws);
              if (session === undefined) {
                return;
              }

              if (session.readonly) {
                console.log('Readonly client tried to send an update', {
                  username: session.username,
                });
                return;
              }

              try {
                const update = decoding.readVarUint8Array(decoder);
                await this.handleUpdateV1(update);
              } catch (error) {
                console.error('Error while handling a Yjs update', error);
              }
              break;
            }
            default:
              throw Error('Unknown sync message type');
          }
          break;
        }
        case MESSAGE_TYPE.AWARENESS: {
          await this.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
          break;
        }
        default:
          throw Error('Unknown message type');
      }
    } catch (error) {
      console.error(error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    console.log('WebSocket closed:', code, reason, wasClean);
    await this.handleClose(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error);
    await this.handleClose(ws);
  }

  async alarm() {
    if (this.enableGC) {
      // Merge updates is fast but does not perform perform garbage-collection
      // so here we load the updates into a Yjs document before persisting them.
      const doc = new Y.Doc({ gc: true });
      Y.applyUpdateV2(doc, this.stateAsUpdateV2);
      this.stateAsUpdateV2 = Y.encodeStateAsUpdateV2(doc);
      doc.destroy();
    }

    // persist merged update
    await this.env.R2_DEFAULT.put(`state:${this.state.id.toString()}`, this.stateAsUpdateV2);

    // Clear partial updates. The storage delete operation supports up to 128 keys at a time
    const chunks = chunkArray(Array.from(this.updateKeys), 128);
    await Promise.all([...chunks].map((chunk) => this.state.storage.delete(chunk)));
  }

  private async handleUpdateV1(updateV1: Uint8Array) {
    const updateV2 = Y.convertUpdateFormatV1ToV2(updateV1);

    // persist update
    const key = `doc:${uuidV7()}`;
    await this.state.storage.put(key, updateV2);

    // merge update
    this.stateAsUpdateV2 = Y.mergeUpdatesV2([this.stateAsUpdateV2, updateV2]);

    // save key for vacuuming
    this.updateKeys.add(key);

    // setup alarm to vacuum storage
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null) {
      await this.state.storage.setAlarm(Date.now() + this.vacuumIntervalInMs);
    }

    // broadcast update
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
    encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.UPDATE);
    encoding.writeVarUint8Array(encoder, updateV1);
    const message = encoding.toUint8Array(encoder);
    await this.broadcast(message);
  }

  private async handleAwarenessChange(
    {
      added,
      updated,
      removed,
    }: { added: Array<number>; updated: Array<number>; removed: Array<number> },
    ws: WebSocket | null,
  ) {
    const changedClients = [...added, ...updated, ...removed];

    if (ws !== null) {
      const session = this.sessions.get(ws);

      if (session === undefined) {
        return;
      }

      added.forEach((clientID) => {
        session.controlledIds.add(clientID);
      });

      removed.forEach((clientID) => {
        session.controlledIds.delete(clientID);
      });
    }

    // broadcast awareness update
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changedClients));
    await this.broadcast(encoding.toUint8Array(encoder));

    // persist awareness
    const state = this.awareness.getLocalState();
    await this.state.storage.put('awareness', state);
  }

  private async handleSession(
    webSocket: WebSocket,
    { username, color, readonly }: { username: string; color: string; readonly: boolean },
  ) {
    webSocket.serializeAttachment({
      ...webSocket.deserializeAttachment(),
      username,
      readonly,
    });

    this.sessions.set(webSocket, { controlledIds: new Set(), username, color, readonly });

    // send sync step 1 to get client updates
    const stateVector = Y.encodeStateVectorFromUpdateV2(this.stateAsUpdateV2);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
    encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP1);
    encoding.writeVarUint8Array(encoder, stateVector);
    await this.send(webSocket, encoding.toUint8Array(encoder));

    // send awareness update
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_TYPE.AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())),
      );
      await this.send(webSocket, encoding.toUint8Array(awarenessEncoder));
    }
  }

  private async handleClose(webSocket: WebSocket) {
    webSocket.close(1011); // ensure websocket is closed

    const session = this.sessions.get(webSocket);
    if (session === undefined) {
      return;
    }

    await this.removeAwarenessStates(this.awareness, Array.from(session.controlledIds), webSocket);

    this.sessions.delete(webSocket);

    if (this.sessions.size === 0) {
      // delete awareness storage entry if no one is connected anymore
      await this.state.storage.delete('awareness');
    }
  }

  private async send(ws: WebSocket, message: Uint8Array) {
    try {
      ws.send(message);
    } catch (error) {
      await this.handleClose(ws);
    }
  }

  private async broadcast(message: Uint8Array) {
    await Promise.all([...this.sessions.keys()].map((ws) => this.send(ws, message)));
  }

  // https://github.com/yjs/y-protocols/blob/ba21a9c92990743554e47223c49513630b7eadda/awareness.js#L167
  private async removeAwarenessStates(awareness: Awareness, clients: number[], origin: WebSocket) {
    const removed = [];
    for (let i = 0; i < clients.length; i += 1) {
      const clientID = clients[i];
      if (awareness.states.has(clientID)) {
        awareness.states.delete(clientID);
        if (clientID === awareness.clientID) {
          const curMeta = awareness.meta.get(clientID)!;
          awareness.meta.set(clientID, {
            clock: curMeta.clock + 1,
            lastUpdated: time.getUnixTime(),
          });
        }
        removed.push(clientID);
      }
    }
    if (removed.length > 0) {
      await this.handleAwarenessChange(
        {
          added: [],
          updated: [],
          removed,
        },
        origin,
      );
    }
  }

  // https://github.com/yjs/y-protocols/blob/ba21a9c92990743554e47223c49513630b7eadda/awareness.js#L241
  // eslint-disable-next-line max-statements, complexity
  private async applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: WebSocket) {
    const decoder = decoding.createDecoder(update);
    const timestamp = time.getUnixTime();
    const added = [];
    const updated = [];
    const filteredUpdated = [];
    const removed = [];
    const len = decoding.readVarUint(decoder);
    for (let i = 0; i < len; i += 1) {
      const clientID = decoding.readVarUint(decoder);
      let clock = decoding.readVarUint(decoder);
      const clientState = JSON.parse(decoding.readVarString(decoder));
      const serverState = {
        // user info is managed by the server
        user: {
          name: this.sessions.get(origin)?.username,
          color: this.sessions.get(origin)?.color,
        },
      };
      const state = {
        ...clientState,
        ...serverState,
      };
      const clientMeta = awareness.meta.get(clientID);
      const prevState = awareness.states.get(clientID);
      const currClock = clientMeta === undefined ? 0 : clientMeta.clock;
      if (
        currClock < clock ||
        (currClock === clock && state === null && awareness.states.has(clientID))
      ) {
        if (state === null) {
          // never let a remote client remove this local state
          if (clientID === awareness.clientID && awareness.getLocalState() !== null) {
            // remote client removed the local state. Do not remote state. Broadcast a message indicating
            // that this client still exists by increasing the clock
            clock += 1;
          } else {
            awareness.states.delete(clientID);
          }
        } else {
          awareness.states.set(clientID, state);
        }
        awareness.meta.set(clientID, {
          clock,
          lastUpdated: timestamp,
        });
        if (clientMeta === undefined && state !== null) {
          added.push(clientID);
        } else if (clientMeta !== undefined && state === null) {
          removed.push(clientID);
        } else if (state !== null) {
          if (!f.equalityDeep(state, prevState)) {
            filteredUpdated.push(clientID);
          }
          updated.push(clientID);
        }
      }
    }

    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      await this.handleAwarenessChange(
        {
          added,
          updated,
          removed,
        },
        origin,
      );
    }
  }
}
