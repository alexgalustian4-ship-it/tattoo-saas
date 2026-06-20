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

  // Step 1: Gaussian blur to reduce noise
  const blurred = gaussianBlur(gray, w, h, 2);

  // Step 2: Sobel — gradient magnitude + direction
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) {
    const p = (dy, dx) => blurred[(y+dy)*w+(x+dx)];
    const gx = -p(-1,-1) + p(-1,1) - 2*p(0,-1) + 2*p(0,1) - p(1,-1) + p(1,1);
    const gy = -p(-1,-1) - 2*p(-1,0) - p(-1,1) + p(1,-1) + 2*p(1,0) + p(1,1);
    const m = Math.sqrt(gx*gx + gy*gy);
    mag[y*w+x] = m;
    dir[y*w+x] = Math.atan2(gy, gx);
    if (m > maxMag) maxMag = m;
  }

  // Step 3: Non-maximum suppression — thin lines to 1px
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) {
    const m = mag[y*w+x];
    if (m === 0) continue;
    const a = ((dir[y*w+x] * 180 / Math.PI) + 180) % 180;
    let n1, n2;
    if      (a < 22.5 || a >= 157.5) { n1 = mag[y*w+x-1];     n2 = mag[y*w+x+1]; }
    else if (a < 67.5)               { n1 = mag[(y+1)*w+x-1]; n2 = mag[(y-1)*w+x+1]; }
    else if (a < 112.5)              { n1 = mag[(y-1)*w+x];   n2 = mag[(y+1)*w+x]; }
    else                             { n1 = mag[(y-1)*w+x-1]; n2 = mag[(y+1)*w+x+1]; }
    if (m >= n1 && m >= n2) nms[y*w+x] = m;
  }

  // Step 4: Hysteresis thresholding
  const hi = maxMag * 0.45;
  const lo = hi * 0.40;
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < w*h; i++) if (nms[i] >= hi) edge[i] = 2;
  const stack = [];
  for (let i = 0; i < w*h; i++) if (edge[i] === 2) stack.push(i);
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x+dx, ny = y+dy;
      if (nx<0||ny<0||nx>=w||ny>=h) continue;
      const ni = ny*w+nx;
      if (edge[ni] === 0 && nms[ni] >= lo) { edge[ni] = 2; stack.push(ni); }
    }
  }

  // Output: violet (75, 0, 130) on white — strict binary, no grey
  const out = createCanvas(w, h);
  const oCtx = out.getContext('2d');
  const outData = oCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const isLine = edge[i] === 2;
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
