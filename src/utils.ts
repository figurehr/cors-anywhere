import { TOP_LEVEL_DOMAIN_REGEX } from "./constants";
import net from "node:net";
import dotenv from "dotenv";

dotenv.config();

const NO_PROXY = process.env.NO_PROXY;
const HTTP_PROXY = process.env.HTTP_PROXY;
const HTTPS_PROXY = process.env.HTTPS_PROXY;
const ALL_PROXY = process.env.ALL_PROXY;

export const parseURL = (reqUrl: string | undefined): URL | null => {
  if (!reqUrl) return null;
  let testUrl = reqUrl;
  const match = testUrl.match(
    /^(?:(https?:)?\/\/)?(([^\/?]+?)(?::(\d{0,5})(?=[\/?]|$))?)([\/?][\S\s]*|$)/i
  );
  if (!match) {
    return null;
  }
  if (!match[1]) {
    if (/^https?:/i.test(testUrl)) {
      // The pattern at top could mistakenly parse "http:///" as host="http:" and path=///.
      return null;
    }
    // Scheme is omitted.
    if (testUrl.lastIndexOf("//", 0) === -1) {
      // "//" is omitted.
      testUrl = "//" + testUrl;
    }
    testUrl = (match[4] === "443" ? "https:" : "http:") + testUrl;
  }
  const parsed = new URL(testUrl);
  if (!parsed.hostname) {
    // "http://:1/" and "http:/notenoughslashes" could end up here.
    return null;
  }
  return parsed;
};

export const isValidHostName = (hostname: string | null): boolean => {
  if (!hostname) return false;
  return !!(
    TOP_LEVEL_DOMAIN_REGEX.test(hostname) ||
    net.isIPv4(hostname) ||
    net.isIPv6(hostname)
  );
};

const shouldProxyUrl = (url: URL | string) => {
  if (!NO_PROXY) {
    return true;
  }

  if (NO_PROXY === "*") {
    return false;
  }

  const noProxyDomains = NO_PROXY.split(",");

  const proxiedUrl = new URL(url);

  return noProxyDomains.every((domain) => {
    if (!domain) return true;
    const domainUrl = new URL(domain);
    if (domainUrl.port && domainUrl.port !== proxiedUrl.port) {
      return true;
    }
    return domainUrl.hostname === proxiedUrl.hostname;
  });
};

export const getProxyForUrl = (url: URL | string): string | null => {
  const { hostname, protocol } = new URL(url);
  if (
    typeof hostname !== "string" ||
    !hostname ||
    typeof protocol !== "string"
  ) {
    return null; // Don't proxy URLs without a valid scheme or host.
  }

  if (shouldProxyUrl(url)) {
    return null;
  }

  const parsedProtocol = protocol.split(":", 1)[0];

  let proxy = null;
  if (parsedProtocol === "http") {
    proxy = HTTP_PROXY;
  }

  if (parsedProtocol === "https") {
    proxy = HTTPS_PROXY;
  }

  if (ALL_PROXY) proxy = ALL_PROXY;

  if (proxy && proxy.indexOf("://") === -1) {
    // Missing scheme in proxy, default to the requested URL's scheme.
    proxy = protocol + "://" + proxy;
  }

  return proxy ?? null;
};
