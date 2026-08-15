/**
 * Type declarations for the QR encoder vendored inside `qrcode-terminal`.
 * It's plain CommonJS with no types of its own; these are the only two members
 * we use (see web/qr-svg.ts).
 */
declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  export default QRCode;
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const levels: { L: number; M: number; Q: number; H: number };
  export default levels;
}
