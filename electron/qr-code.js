'use strict';

const QRCode = require('./vendor/QRCode');
const ErrorCorrectLevel = require('./vendor/QRCode/QRErrorCorrectLevel');

function matrixFor(text) {
  const value = String(text || '');
  if (!value || value.length > 220) throw new TypeError('QR content is empty or too long.');
  const qr = new QRCode(0, ErrorCorrectLevel.M);
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  const matrix = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) line.push(qr.isDark(row, col));
    matrix.push(line);
  }
  return matrix;
}

function toSvgDataUrl(text) {
  const matrix = matrixFor(text);
  const margin = 4;
  const size = matrix.length + margin * 2;
  const paths = [];
  matrix.forEach((line, row) => {
    line.forEach((dark, col) => {
      if (dark) paths.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join('')}" fill="#111827"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

module.exports = { matrixFor, toSvgDataUrl };
