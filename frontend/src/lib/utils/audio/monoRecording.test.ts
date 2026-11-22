/**
 * ONE CHANNEL, WHATEVER THE ENGINE GRANTED (iPhone 12, `1.7.3-alpha.4`: a voice note was AAC in two
 * channels while mono was asked). The decision is the track's reported channel count; the graph is
 * the engine's own downmix, pinned to one channel.
 */
import { describe, it, expect, vi } from 'vitest';
import { monoRecordingStream } from './monoRecording';

function microphone(settings: MediaTrackSettings) {
  const track = { getSettings: () => settings, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function fakeContext(state: AudioContextState = 'running') {
  const sinkTrack = { stop: vi.fn() };
  const sink = {
    channelCount: 2,
    channelCountMode: 'max' as ChannelCountMode,
    channelInterpretation: 'discrete' as ChannelInterpretation,
    stream: { getTracks: () => [sinkTrack] },
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state,
    sampleRate: 48000,
    onstatechange: null as (() => void) | null,
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => sink),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  return { context, sink, source, sinkTrack };
}

describe('monoRecordingStream', () => {
  it('records a track that reports one channel as granted, with no graph at all', () => {
    const create = vi.fn();
    const mic = microphone({ channelCount: 1, sampleRate: 48000 });
    const recorded = monoRecordingStream(mic, create);
    expect(recorded.stream).toBe(mic);
    expect(recorded.downmixed).toBe(false);
    expect(create).not.toHaveBeenCalled();
    recorded.release();
  });

  it.each([
    ['two channels', { channelCount: 2, sampleRate: 48000 }],
    ['no channel count reported (WebKit)', { sampleRate: 48000 }],
  ])('downmixes %s to ONE channel and records the downmix', (_name, settings) => {
    const fake = fakeContext();
    const create = vi.fn(() => fake.context as unknown as AudioContext);
    const recorded = monoRecordingStream(microphone(settings), create);

    expect(create).toHaveBeenCalledWith(48000);
    expect(recorded.downmixed).toBe(true);
    expect(recorded.stream).toBe(fake.sink.stream);
    expect(fake.sink.channelCount).toBe(1);
    expect(fake.sink.channelCountMode).toBe('explicit');
    expect(fake.sink.channelInterpretation).toBe('speakers');
    expect(fake.source.connect).toHaveBeenCalledWith(fake.sink);
    expect(fake.context.resume).not.toHaveBeenCalled();
  });

  it('starts a context the engine made suspended', () => {
    const fake = fakeContext('suspended');
    monoRecordingStream(microphone({}), () => fake.context as unknown as AudioContext);
    expect(fake.context.resume).toHaveBeenCalledTimes(1);
  });

  it('releases the graph, its track and its context once, however often it is asked', () => {
    const fake = fakeContext();
    const recorded = monoRecordingStream(
      microphone({ channelCount: 2 }),
      () => fake.context as unknown as AudioContext
    );
    recorded.release();
    recorded.release();
    expect(fake.source.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.sinkTrack.stop).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('closes the context and throws when the engine refuses the graph', () => {
    const fake = fakeContext();
    fake.context.createMediaStreamSource.mockImplementation(() => {
      throw new DOMException('refused', 'NotSupportedError');
    });
    expect(() =>
      monoRecordingStream(microphone({}), () => fake.context as unknown as AudioContext)
    ).toThrow('refused');
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });
});
