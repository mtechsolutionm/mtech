// Vercel serverless proxy: forwards /api/... requests to the backend set in BACKEND_URL.
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
         'x-vercel-forwarded-for', 'x-vercel-deployment-url'].includes(k)) continue;
    headers[k] = value;
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
