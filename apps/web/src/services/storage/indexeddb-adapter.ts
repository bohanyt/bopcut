import type { StorageAdapter } from "./types";

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;
	private keepOpen: boolean;
	private connection: Promise<IDBDatabase> | null = null;

	/**
	 * `keepOpen` reuses one connection for every call, for a long-lived store read often (a cache):
	 * opening the database for each call costs about 2 ms in Chromium. The connection closes when
	 * another one asks to delete or upgrade the database. Short-lived adapters open their own.
	 */
	constructor({
		dbName,
		storeName,
		version = 1,
		keepOpen = false,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
		keepOpen?: boolean;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
		this.keepOpen = keepOpen;
	}

	private connect(): Promise<IDBDatabase> {
		if (!this.keepOpen) return this.getDB();
		if (this.connection) return this.connection;
		const pending: Promise<IDBDatabase> = this.getDB().then(
			(db) => {
				const forget = () => {
					if (this.connection === pending) this.connection = null;
				};
				db.onversionchange = () => {
					db.close();
					forget();
				};
				db.onclose = forget;
				return db;
			},
			(error) => {
				if (this.connection === pending) this.connection = null;
				throw error;
			},
		);
		this.connection = pending;
		return pending;
	}

	/** A transaction on this adapter's store; a kept connection the browser closed is opened again. */
	private async begin(mode: IDBTransactionMode): Promise<IDBTransaction> {
		const db = await this.connect();
		if (!this.keepOpen) return this.transaction(db, mode);
		try {
			return db.transaction(this.storeName, mode);
		} catch (error) {
			if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
			this.connection = null;
			return (await this.connect()).transaction(this.storeName, mode);
		}
	}

	private getDB(existingOnly: true): Promise<IDBDatabase | null>;
	private getDB(existingOnly?: false): Promise<IDBDatabase>;
	private async getDB(existingOnly = false): Promise<IDBDatabase | null> {
		return new Promise((resolve, reject) => {
			const request = existingOnly
				? indexedDB.open(this.dbName)
				: indexedDB.open(this.dbName, this.version);
			let missing = false;

			request.onerror = () => missing ? resolve(null) : reject(request.error);
			request.onsuccess = () => resolve(request.result);

			request.onupgradeneeded = () => {
				if (existingOnly) {
					// Abort initial creation so a new installation leaves no empty database.
					missing = true;
					request.transaction?.abort();
				} else if (!request.result.objectStoreNames.contains(this.storeName)) {
					request.result.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
		});
	}

	private transaction(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
		try {
			return db.transaction(this.storeName, mode);
		} finally {
			// Existing transactions can finish. Future calls open their own connection.
			db.close();
		}
	}

	private async readTransaction(existingOnly: boolean): Promise<IDBTransaction | null> {
		if (!existingOnly) return this.begin("readonly");
		const db = await this.getDB(true);
		if (!db) return null;
		if (existingOnly && !db.objectStoreNames.contains(this.storeName)) {
			db.close();
			return null;
		}
		return this.transaction(db, "readonly");
	}

	async get(key: string, { existingOnly = false } = {}): Promise<T | null> {
		const transaction = await this.readTransaction(existingOnly);
		if (!transaction) return null;
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.get(key);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result || null);
		});
	}

	async set({
		key,
		value,
	}: {
		key: string;
		value: T;
	}): Promise<void> {
		const transaction = await this.begin("readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.put({ id: key, ...value });
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async remove(key: string): Promise<void> {
		const transaction = await this.begin("readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.delete(key);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async list(): Promise<string[]> {
		const transaction = await this.begin("readonly");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.getAllKeys();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as string[]);
		});
	}

	async getAll({ existingOnly = false } = {}): Promise<T[]> {
		const transaction = await this.readTransaction(existingOnly);
		if (!transaction) return [];
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result || []);
		});
	}

	async clear(): Promise<void> {
		const transaction = await this.begin("readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.clear();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}
}

export async function deleteDatabase({
	dbName,
}: {
	dbName: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(dbName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}
