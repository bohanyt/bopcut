import type { StorageAdapter } from "./types";

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor({
		dbName,
		storeName,
		version = 1,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
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
		const db = existingOnly ? await this.getDB(true) : await this.getDB();
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
		const db = await this.getDB();
		const transaction = this.transaction(db, "readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.put({ id: key, ...value });
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async remove(key: string): Promise<void> {
		const db = await this.getDB();
		const transaction = this.transaction(db, "readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.delete(key);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async list(): Promise<string[]> {
		const db = await this.getDB();
		const transaction = this.transaction(db, "readonly");
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
		const db = await this.getDB();
		const transaction = this.transaction(db, "readwrite");
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
