const fs = require('fs');
const HF_API = 'https://fnf.higgsfield.ai';
const apiKey = 'hf_Mpyg512GLUY_R0LGddppb9XixT80ufdPTx9IPkZos6sEv91YmHnosp4EyZ2O5Xn1';

async function upload(buffer, mimeType) {
  const boundary = '----HFBoundary' + Date.now().toString(16);
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body   = Buffer.concat([header, buffer, footer]);

  const initRes = await fetch(`${HF_API}/agents/uploads?type=image`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const txt = await initRes.text();
  console.log('Status:', initRes.status, txt.slice(0, 300));
  if (!initRes.ok) return;
  const { id, url, upload_url } = JSON.parse(txt);

  // Step 2: PUT to S3
  const s3Res = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: buffer,
  });
  console.log('S3 status:', s3Res.status, '| UUID:', id);
}

upload(fs.readFileSync('images/stencil-before.png'), 'image/png').catch(console.error);
