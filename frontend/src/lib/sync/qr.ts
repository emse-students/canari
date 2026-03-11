import QRCode from 'qrcode';

export async function createSyncQrDataUrl(payload: string): Promise<string> {
  const value = payload.trim();
  if (!value) return '';

  return QRCode.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}
