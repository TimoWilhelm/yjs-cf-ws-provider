import * as Y from 'yjs';
import StarterKit from '@tiptap/starter-kit';
import { Editor } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { zooId } from './zooId';
import { stringToColor } from './util';
import * as QRCode from 'qrcode';

let roomId = new URLSearchParams(window.location.search).get('room');
if (!roomId) {
	const randomNumber = Math.floor(Math.random() * 100) + 1;
	roomId = `${zooId({ separator: '-' })}-${randomNumber}`;
	const url = new URL(window.location.href);
	url.searchParams.set('room', roomId);
	window.history.replaceState({}, '', url);
}

QRCode.toCanvas(document.getElementById('qr-canvas'), window.location.href);

const username = zooId();

const yDoc = new Y.Doc();

// IndexedDB Persistence to support offline editing
const indexeddbPersistence = new IndexeddbPersistence(`ydoc-${roomId}`, yDoc);

// WebSocket Provider for real-time collaboration
const url = new URL('/yjs/ws', window.location.href);
url.protocol = url.protocol.replace('http', 'ws');
const provider = new WebsocketProvider(url.toString(), roomId, yDoc, {
	connect: false,
	disableBc: true,
});

const editor = new Editor({
	element: document.querySelector('#editor'),
	extensions: [
		StarterKit.configure({
			undoRedo: false, // Collaboration extension handles history (https://tiptap.dev/api/extensions/collaboration#commands)
		}),
		Collaboration.configure({
			document: yDoc,
		}),
		CollaborationCaret.configure({
			provider,
			user: {
				name: username,
				color: stringToColor(username),
			},
		}),
	],
});

const snapshotUpdateBuffer = fetch(`/yjs/snapshot/${roomId}`).then((res) => res.arrayBuffer());

Promise.allSettled([snapshotUpdateBuffer, indexeddbPersistence.whenSynced])
	.then(([result]) => {
		if (result.status === 'fulfilled') {
			const updateBuffer = result.value;
			Y.applyUpdateV2(yDoc, new Uint8Array(updateBuffer));
			console.log('Snapshot Size: ', updateBuffer.byteLength);
		}

		provider.connect();
	})
	.catch((error) => {
		console.error(error);
		alert('Failed to connect');
	});

document.getElementById('copy-link')?.addEventListener('click', () => {
	navigator.clipboard.writeText(window.location.href);
	alert('Room link copied to clipboard!');
});

const connectionToggle = document.getElementById('connection-toggle');
const connectionStatus = document.getElementById('connection-status');

// Update connection status
const updateStatus = (status: 'connected' | 'disconnected' | 'connecting') => {
	if (!connectionStatus || !connectionToggle) {
		return;
	}
	connectionStatus.textContent = `Status: ${status}`;
	connectionToggle.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
};

// Listen for provider status changes
provider.on('status', (event) => {
	updateStatus(event.status);
	console.log(`Provider status: ${event.status}`);
});

provider.awareness.on('change', () => {
	const states = provider.awareness.getStates();
	const participants = Array.from(states.entries())
		.map(([id, value]) => {
			if (value.user === undefined) {
				return null;
			}
			return {
				name: `${value.user.name}${id === provider.awareness.clientID ? ' (you)' : ''}`,
				color: value.user.color,
			};
		})
		.filter(Boolean);

	const participantsDiv = document.querySelector('.participants');
	if (!participantsDiv) {
		return;
	}
	participantsDiv.innerHTML = '';
	participants.forEach((participant) => {
		if (!participant) {
			return;
		}
		const participantDiv = document.createElement('div');
		participantDiv.textContent = participant.name;
		participantDiv.style.color = participant.color;
		participantsDiv.appendChild(participantDiv);
	});
});

// Toggle connection on button click
connectionToggle?.addEventListener('click', () => {
	if (provider.wsconnected) {
		provider.disconnect();
	} else {
		provider.connect();
	}
});
