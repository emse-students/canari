import { ApiRefusalError } from '$lib/utils/apiRefusalError';

/**
 * The server ANSWERED `404` for a salon read mark: the salon no longer exists. Classified at the
 * throw (`ChannelService.advanceReadMark`) so the owed-mark queue drops the mark by TYPE, never by
 * reading a message. Its own tiny module so the queue does not import the whole channel service.
 */
export class SalonGoneError extends ApiRefusalError {
  constructor(readonly channelId: string) {
    super(404, null, `salon ${channelId} is gone (404)`);
    this.name = 'SalonGoneError';
  }
}
