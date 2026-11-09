/**
 * A device with `count` cameras, for a test that renders the camera: the switch button is offered
 * only from two (`CameraSession.canSwitch`), so a screen test that presses it must say so. Returns
 * the undo. Needs a DOM (`navigator` exists).
 */
export function stubCameraCount(count: number): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const devices = Array.from({ length: count }, (_, i) => ({
    kind: 'videoinput',
    deviceId: `cam-${i}`,
  }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: Object.assign(new EventTarget(), { enumerateDevices: async () => devices }),
  });
  return () => {
    if (had) Object.defineProperty(navigator, 'mediaDevices', had);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  };
}
