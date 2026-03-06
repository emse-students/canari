export interface IMlsService {
    init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
    createGroup(groupId: string): Promise<void>;
    saveState(pin: string): Promise<Uint8Array>;
    generateKeyPackage(pin: string): Promise<Uint8Array>;
    addMember(groupId: string, keyPackageBytes: Uint8Array): Promise<{ commit: Uint8Array, welcome?: Uint8Array }>;
    processWelcome(welcomeBytes: Uint8Array): Promise<string>;
    sendMessage(groupId: string, message: string): Promise<Uint8Array>;
    processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<string | null>;
    
    // Networking
    connect(token: string): Promise<void>;
    fetchKeyPackage(userId: string): Promise<Uint8Array | null>;
    publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
    sendWelcome(welcomeBytes: Uint8Array, targetUserId: string, groupId: string): Promise<void>;
    requestConversation(targetUserId: string): Promise<void>;
    fetchHistory(groupId: string): Promise<{ sender_id: string, content: string, timestamp: string }[]>;
    
    // Callbacks
    onMessage(callback: (senderId: string, content: Uint8Array) => void): void;
    onConversationRequest(callback: (requesterId: string) => void): void;
}
