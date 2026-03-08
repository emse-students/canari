export interface IMlsService {
    init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
    createGroup(groupId: string): Promise<void>;
    createRemoteGroup(name: string): Promise<string>;
    saveState(pin: string): Promise<Uint8Array>;
    generateKeyPackage(pin: string): Promise<Uint8Array>;
    addMember(groupId: string, keyPackageBytes: Uint8Array): Promise<{ commit: Uint8Array, welcome?: Uint8Array }>;
    addMembersBulk(groupId: string, devices: Array<{ keyPackage: Uint8Array, deviceId: string }>): Promise<{ commit: Uint8Array, welcome?: Uint8Array, addedDeviceIds: string[] }>;
    processWelcome(welcomeBytes: Uint8Array): Promise<string>;
    sendMessage(groupId: string, message: string): Promise<Uint8Array>;
    processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<string | null>;
    
    // Networking
    connect(token: string): Promise<void>;
    fetchUserDevices(userId: string): Promise<Array<{ keyPackage: Uint8Array, deviceId: string }>>;
    publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
    sendWelcome(welcomeBytes: Uint8Array, targetUserId: string, groupId: string, targetDeviceId?: string): Promise<void>;
    sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void>; // New Method for WS priority
    registerMember(groupId: string, userId: string, deviceId: string): Promise<void>;
    fetchHistory(groupId: string): Promise<{ sender_id: string, content: string, timestamp: string }[]>;
    getDeviceId(): string;
    
    // Group management
    renameGroup(groupId: string, name: string): Promise<void>;
    deleteGroupOnServer(groupId: string): Promise<void>;
    removeMemberFromServer(groupId: string, userId: string): Promise<void>;
    getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]>;
    
    // Callbacks
    onMessage(callback: (senderId: string, content: Uint8Array, groupId?: string) => Promise<boolean>): void;
}
