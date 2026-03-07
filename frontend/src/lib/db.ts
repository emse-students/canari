import { encryptData, decryptData } from './encryption';

export interface IMessageStorage {
    init(): Promise<void>;
    saveMessage(message: any, pin: string): Promise<void>;
    getMessages(pin: string): Promise<any[]>;
    clear(): Promise<void>;
}

// --- IndexedDB Implementation (Web) ---
export class IndexedDbStorage implements IMessageStorage {
    private dbName = "CanariDB";
    private storeName = "messages";
    private db: IDBDatabase | null = null;

    async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            
            request.onerror = () => reject("IndexedDB error");
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as any).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id" });
                }
            };
        });
    }

    async saveMessage(message: any, pin: string): Promise<void> {
        if (!this.db) await this.init();
        
        // Encrypt content
        const encrypted = await encryptData(message, pin);
        
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            
            // Store with metadata but encrypted payload
            const entry = {
                id: message.id || Date.now().toString(),
                timestamp: Date.now(),
                ...encrypted // salt, iv, cipherText
            };
            
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getMessages(pin: string): Promise<any[]> {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = async () => {
                const results = request.result;
                const decryptedMessages = [];
                
                for (const entry of results) {
                    try {
                        const content = await decryptData(
                            entry.cipherText, 
                            entry.iv, 
                            entry.salt, 
                            pin
                        );
                        decryptedMessages.push(content);
                    } catch (e) {
                         console.warn("Failed to decrypt message", entry.id);
                    }
                }
                
                // Sort by timestamp
                decryptedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                resolve(decryptedMessages);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clear(): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], "readwrite");
            transaction.objectStore(this.storeName).clear();
            transaction.oncomplete = () => resolve();
        });
    }
}

// --- SQLite Implementation (Mobile/Tauri) ---
// Requires @tauri-apps/plugin-sql
export class SqliteStorage implements IMessageStorage {
    private db: any = null;
    private dbPath = "sqlite:canari.db";

    async init(): Promise<void> {
        try {
            // Dynamic import to avoid build errors if plugin not installed
             // @ts-expect-error - tauri plugin may not be installed
             const Database = (await import('@tauri-apps/plugin-sql')).default;
             this.db = await Database.load(this.dbPath);
             
             await this.db.execute(`
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    timestamp INTEGER,
                    iv BLOB,
                    salt BLOB,
                    cipher_text BLOB
                )
             `);
        } catch (e) {
            console.error("SQLite init failed (plugin might be missing):", e);
            throw e;
        }
    }

    async saveMessage(message: any, pin: string): Promise<void> {
        if (!this.db) await this.init();
        
        const encrypted = await encryptData(message, pin);
        
        // SQLite blobs need Uint8Array
        await this.db.execute(
            "INSERT OR REPLACE INTO messages (id, timestamp, iv, salt, cipher_text) VALUES ($1, $2, $3, $4, $5)",
            [
                message.id || Date.now().toString(),
                Date.now(),
                encrypted.iv,
                encrypted.salt, // Store raw bytes? plugin-sql handles Uint8Array usually.
                encrypted.cipherText
            ]
        );
    }

    async getMessages(pin: string): Promise<any[]> {
        if (!this.db) await this.init();
        
        const rows: any[] = await this.db.select("SELECT * FROM messages ORDER BY timestamp ASC");
        const decryptedMessages = [];
        
        for (const row of rows) {
            try {
                // Convert back from plugin format (might be array of numbers)
                // Assuming plugin returns Uint8Array or standard array
                const iv = new Uint8Array(row.iv);
                const salt = new Uint8Array(row.salt);
                const cipherText = new Uint8Array(row.cipher_text);
                
                const content = await decryptData(cipherText, iv, salt, pin);
                decryptedMessages.push(content);
            } catch (e) {
                console.warn("Failed to decrypt SQLite row", e);
            }
        }
        return decryptedMessages;
    }

    async clear(): Promise<void> {
         if (!this.db) await this.init();
         await this.db.execute("DELETE FROM messages");
    }
}

// Factory
export async function getStorage(): Promise<IMessageStorage> {
    // Check if running in Tauri environment
    // @ts-expect-error - window may not have __TAURI_INTERNALS__
    if (window.__TAURI_INTERNALS__) {
        console.log("Tauri detected. Attempting to load SQLite plugin...");
        try {
            const sqlite = new SqliteStorage();
            await sqlite.init();
            console.log("Using SQLite Storage (Mobile/Desktop)");
            return sqlite;
        } catch (e) {
            console.warn("SQLite plugin not available or failed to load. Falling back to IndexedDB.", e);
            // Fallback
            const idb = new IndexedDbStorage();
            await idb.init();
            return idb;
        }
    } else {
        console.log("Using IndexedDB Storage (Web)");
        const idb = new IndexedDbStorage();
        await idb.init();
        return idb;
    }
}
