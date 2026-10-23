import https from 'node:https';

/** Read-only, loopback-only requests. Credentials never leave this process. */
export function requestLocalJson(url, {ca, authorization, timeout = 1600, insecureLcu = false} = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== '127.0.0.1') {
    return Promise.reject(new Error('Only the local Riot HTTPS API is permitted.'));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(target, {
      ca,
      // LCU ships a self-signed certificate. This exception is confined to its
      // authenticated 127.0.0.1 socket, never the web or Live Client API.
      rejectUnauthorized: !insecureLcu,
      headers: {Accept: 'application/json', ...(authorization ? {Authorization: authorization} : {})},
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Local API returned ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error('Local API response exceeded the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Local API returned invalid JSON.')); }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Local API timed out.')));
    request.on('error', reject);
  });
}
