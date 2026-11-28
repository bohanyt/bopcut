import { afterAll, beforeEach, expect, test } from "bun:test";
import { deleteDatabase, IndexedDBAdapter } from "./indexeddb-adapter";

/** Just enough of IndexedDB to count how often a database is opened. */
type FakeDb = {
	objectStoreNames: { contains: (name: string) => boolean };
	createObjectStore: (name: string) => void;
	transaction: (store: string) => { objectStore: () => Record<string, (arg?: unknown) => unknown> };
	close: () => void;
	onversionchange: null | (() => void);
	onclose: null | (() => void);
};
const databases = new Map<string, Map<string, Map<string, unknown>>>();
const connections = new Set<FakeDb>();
let opens = 0;

function answer<T>(result: () => T) {
	const request: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
	setTimeout(() => {
		request.result = result();
		request.onsuccess?.();
	});
	return request;
}

function connect(name: string): FakeDb {
	const stores = databases.get(name)!;
	let closed = false;
	const db: FakeDb = {
		objectStoreNames: { contains: (store) => stores.has(store) },
		createObjectStore: (store) => { stores.set(store, new Map()); },
		transaction: (store) => {
			if (closed) throw new DOMException("The database connection is closing.", "InvalidStateError");
			const records = stores.get(store)!;
			return { objectStore: () => ({
				get: (key) => answer(() => records.get(key as string)),
				put: (value) => answer(() => { records.set((value as { id: string }).id, value); }),
				getAll: () => answer(() => [...records.values()]),
			}) };
		},
		close: () => { closed = true; connections.delete(db); },
		onversionchange: null,
		onclose: null,
	};
	connections.add(db);
	return db;
}

const fakeIndexedDB = {
	open(name: string) {
		opens++;
		const request: { result?: FakeDb; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void; transaction: null } = { transaction: null };
		setTimeout(() => {
			const isNew = !databases.has(name);
			if (isNew) databases.set(name, new Map());
			request.result = connect(name);
			if (isNew) request.onupgradeneeded?.();
			request.onsuccess?.();
		});
		return request;
	},
	deleteDatabase(name: string) {
		// Open connections are asked to close first, as a browser does.
		for (const db of [...connections]) db.onversionchange?.();
		return answer(() => { databases.delete(name); });
	},
};

const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: fakeIndexedDB });
afterAll(() => {
	if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
	else delete (globalThis as Record<string, unknown>).indexedDB;
});
beforeEach(() => {
	databases.clear();
	connections.clear();
	opens = 0;
});

test("a cache adapter opens its database once for many reads", async () => {
	const cache = new IndexedDBAdapter<{ peaks: number[] }>({ dbName: "cache", storeName: "summaries", keepOpen: true });
	await cache.set({ key: "a", value: { peaks: [1, 2] } });
	for (let read = 0; read < 50; read++) expect((await cache.get("a")) as unknown).toEqual({ id: "a", peaks: [1, 2] });
	expect(opens).toBe(1);
});

test("a short-lived adapter still opens and closes its database for each call", async () => {
	const once = new IndexedDBAdapter<{ name: string }>({ dbName: "legacy", storeName: "projects" });
	await once.set({ key: "p", value: { name: "P" } });
	await once.get("p");
	expect(opens).toBe(2);
	expect(connections.size).toBe(0);
});

test("a kept connection closes when the database is deleted, and the next read opens it again", async () => {
	const cache = new IndexedDBAdapter<{ peaks: number[] }>({ dbName: "cache", storeName: "summaries", keepOpen: true });
	await cache.set({ key: "a", value: { peaks: [1] } });
	await deleteDatabase({ dbName: "cache" });
	expect(connections.size).toBe(0);
	expect(await cache.get("a")).toBeNull();
	expect(opens).toBe(2);
});
