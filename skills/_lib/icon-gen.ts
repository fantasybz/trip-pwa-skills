// icon-gen.ts — render the city-initial SVG to PNG app icons via resvg-js.
// Lighthouse PWA audit requires raster 192/512 icons + a maskable variant; SVG
// icons are not honored (lighthouse#4883), so the empty-state uses an inline SVG
// but the installed app needs these PNGs.
//
// Standard icon: terracotta rounded square + cream city initial, full-bleed.
// Maskable icon: full-bleed terracotta (no rounded corners) with the initial
// sized into the inner safe zone, so any mask shape still shows brand color.
//
// resvg-js is a bundle dependency (package.json). If it is not installed, throw
// a clear, actionable error — scaffold turns that into exit 1 + install hint.
//
// CJK NOTE: a CJK city-initial (京 / 香 / 首) needs a CJK-capable system font.
// macOS ships Hiragino/PingFang (loadSystemFonts finds it). On Linux CI without
// fonts-noto-cjk the glyph renders as tofu (no crash). Deferred hardening: ship a
// subset OFL CJK font and pass it via resvg `fontFiles` to make output
// deterministic across platforms. For v0.1 the dev platform (macOS) renders CJK
// correctly; a Latin initial or a user-supplied icon avoids the dependency.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BG = '#E76F51';     // terracotta
const FG = '#FFFCF7';     // cream

function escXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

// First grapheme — NFC-normalized, surrogate-pair / combining-mark safe (Codex
// P3). slice(0,1) is code-unit slicing and breaks emoji / combined CJK.
export function firstGrapheme(s: string): string {
  const norm = (s ?? '').normalize('NFC').trim();
  if (!norm) return '?';
  const Seg: any = (Intl as any).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: 'grapheme' });
    for (const { segment } of seg.segment(norm)) return segment;
  }
  return Array.from(norm)[0] ?? '?';
}

// size px; maskable=true → no corner radius + smaller glyph (safe zone).
function iconSvg(initial: string, size: number, maskable: boolean): string {
  const rx = maskable ? 0 : Math.round(size * 0.22);
  const fontSize = Math.round(size * (maskable ? 0.42 : 0.52));
  // baseline ≈ vertical center + ~0.35*fontSize for visual centering
  const y = Math.round(size / 2 + fontSize * 0.35);
  const ch = escXml(firstGrapheme(initial));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${BG}"/>
  <text x="${size / 2}" y="${y}" font-size="${fontSize}" font-weight="700" text-anchor="middle"
    fill="${FG}" font-family="Hiragino Sans, Noto Sans TC, PingFang TC, sans-serif">${ch}</text>
</svg>`;
}

// Known system CJK font paths. resvg loads .ttc collections fine. Passing the
// font explicitly via fontFiles makes CJK rendering deterministic instead of
// relying on resvg's system-font discovery (B2 preflight).
const CJK_FONT_PATHS = [
  // macOS
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  // Linux (fonts-noto-cjk and friends)
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf',
];

function findCjkFont(): string | null {
  for (const p of CJK_FONT_PATHS) if (existsSync(p)) return p;
  return null;
}

// True only for actual CJK scripts (Han / Kana / Hangul). Accented Latin (É, Ü,
// Đ), Thai, etc. are NOT CJK and are left to system-font fallback (Codex B2).
function isCjk(s: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
}

export interface IconResult { path: string; bytes: number; }

export async function generateIcons(outDir: string, cityInitial: string): Promise<IconResult[]> {
  let Resvg: any;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    throw new Error('@resvg/resvg-js is not installed — run `bun add @resvg/resvg-js` in the bundle root.');
  }

  // Preflight: a CJK initial needs a CJK font. Find one explicitly; if the
  // initial is non-ASCII and none is installed, FAIL before writing any output
  // (scaffold's atomic staging then leaves no partial PWA) — better than
  // silently rendering tofu (Codex B2).
  const initial = firstGrapheme(cityInitial);
  const needsCjk = isCjk(initial);
  const cjkFont = needsCjk ? findCjkFont() : null;
  if (needsCjk && !cjkFont) {
    throw new Error(
      `no CJK font found to render the "${initial}" app icon. ` +
      `Install one (Linux: apt-get install fonts-noto-cjk; macOS ships Hiragino), ` +
      `use a Latin city initial, or supply your own assets/icons/*.png.`
    );
  }
  // For a CJK initial, load ONLY the explicit font (loadSystemFonts:false) so
  // resvg deterministically uses it instead of its own system-font resolution
  // (Codex B2: fontFiles + loadSystemFonts:true rendered identically to
  // system-only, i.e. the explicit file was not guaranteed). Non-CJK initials
  // use system fonts (Latin/Thai/etc. fallback).
  const fontOpt = cjkFont
    ? { fontFiles: [cjkFont], loadSystemFonts: false }
    : { loadSystemFonts: true, defaultFontFamily: 'sans-serif' };

  const iconsDir = join(outDir, 'assets', 'icons');
  await mkdir(iconsDir, { recursive: true });

  const targets = [
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-512.png', size: 512, maskable: false },
    { name: 'icon-512-maskable.png', size: 512, maskable: true },
  ];

  const out: IconResult[] = [];
  for (const t of targets) {
    const svg = iconSvg(cityInitial, t.size, t.maskable);
    const r = new Resvg(svg, {
      font: fontOpt,
      fitTo: { mode: 'width', value: t.size },
    });
    const png = r.render().asPng();
    const path = join(iconsDir, t.name);
    await writeFile(path, png);
    out.push({ path, bytes: png.length });
  }
  return out;
}
