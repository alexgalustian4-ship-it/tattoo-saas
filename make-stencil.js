const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');

function gaussianBlur(gray, w, h, radius) {
  const sigma = radius / 2, kSize = radius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let kSum = 0;
  for (let i = 0; i < kSize; i++) { const x = i - radius; kernel[i] = Math.exp(-(x*x)/(2*sigma*sigma)); kSum += kernel[i]; }
  for (let i = 0; i < kSize; i++) kernel[i] /= kSum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = 0; k < kSize; k++) { const xi = Math.max(0, Math.min(w-1, x+k-radius)); s += gray[y*w+xi] * kernel[k]; } tmp[y*w+x] = s;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = 0; k < kSize; k++) { const yi = Math.max(0, Math.min(h-1, y+k-radius)); s += tmp[yi*w+x] * kernel[k]; } out[y*w+x] = s;
  }
  return out;
}

async function makeStencil(inputPath, outputPath) {
  const img = await loadImage(inputPath);
  const w = img.width, h = img.height;
  const src = createCanvas(w, h);
  src.getContext('2d').drawImage(img, 0, 0);
  const srcData = src.getContext('2d').getImageData(0, 0, w, h).data;

  // Grayscale
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    gray[i] = 0.299*srcData[i*4] + 0.587*srcData[i*4+1] + 0.114*srcData[i*4+2];

  // Difference of Gaussians (DoG) — gives thin clean edges
  const blur1 = gaussianBlur(gray, w, h, 1);  // fine detail
  const blur2 = gaussianBlur(gray, w, h, 6);  // coarse

  // DoG = difference = edges only
  const dog = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    dog[i] = blur1[i] - blur2[i];

  // Threshold: only keep strong edges (negative = dark edge)
  const out = createCanvas(w, h);
  const oCtx = out.getContext('2d');
  const outData = oCtx.createImageData(w, h);

  for (let i = 0; i < w * h; i++) {
    // Negative DoG = dark lines on bright background
    const isLine = dog[i] < -8;
    outData.data[i*4]   = isLine ? 75  : 255;
    outData.data[i*4+1] = isLine ? 0   : 255;
    outData.data[i*4+2] = isLine ? 130 : 255;
    outData.data[i*4+3] = 255;
  }

  oCtx.putImageData(outData, 0, 0);
  fs.writeFileSync(outputPath, out.toBuffer('image/png'));
  console.log('Stencil saved to', outputPath);
}

makeStencil('images/stencil-before.png', 'images/stencil-after.png').catch(console.error);
