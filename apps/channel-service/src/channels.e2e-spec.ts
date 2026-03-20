import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppController } from './app.controller';
import { ChannelService } from './channel.service';

describe('Channel API (e2e)', () => {
  let app: INestApplication;

  const serviceMock = {
    createWorkspace: jest.fn(),
    getWorkspaceBySlug: jest.fn(),
    listWorkspacesForUser: jest.fn(),
    createRole: jest.fn(),
    createChannel: jest.fn(),
    listChannelsForUser: jest.fn(),
    joinChannel: jest.fn(),
    leaveChannel: jest.fn(),
    kickMember: jest.fn(),
    updateMemberRole: jest.fn(),
    sendMessage: jest.fn(),
    listMessages: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: ChannelService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/channels/health returns ok status', async () => {
    const response = await request(app.getHttpServer()).get('/api/channels/health').expect(200);

    expect(response.body.service).toBe('channel-service');
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.timestamp).toBe('string');
  });

  it('POST /api/channels/:id/members/join forwards payload to service', async () => {
    const channelId = 'channel-123';
    const payload = {
      userId: 'alice',
      roleName: 'member',
      actorUserId: 'owner',
    };
    serviceMock.joinChannel.mockResolvedValue({ joined: true, historyVisible: true, keyVersion: 1 });

    const response = await request(app.getHttpServer())
      .post(`/api/channels/${channelId}/members/join`)
      .send(payload)
      .expect(201);

    expect(serviceMock.joinChannel).toHaveBeenCalledWith(channelId, payload);
    expect(response.body).toEqual({ joined: true, historyVisible: true, keyVersion: 1 });
  });

  it('POST /api/channels/:id/members/kick forwards payload to service', async () => {
    const channelId = 'channel-123';
    const payload = {
      targetUserId: 'alice',
      actorUserId: 'owner',
    };
    serviceMock.kickMember.mockResolvedValue({ kicked: true, keyRotated: false });

    const response = await request(app.getHttpServer())
      .post(`/api/channels/${channelId}/members/kick`)
      .send(payload)
      .expect(201);

    expect(serviceMock.kickMember).toHaveBeenCalledWith(channelId, payload);
    expect(response.body).toEqual({ kicked: true, keyRotated: false });
  });

  it('GET /api/channels/workspace/:workspaceId/user/:userId returns channels', async () => {
    const workspaceId = 'workspace-1';
    const userId = 'alice';
    serviceMock.listChannelsForUser.mockResolvedValue([
      { _id: 'c1', workspaceId, name: 'general', visibility: 'public' },
      { _id: 'c2', workspaceId, name: 'staff', visibility: 'private' },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/channels/workspace/${workspaceId}/user/${userId}`)
      .expect(200);

    expect(serviceMock.listChannelsForUser).toHaveBeenCalledWith(workspaceId, userId);
    expect(response.body).toHaveLength(2);
    expect(response.body[1].visibility).toBe('private');
  });
});
