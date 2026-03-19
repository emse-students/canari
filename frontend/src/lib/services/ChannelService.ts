export interface CreateWorkspaceDto {
  slug: string;
  name: string;
  createdBy: string;
}

export interface CreateChannelDto {
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
  actorUserId: string;
}

export interface SendChannelMessageDto {
  senderId: string;
  ciphertext: string;
  nonce: string;
}

export class ChannelService {
  private baseUrl: string;

  constructor() {
    // In browser, Vite will proxy /channels to the backend. Default fallback for others:
    this.baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005';
  }

  async healthCheck() {
    const res = await fetch(`${this.baseUrl}/channels/health`);
    return res.json();
  }

  async createWorkspace(dto: CreateWorkspaceDto) {
    const res = await fetch(`${this.baseUrl}/channels/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async createChannel(dto: CreateChannelDto) {
    const res = await fetch(`${this.baseUrl}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async listChannels(workspaceId: string, userId: string) {
    const res = await fetch(`${this.baseUrl}/channels/workspace/${workspaceId}/user/${userId}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async joinChannel(channelId: string, userId: string) {
    const res = await fetch(`${this.baseUrl}/channels/${channelId}/members/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async sendMessage(channelId: string, dto: SendChannelMessageDto) {
    const res = await fetch(`${this.baseUrl}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async listMessages(channelId: string, userId: string, limit = 100) {
    const res = await fetch(
      `${this.baseUrl}/channels/${channelId}/messages?userId=${userId}&limit=${limit}`
    );
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}

export const channelService = new ChannelService();
