/*
 * Partially adapted from https://github.com/yjs/y-websocket/
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2025 Kevin Jahns <kevin.jahns@protonmail.com>.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { equalityDeep } from 'lib0/function';
import { Temporal } from 'temporal-polyfill';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import z from 'zod';
import { Browsable } from '@outerbase/browsable-durable-object';
import { DrizzleDurableObject } from '../_util/drizzle-do';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';

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

@Browsable()
export class YjsProvider extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	private sessions = new Map<
		WebSocket,
		{
			controlledIds: Set<number>;
			context: SessionInfo;
		}
	>();

	private stateAsUpdateV2: Uint8Array = new Uint8Array();

	private readonly awareness = new Awareness(new Y.Doc());

	private readonly vacuumInterval: Temporal.Duration;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		const vacuumIntervalInMs = z.coerce.number().positive().optional().parse(env.YJS_VACUUM_INTERVAL_IN_MS);

		this.vacuumInterval =
			vacuumIntervalInMs === undefined
				? Temporal.Duration.from({ seconds: 30 })
				: Temporal.Duration.from({ milliseconds: vacuumIntervalInMs });

		this.ctx.getWebSockets().forEach((ws) => {
			const meta = ws.deserializeAttachment();
			this.sessions.set(ws, { ...meta });
		});

		// patch getDb to run vacuum after storage access
		const originalGetDb = this.getDb.bind(this);
		this.getDb = async () => {
			const db = await originalGetDb();
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm === null) {
				await this.ctx.storage.setAlarm(Temporal.Now.instant().add(this.vacuumInterval).epochMilliseconds);
			}
			return db;
		};

		// hydrate DO state
		void this.ctx.blockConcurrencyWhile(async () => {
			const updates = [] as Uint8Array[];

			const db = await this.getDb();
			const dbUpdates = await db.query.docUpdates.findMany();

			for (const row of dbUpdates) {
				updates.push(new Uint8Array(row.data));
			}

			this.stateAsUpdateV2 = Y.mergeUpdatesV2(updates);
		});
	}

	public async fetch(request: Request): Promise<Response> {
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
		console.log('Alarm fired, vacuuming YjsProvider storage');
		await this.vacuum();
	}

	public cleanup(): void {
		void this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			this.ctx.abort();
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
								await this.send(ws, encoding.toUint8Array(encoder));
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
					await this.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
					break;
				}
				default:
					throw new Error('Unknown message type');
			}
		} catch (err) {
			console.error(err);
		}
	}

	public async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		console.log('WebSocket closed:', code, reason, wasClean);
		await this.handleClose(ws);
	}

	public async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
		console.error('WebSocket error:', err);
		await this.handleClose(ws);
	}

	private async handleUpdateV1(updateV1: Uint8Array) {
		const updateV2 = Y.convertUpdateFormatV1ToV2(updateV1);

		// persist update
		const db = await this.getDb();
		await db
			.insert(schema.docUpdates)
			.values({ data: Buffer.from(updateV2) })
			.execute();

		// merge update
		this.stateAsUpdateV2 = Y.mergeUpdatesV2([this.stateAsUpdateV2, updateV2]);

		// broadcast update
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.UPDATE);
		encoding.writeVarUint8Array(encoder, updateV1);
		const message = encoding.toUint8Array(encoder);
		await this.broadcast(message);
	}

	private async handleAwarenessChange(
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
		await this.broadcast(encoding.toUint8Array(encoder));
	}

	private async handleSession(webSocket: WebSocket, sessionInfo: SessionInfo) {
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
		await this.send(webSocket, encoding.toUint8Array(encoder));

		// send awareness update
		const awarenessStates = this.awareness.getStates();
		if (awarenessStates.size > 0) {
			const awarenessEncoder = encoding.createEncoder();
			encoding.writeVarUint(awarenessEncoder, MESSAGE_TYPE.AWARENESS);
			encoding.writeVarUint8Array(awarenessEncoder, encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())));
			await this.send(webSocket, encoding.toUint8Array(awarenessEncoder));
		}
	}

	private async acceptWebsocket(sessionInfo: SessionInfo): Promise<Response> {
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		await this.handleSession(pair[1], sessionInfo);

		return new Response(null, {
			status: 101,
			webSocket: pair[0],
		});
	}

	private async handleClose(webSocket: WebSocket) {
		webSocket.close(1011); // ensure websocket is closed

		const session = this.sessions.get(webSocket);
		if (session === undefined) {
			console.warn('Ignoring close from unknown session');
			return;
		}

		await this.removeAwarenessStates(this.awareness, Array.from(session.controlledIds), webSocket);

		this.sessions.delete(webSocket);

		if (this.sessions.size === 0) {
			await this.vacuum();
		}
	}

	private async send(ws: WebSocket, message: Uint8Array): Promise<void> {
		try {
			ws.send(message);
		} catch {
			await this.handleClose(ws);
		}
	}

	private async broadcast(message: Uint8Array): Promise<void> {
		await Promise.all(Array.from(this.sessions.keys()).map((ws) => this.send(ws, message)));
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
						lastUpdated: Temporal.Now.instant().epochMilliseconds,
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
				origin
			);
		}
	}

	// https://github.com/yjs/y-protocols/blob/ba21a9c92990743554e47223c49513630b7eadda/awareness.js#L241
	private async applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: WebSocket) {
		const decoder = decoding.createDecoder(update);
		const timestamp = Temporal.Now.instant().epochMilliseconds;
		const added = [];
		const updated = [];
		const filteredUpdated = [];
		const removed = [];
		const len = decoding.readVarUint(decoder);
		for (let i = 0; i < len; i += 1) {
			const session = this.sessions.get(origin);
			if (session === undefined) {
				console.warn('Ignoring awareness update from unknown session');
				return;
			}

			const clientID = decoding.readVarUint(decoder);
			let clock = decoding.readVarUint(decoder);
			let state = JSON.parse(decoding.readVarString(decoder)) as { [x: string]: unknown } | null;

			if (state !== null) {
				state = {
					...state,

					// server managed properties
					isRemote: true,
					readonly: session.context.readonly,
				};
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
			await this.handleAwarenessChange(
				{
					added,
					updated,
					removed,
				},
				origin
			);
		}
	}

	private async vacuum() {
		console.log('Vacuuming YjsProvider storage');

		// Merge updates is fast but does not perform perform garbage-collection
		// so here we load the updates into a Yjs document before persisting them.
		const doc = new Y.Doc({ gc: true });
		Y.applyUpdateV2(doc, this.stateAsUpdateV2);
		this.stateAsUpdateV2 = Y.encodeStateAsUpdateV2(doc);
		doc.destroy();

		// Clear partial updates
		const db = await this.getDb();
		await db.delete(schema.docUpdates);

		console.log('Current number of sessions:', this.sessions.size);

		if (this.sessions.size === 0) {
			console.log('No active sessions, clearing storage');
			await this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
		}
	}
}
