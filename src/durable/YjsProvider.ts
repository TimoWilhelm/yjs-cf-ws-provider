/*
 *                   Yjs Sync Protocol
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

import { DurableObject } from 'cloudflare:workers';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { equalityDeep } from 'lib0/function';
import { Temporal } from 'temporal-polyfill';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import z from 'zod';

type DbUpdate = {
	id: number;
	data: ArrayBuffer;
};

type DbAwareness = {
	id: 0;
	state: string;
};

interface SessionInfo {
	readonly: boolean;
}

const enum MESSAGE_TYPE {
	SYNC = 0,
	AWARENESS = 1,
}

const enum SYNC_MESSAGE_TYPE {
	STEP1 = 0,
	STEP2 = 1,
	UPDATE = 2,
}

export class YjsProvider extends DurableObject {
	private sessions: Map<
		WebSocket,
		{
			controlledIds: Set<number>;
			context: SessionInfo;
		}
	> = new Map();

	private stateAsUpdateV2: Uint8Array = new Uint8Array();

	private readonly awareness = new Awareness(new Y.Doc());

	private readonly vacuumInterval: Temporal.Duration;

	constructor(public readonly ctx: DurableObjectState, public readonly env: Env) {
		super(ctx, env);

		// setup tables
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS doc_updates(
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				data BLOB
			);`);

		const vacuumIntervalInMs = z.coerce.number().positive().optional().parse(env.YJS_VACUUM_INTERVAL_IN_MS);

		this.vacuumInterval =
			vacuumIntervalInMs === undefined
				? Temporal.Duration.from({ seconds: 30 })
				: Temporal.Duration.from({ milliseconds: vacuumIntervalInMs });

		this.ctx.getWebSockets().forEach((ws) => {
			const meta = ws.deserializeAttachment();
			this.sessions.set(ws, { ...meta });
		});

		// hydrate DO state
		void this.ctx.blockConcurrencyWhile(async () => {
			const updates = [] as Uint8Array[];

			const result = await env.R2_YJS_BUCKET.get(`state:${this.ctx.id.toString()}`);
			if (result) {
				const baseUpdate = new Uint8Array(await result.arrayBuffer());
				updates.push(baseUpdate);
			}

			const cursor = this.ctx.storage.sql.exec<DbUpdate>('SELECT * FROM doc_updates');

			for (const row of cursor) {
				updates.push(new Uint8Array(row.data));
			}

			this.stateAsUpdateV2 = Y.mergeUpdatesV2(updates);
		});
	}

	public fetch(request: Request): Response | Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/ws') {
			return new Response('Not found', { status: 404 });
		}

		if (request.headers.get('upgrade') !== 'websocket') {
			return new Response('Invalid Upgrade header', { status: 400 });
		}

		return this.acceptWebsocket({ readonly: false });
	}

	public async alarm(): Promise<void> {
		// Merge updates is fast but does not perform perform garbage-collection
		// so here we load the updates into a Yjs document before persisting them.
		const doc = new Y.Doc({ gc: true });
		Y.applyUpdateV2(doc, this.stateAsUpdateV2);
		this.stateAsUpdateV2 = Y.encodeStateAsUpdateV2(doc);
		doc.destroy();

		// Persist merged update
		await this.env.R2_YJS_BUCKET.put(`state:${this.ctx.id.toString()}`, this.stateAsUpdateV2);

		// Clear partial updates
		this.ctx.storage.sql.exec('DELETE FROM doc_updates;');
	}

	public async cleanup(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	public acceptWebsocket(sessionInfo: SessionInfo): Response {
		const pair = new WebSocketPair() as {
			0: WebSocket;
			1: WebSocket;
		};

		this.ctx.acceptWebSocket(pair[1]);
		this.handleSession(pair[1], sessionInfo);

		return new Response(null, {
			status: 101,
			webSocket: pair[0],
		});
	}

	public getSnapshot(): ReadableStream<Uint8Array> {
		return new ReadableStream({
			start: (controller) => {
				controller.enqueue(this.stateAsUpdateV2);
				controller.close();
			},
		});
	}

	public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
								this.send(ws, encoding.toUint8Array(encoder));
							}

							break;
						}
						case SYNC_MESSAGE_TYPE.STEP2:
						case SYNC_MESSAGE_TYPE.UPDATE: {
							const session = this.sessions.get(ws);
							if (session === undefined) {
								console.warn('Ignoring update from unknown session');
								return;
							}

							if (session.context.readonly) {
								// ignore updates from readonly clients
								console.warn('Ignoring update from readonly client');
								return;
							}

							try {
								const update = decoding.readVarUint8Array(decoder);
								await this.handleUpdateV1(update);
							} catch (err) {
								console.error('Error while handling a Yjs update', err);
							}
							break;
						}
						default:
							throw new Error('Unknown sync message type');
					}
					break;
				}
				case MESSAGE_TYPE.AWARENESS: {
					this.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
					break;
				}
				default:
					throw new Error('Unknown message type');
			}
		} catch (err) {
			console.error(err);
		}
	}

	public webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		console.log('WebSocket closed:', code, reason, wasClean);
	}

	public webSocketError(ws: WebSocket, err: unknown): void {
		console.error('WebSocket error:', err);
		this.handleClose(ws);
	}

	private async handleUpdateV1(updateV1: Uint8Array) {
		const updateV2 = Y.convertUpdateFormatV1ToV2(updateV1);

		// persist update
		this.ctx.storage.sql.exec<Pick<DbUpdate, 'id'>>(`INSERT INTO doc_updates (data) VALUES (?)`, [updateV2.buffer]);

		// merge update
		this.stateAsUpdateV2 = Y.mergeUpdatesV2([this.stateAsUpdateV2, updateV2]);

		// setup alarm to vacuum storage
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null) {
			await this.ctx.storage.setAlarm(Temporal.Now.instant().add(this.vacuumInterval).epochMilliseconds);
		}

		// broadcast update
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.UPDATE);
		encoding.writeVarUint8Array(encoder, updateV1);
		const message = encoding.toUint8Array(encoder);
		this.broadcast(message);
	}

	private handleAwarenessChange(
		{ added, updated, removed }: { added: Array<number>; updated: Array<number>; removed: Array<number> },
		ws: WebSocket | null
	) {
		const changedClients = [...added, ...updated, ...removed];

		if (ws !== null) {
			const session = this.sessions.get(ws);

			if (session === undefined) {
				console.warn('Ignoring awareness change from unknown session');
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
		this.broadcast(encoding.toUint8Array(encoder));
	}

	private handleSession(webSocket: WebSocket, sessionInfo: SessionInfo) {
		webSocket.serializeAttachment({
			...webSocket.deserializeAttachment(),
			sessionInfo,
		});

		this.sessions.set(webSocket, { controlledIds: new Set(), context: sessionInfo });

		// send sync step 1 to get client updates
		const stateVector = Y.encodeStateVectorFromUpdateV2(this.stateAsUpdateV2);
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP1);
		encoding.writeVarUint8Array(encoder, stateVector);
		this.send(webSocket, encoding.toUint8Array(encoder));

		// send awareness update
		const awarenessStates = this.awareness.getStates();
		if (awarenessStates.size > 0) {
			const awarenessEncoder = encoding.createEncoder();
			encoding.writeVarUint(awarenessEncoder, MESSAGE_TYPE.AWARENESS);
			encoding.writeVarUint8Array(awarenessEncoder, encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())));
			this.send(webSocket, encoding.toUint8Array(awarenessEncoder));
		}
	}

	private handleClose(webSocket: WebSocket) {
		webSocket.close(1011); // ensure websocket is closed

		const session = this.sessions.get(webSocket);
		if (session === undefined) {
			console.warn('Ignoring close from unknown session');
			return;
		}

		this.removeAwarenessStates(this.awareness, Array.from(session.controlledIds), webSocket);

		this.sessions.delete(webSocket);
	}

	private send(ws: WebSocket, message: Uint8Array) {
		try {
			ws.send(message);
		} catch {
			this.handleClose(ws);
		}
	}

	private broadcast(message: Uint8Array) {
		for (const ws of this.sessions.keys()) {
			this.send(ws, message);
		}
	}

	// https://github.com/yjs/y-protocols/blob/ba21a9c92990743554e47223c49513630b7eadda/awareness.js#L167
	private removeAwarenessStates(awareness: Awareness, clients: number[], origin: WebSocket) {
		const removed = [];
		for (let i = 0; i < clients.length; i += 1) {
			const clientID = clients[i];
			if (awareness.states.has(clientID)) {
				awareness.states.delete(clientID);
				if (clientID === awareness.clientID) {
					const curMeta = awareness.meta.get(clientID)!;
					awareness.meta.set(clientID, {
						clock: curMeta.clock + 1,
						lastUpdated: Temporal.Now.instant().epochMilliseconds,
					});
				}
				removed.push(clientID);
			}
		}
		if (removed.length > 0) {
			this.handleAwarenessChange(
				{
					added: [],
					updated: [],
					removed,
				},
				origin
			);
		}
	}

	// https://github.com/yjs/y-protocols/blob/ba21a9c92990743554e47223c49513630b7eadda/awareness.js#L241
	private applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: WebSocket) {
		const decoder = decoding.createDecoder(update);
		const timestamp = Temporal.Now.instant().epochMilliseconds;
		const added = [];
		const updated = [];
		const filteredUpdated = [];
		const removed = [];
		const len = decoding.readVarUint(decoder);
		for (let i = 0; i < len; i += 1) {
			const clientID = decoding.readVarUint(decoder);
			let clock = decoding.readVarUint(decoder);
			const state = JSON.parse(decoding.readVarString(decoder)) as { [x: string]: unknown } | null;

			const session = this.sessions.get(origin);
			if (session === undefined) {
				console.warn('Ignoring awareness update from unknown session');
				return;
			}

			const clientMeta = awareness.meta.get(clientID);
			const prevState = awareness.states.get(clientID);
			const currClock = clientMeta === undefined ? 0 : clientMeta.clock;
			if (currClock < clock || (currClock === clock && state === null && awareness.states.has(clientID))) {
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
					if (!equalityDeep(state, prevState)) {
						filteredUpdated.push(clientID);
					}
					updated.push(clientID);
				}
			}
		}

		if (added.length > 0 || updated.length > 0 || removed.length > 0) {
			this.handleAwarenessChange(
				{
					added,
					updated,
					removed,
				},
				origin
			);
		}
	}
}
