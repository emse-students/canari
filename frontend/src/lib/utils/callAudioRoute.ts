/**
 * Where the page asks a call's audio element to sound on iOS: the loudspeaker or the earpiece.
 *
 * WebKit lists NO output labelled "earpiece" - the receiver is not an enumerable device, it is where
 * a PlayAndRecord session (the microphone is held) sounds BY DEFAULT. So the earpiece is never
 * found by label, and asking for it means "the default output": `setSinkId('')` when the engine has
 * `setSinkId` (it undoes an earlier loudspeaker choice), nothing at all when it has not (nothing was
 * ever moved off the default). Only the loudspeaker is looked up by label, and failing to find it IS
 * a fact worth a line. The REAL route is the audio session's, read natively by the proximity handler
 * (`canari_ios.mm`), which is what decides the screen-off; this is the page's best-effort request.
 */
export type SpeakerRoutePlan =
  | { kind: 'device'; deviceId: string }
  | { kind: 'default' }
  | { kind: 'already-default' }
  | { kind: 'unavailable' };

/** The subset of a media device this reads. */
export interface RouteCandidate {
  kind: string;
  label: string;
  deviceId: string;
}

/**
 * Decides the route for `speaker` (true = loudspeaker). `canSetSink` is whether the element has
 * `setSinkId` at all.
 */
export function planSpeakerRoute(
  devices: readonly RouteCandidate[],
  speaker: boolean,
  canSetSink: boolean
): SpeakerRoutePlan {
  if (!canSetSink) return speaker ? { kind: 'unavailable' } : { kind: 'already-default' };
  const kind = speaker ? 'speaker' : 'earpiece';
  const target = devices.find(
    (d) => d.kind === 'audiooutput' && d.label.toLowerCase().includes(kind)
  );
  if (target) return { kind: 'device', deviceId: target.deviceId };
  return speaker ? { kind: 'unavailable' } : { kind: 'default' };
}
