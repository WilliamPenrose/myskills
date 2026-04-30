const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const detected = PROXY_KEYS.find((k) => process.env[k]);

if (detected) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 24) {
    console.error(
      `app-reviews: proxy env detected (${detected}) but Node 24+ is required to honor it. ` +
        `Got ${process.version}. Either upgrade Node, or unset the proxy variable if you don't need it.`,
    );
    process.exit(1);
  }
  if (process.env.NODE_USE_ENV_PROXY !== '1') {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    process.exit(res.status ?? 1);
  }
}
