/**
 * Render a WhatsApp QR payload to SVG.
 *
 * `qrcode-terminal` (already a dependency, used for the terminal QR) ships an
 * unmodified copy of Kazuhiko Arase's QR encoder in its vendor folder. We reuse
 * that encoder directly and draw SVG instead of ANSI blocks — so the browser
 * gets a crisp, scalable QR with ZERO extra dependencies and no CDN, which
 * matters because this page is often opened on a LAN with no internet.
 */
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

/** Modules of white space around the code. The spec asks for 4; phones read 2 fine. */
const QUIET_ZONE = 2;

/**
 * Build an SVG string for `payload`.
 *
 * The dark modules are emitted as ONE `<path>` rather than thousands of
 * `<rect>` elements, with horizontal runs merged — a WhatsApp QR is ~2,500
 * modules, and this keeps the document small and the render instant.
 */
export function qrToSvg(payload: string, opts: { size?: number; dark?: string; light?: string } = {}): string {
  const size = opts.size ?? 512;
  const dark = opts.dark ?? '#04140d';
  const light = opts.light ?? '#ffffff';

  // typeNumber -1 = pick the smallest QR version the data fits into.
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const total = count + QUIET_ZONE * 2;

  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      let run = 1;
      while (col + run < count && qr.isDark(row, col + run)) run++;
      path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="WhatsApp linking QR code">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
