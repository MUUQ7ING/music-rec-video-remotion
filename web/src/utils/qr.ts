import qrcode from 'qrcode-generator';

export interface QrSvgData {
  viewBoxSize: number;
  pathD: string;
}

export function buildQrSvgData(text: string, margin = 1): QrSvgData {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const viewBoxSize = count + margin * 2;
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        parts.push(`M${col + margin},${row + margin}h1v1h-1z`);
      }
    }
  }
  return { viewBoxSize, pathD: parts.join('') };
}
