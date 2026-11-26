import { preview } from 'vite';
import { resolveAllowedHosts } from '../build/allowedHosts.js';

if (process.env.VERCEL_ENV !== 'preview') {
  throw new Error(
    'This container only starts in the Vercel Preview environment.',
  );
}

const deploymentHosts = [
  process.env.VERCEL_URL,
  process.env.VERCEL_BRANCH_URL,
].filter(Boolean);
if (
  !deploymentHosts.length ||
  deploymentHosts.some(
    (hostname) =>
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/i.test(hostname),
  )
) {
  throw new Error('Expected a Vercel Preview deployment or branch hostname.');
}

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

// Provider Settings and LAN receivers belong to the operator's workstation.
process.env.GEV_KEY_SETUP_TRUSTED_PEERS = 'none';
process.env.LOCAL_RECEIVER_FEEDS = '';

const server = await preview({
  preview: {
    host,
    port,
    strictPort: true,
    allowedHosts: resolveAllowedHosts(deploymentHosts.join(',').toLowerCase()),
  },
});
console.log(`[Vercel Preview] Listening on ${host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
  });
}
