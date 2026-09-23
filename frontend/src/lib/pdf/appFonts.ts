/**
 * The app's real fonts (Fredoka + Nunito) plus the calendar sheet's two display faces (Leckerli One
 * + Chewy), embedded into jsPDF so vector text in the PDF exports matches the on-screen typography
 * exactly - not jsPDF's built-in Helvetica.
 *
 * jsPDF can only embed static TrueType fonts (not the woff2 *variable* families the web page uses),
 * so the static per-weight `.ttf` files ship via `@expo-google-fonts/*`. Vite resolves each import to
 * a served asset URL; the bytes are fetched + base64-embedded only when a PDF is actually exported,
 * so nothing here weighs on the main bundle.
 */
import type { jsPDF } from 'jspdf';
// Static TrueType weights (Vite turns each into an asset URL string).
import FredokaRegular from '@expo-google-fonts/fredoka/400Regular/Fredoka_400Regular.ttf';
import FredokaBold from '@expo-google-fonts/fredoka/700Bold/Fredoka_700Bold.ttf';
import NunitoRegular from '@expo-google-fonts/nunito/400Regular/Nunito_400Regular.ttf';
import NunitoBold from '@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf';
import NunitoExtra from '@expo-google-fonts/nunito/800ExtraBold/Nunito_800ExtraBold.ttf';
// The calendar sheet's two display faces. They exist in ONE weight, which the sheet has to respect -
// see {@link pickAppFont}.
import LeckerliOne from '@expo-google-fonts/leckerli-one/400Regular/LeckerliOne_400Regular.ttf';
import Chewy from '@expo-google-fonts/chewy/400Regular/Chewy_400Regular.ttf';

/** One embeddable weight: its asset URL plus the jsPDF (VFS file, font name, style) it registers as. */
interface AppFont {
  url: string;
  vfs: string;
  name: string;
  style: 'normal' | 'bold';
}

/** Every weight embedded for the exports (Nunito 400/700/800 + Fredoka 400/700 + the two displays). */
const APP_FONTS: AppFont[] = [
  { url: NunitoRegular, vfs: 'Nunito-Regular.ttf', name: 'Nunito', style: 'normal' },
  { url: NunitoBold, vfs: 'Nunito-Bold.ttf', name: 'Nunito', style: 'bold' },
  // jsPDF has only 4 styles per font name, so extra-bold lives under its own name.
  { url: NunitoExtra, vfs: 'Nunito-Extra.ttf', name: 'NunitoExtra', style: 'normal' },
  { url: FredokaRegular, vfs: 'Fredoka-Regular.ttf', name: 'Fredoka', style: 'normal' },
  { url: FredokaBold, vfs: 'Fredoka-Bold.ttf', name: 'Fredoka', style: 'bold' },
  { url: LeckerliOne, vfs: 'LeckerliOne-Regular.ttf', name: 'LeckerliOne', style: 'normal' },
  { url: Chewy, vfs: 'Chewy-Regular.ttf', name: 'Chewy', style: 'normal' },
];

/** Fetches a font asset and base64-encodes it for jsPDF's virtual file system. */
async function fetchFontBase64(url: string): Promise<string> {
  const buffer = await (await fetch(url)).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked to stay under the argument-count limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Fetches + registers every app font into a jsPDF document (call once, before drawing text). */
export async function registerAppFonts(pdf: jsPDF): Promise<void> {
  await Promise.all(
    APP_FONTS.map(async (f) => {
      pdf.addFileToVFS(f.vfs, await fetchFontBase64(f.url));
      pdf.addFont(f.vfs, f.name, f.style);
    })
  );
}

/**
 * Maps a computed `font-family` stack + numeric weight to the embedded jsPDF (name, style) that best
 * matches the on-screen font, or null when the family is none of the embedded ones (caller falls
 * back to Helvetica). Fredoka tops out at 700; Nunito uses its own extra-bold name at >=800.
 *
 * LECKERLI ONE AND CHEWY SHIP ONE WEIGHT AND IGNORE `weight` ON PURPOSE. A page that asks them for
 * 700 gets the browser's SYNTHETIC bold in the raster, while this layer draws the only outline that
 * exists - so the vector text lands thinner than the picture underneath it, which is the one defect
 * a searchable raster cannot hide. The calendar sheet therefore sets 400 on both faces.
 */
export function pickAppFont(
  fontFamily: string,
  weight: number
): { name: string; style: 'normal' | 'bold' } | null {
  const fam = fontFamily.toLowerCase();
  if (fam.includes('fredoka')) {
    return { name: 'Fredoka', style: weight >= 600 ? 'bold' : 'normal' };
  }
  if (fam.includes('leckerli')) return { name: 'LeckerliOne', style: 'normal' };
  if (fam.includes('chewy')) return { name: 'Chewy', style: 'normal' };
  if (fam.includes('nunito')) {
    if (weight >= 800) return { name: 'NunitoExtra', style: 'normal' };
    return { name: 'Nunito', style: weight >= 600 ? 'bold' : 'normal' };
  }
  return null;
}
