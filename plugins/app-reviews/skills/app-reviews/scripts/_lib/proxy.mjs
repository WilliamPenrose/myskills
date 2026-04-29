import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const hasProxyEnv =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
  process.env.https_proxy || process.env.http_proxy ||
  process.env.NO_PROXY || process.env.no_proxy;

if (hasProxyEnv) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
