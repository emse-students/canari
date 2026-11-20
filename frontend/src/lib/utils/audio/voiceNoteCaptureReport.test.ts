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
    const line = describeVoiceNoteCapture(track, {
      mimeType: 'audio/mp4',
      audioBitsPerSecond: 64000,
    });
    expect(line).toBe(
      'capture: echo=true noise=true agc=true rate=16000Hz ch=1 device=bluetooth mime=audio/mp4 bps=64000'
    );
    expect(line).not.toContain('Marie');
  });

  it('marks what the engine did not report', () => {
    const line = describeVoiceNoteCapture(undefined, { mimeType: '', audioBitsPerSecond: 0 });
    expect(line).toBe(
      'capture: echo=undefined noise=undefined agc=undefined rate=?Hz ch=? device=unlabelled mime=? bps=?'
    );
  });
});
