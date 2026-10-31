// Vercel serverless proxy: forwards /api/... requests to the backend set in BACKEND_URL.
// It also tells the backend the REAL visitor IP, proven with PROXY_SHARED_SECRET, so login
// limits count each visitor separately instead of counting everyone as one.
module.exports = async function handler(req, res) {
  const backend = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (!backend) {
    res.status(500).json({ error: 'BACKEND_URL is not configured on Vercel.' });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'x-forwarded-host', 'x-vercel-id',
         'x-vercel-forwarded-for', 'x-vercel-deployment-url',
         // never accept these from the visitor: only this proxy may set them
         'x-mtech-client-ip', 'x-mtech-proxy-secret'].includes(k)) continue;
    headers[k] = value;
  }

  // Vercel sets x-forwarded-for / x-real-ip to the visitor's public IP (visitors cannot fake it).
  const secret = String(process.env.PROXY_SHARED_SECRET || '');
  const visitorIp = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim();
  if (secret.length >= 24 && visitorIp) {
    headers['x-mtech-client-ip'] = visitorIp;
    headers['x-mtech-proxy-secret'] = secret;
  }

  try {
    const upstream = await fetch(backend + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) || body.length === 0 ? undefined : body,
      redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) return;
      res.setHeader(key, value);
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: 'Backend is unreachable. Check BACKEND_URL and that the Render service is running.' });
  }
};
