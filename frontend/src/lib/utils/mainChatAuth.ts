export async function computePinVerifier(uid: string, userPin: string): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(userPin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode('canari:' + uid),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateDevToken(
  uid: string,
  jwtSecret: string | undefined,
  isDev: boolean
): Promise<string> {
  const secret = jwtSecret;
  if (!secret) {
    throw new Error(
      isDev
        ? 'VITE_JWT_SECRET non configuré dans frontend/.env (développement)'
        : 'VITE_JWT_SECRET absent du bundle — vérifier le GitHub Secret JWT_SECRET dans Settings → Secrets → Actions'
    );
  }
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Erreur de sécurité : crypto.subtle indisponible.\n\n' +
        "Cause probable : l'application n'est pas accédée via HTTPS.\n" +
        'Vérifiez que Cloudflare Tunnel est actif et que vous accédez via https://canari-emse.fr'
    );
  }
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const payload = JSON.stringify({
    sub: uid,
    exp: Math.floor(Date.now() / 1000) + 3600 * 24,
  });
  const b64url = (str: string) =>
    btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(unsignedToken));
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(signature)));
  return `${unsignedToken}.${sigB64}`;
}
