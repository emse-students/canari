const fs = require('fs');
let code = fs.readFileSync('D:/Documents/Programmation/EMSE/Canari/apps/chat-gateway/src/handlers.rs', 'utf8');

const guardStruct = `struct ConnectionGuard {
    state: Arc<AppState>,
    conn_key: String,
    redis_key: String,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        tracing::info!("Executing guaranteed cleanup (Drop) for connection keys {} / {}", self.conn_key, self.redis_key);
        // Clean HashMap
        {
            let mut map = self.state.connected_users.lock().unwrap();
            if let Some(senders) = map.get_mut(&self.conn_key) {
                // Remove closed senders
                senders.retain(|s| !s.is_closed());
                if senders.is_empty() {
                    map.remove(&self.conn_key);
                }
            }
        }
        // Background Redis Clean
        let state = self.state.clone();
        let redis_key = self.redis_key.clone();
        tokio::spawn(async move {
            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                let _: Result<(), _> = redis::cmd("DEL").arg(&redis_key).query_async(&mut con).await;
            }
        });
    }
}
`;

code = code.replace('// --- WebSocket Handler ---', '// --- WebSocket Handler ---\n\n' + guardStruct);

const setupGuard = `    // Register presence in Redis
    let redis_key = format!("user:online:{}", conn_key);

    // Register the Guard struct to ensure that, upon any panic or early return in the stream, we cleanup Redis + HashMap
    let _guard = ConnectionGuard {
        state: state.clone(),
        conn_key: conn_key.clone(),
        redis_key: redis_key.clone(),
    };
`;

code = code.replace(/\s+\/\/ Register presence in Redis\s+let redis_key = format!\("user:online:\{\}", conn_key\);/g, '\n' + setupGuard + '\n');

// the actual text we're replacing
let endCleanup = `    // Cleanup — remove only dead senders for this key
    {
        let mut map = state.connected_users.lock().unwrap();
        if let Some(senders) = map.get_mut(&conn_key) {
            senders.retain(|s| !s.is_closed());
            if senders.is_empty() {
                map.remove(&conn_key);
            }
        }
    }
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let _: Result<(), _> = con.del(&redis_key).await;
    }`;

code = code.replace(endCleanup, '    // Note: Cleanup is now guaranteed safely by the ConnectionGuard struct Drop trait.');

fs.writeFileSync('D:/Documents/Programmation/EMSE/Canari/apps/chat-gateway/src/handlers.rs', code);
console.log('Done');
