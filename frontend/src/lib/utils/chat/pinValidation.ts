export const MIN_PIN_LENGTH = 4;

export function isValidPin(pin: string): boolean {
  return pin.trim().length >= MIN_PIN_LENGTH;
}
