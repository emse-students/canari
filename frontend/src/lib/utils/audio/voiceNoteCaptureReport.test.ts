import { describe, it, expect } from 'vitest';
import { classifyInputDevice, describeVoiceNoteCapture } from './voiceNoteCaptureReport';

describe('classifyInputDevice', () => {
  it('names the class and never keeps the label', () => {
    expect(classifyInputDevice("Marie's AirPods Pro")).toBe('bluetooth');
    expect(classifyInputDevice('Bluetooth Headset')).toBe('bluetooth');
    expect(classifyInputDevice('Wired Headset')).toBe('headset');
    expect(classifyInputDevice('Microphone array')).toBe('builtin-or-other');
    expect(classifyInputDevice('')).toBe('unlabelled');
    expect(classifyInputDevice(undefined)).toBe('unlabelled');
  });
});

describe('describeVoiceNoteCapture', () => {
  const track = {
    label: "Marie's AirPods Pro",
    getSettings: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1,
    }),
  };

  it('reports the granted settings, the class of device and the recorder facts', () => {
    const line = describeVoiceNoteCapture(
      track,
      { mimeType: 'audio/mp4', audioBitsPerSecond: 64000 },
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true },
      { downmixed: false }
    );
    expect(line).toBe(
      'capture: echo=true noise=true agc=true rate=16000 size=unsupported ch=1 rec=as-granted ' +
        'device=bluetooth mime=audio/mp4 bps=64000 ' +
        'exposed=[autoGainControl,channelCount,echoCancellation,noiseSuppression,sampleRate]'
    );
    expect(line).not.toContain('Marie');
  });

  it('says UNSUPPORTED for what the engine does not implement, as WebKit (iPhone 12, 1.7.3-alpha.4)', () => {
    // WebKit's supported constraints and settings for a microphone: no noise, gain nor channels.
    const webkit = {
      label: 'iPhone Microphone',
      getSettings: () => ({
        deviceId: 'opaque-id',
        groupId: 'opaque-group',
        echoCancellation: false,
        sampleRate: 48000,
        sampleSize: 16,
      }),
    };
    const line = describeVoiceNoteCapture(
      webkit,
      { mimeType: 'audio/mp4', audioBitsPerSecond: 0 },
      { deviceId: true, groupId: true, echoCancellation: true, sampleRate: true, sampleSize: true },
      { downmixed: true }
    );
    expect(line).toBe(
      'capture: echo=false noise=unsupported agc=unsupported rate=48000 size=16 ch=unsupported ' +
        'rec=mono-downmix device=builtin-or-other mime=audio/mp4 bps=? ' +
        'exposed=[echoCancellation,sampleRate,sampleSize]'
    );
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('opaque');
  });

  it('says UNREPORTED for what the engine implements but did not report, never undefined', () => {
    const line = describeVoiceNoteCapture(undefined, { mimeType: '', audioBitsPerSecond: 0 });
    expect(line).toBe(
      'capture: echo=unreported noise=unreported agc=unreported rate=unreported size=unreported ' +
        'ch=unreported rec=? device=unlabelled mime=? bps=? exposed=[]'
    );
  });
});
