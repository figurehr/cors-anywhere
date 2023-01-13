import http from "node:http";
import https from "node:https";
import { REDIRECT_STATUSES } from "./constants";
import httpProxy from "http-proxy";

import { parseURL, isValidHostName, getProxyForUrl } from "./utils";
import { RateLimitChecker } from "./rateLimit";

type Headers = http.IncomingHttpHeaders | http.OutgoingHttpHeaders;
type CorsState = {
  location: URL;
  getProxyForUrl: typeof getProxyForUrl;
  proxyBaseUrl: string;
  maxRedirects: number;
  redirectCount_?: number;
  corsMaxAge: number;
};

type CorsProxyOptions = {
  // Function that may handle the request instead, by returning a truthy value.
  handleInitialRequest:
    | ((
        req: http.IncomingMessage,
        res: http.ServerResponse,
        locaton: URL | null
      ) => boolean)
    | null;
  // Function that specifies the proxy to use
  getProxyForUrl: typeof getProxyForUrl;
  // Maximum number of redirects to be followed.
  maxRedirects: number;
  // Requests from these origins will be blocked.
  originBlacklist: string[];
  // If non-empty, requests not from an origin in this list will be blocked.
  originWhitelist: string[];
  // Function that may enforce a rate-limit by returning a non-empty string.
  checkRateLimit: RateLimitChecker;
  // Redirect the client to the requested URL for same-origin requests.
  redirectSameOrigin: boolean;
  // Require a header to be set?
  requireHeader: string | string[] | null;
  // Strip these request headers.
  removeHeaders: string[];
  // Set these request headers.
  setHeaders: Headers;
  // If set, an Access-Control-Max-Age header with this value (in seconds) will be added.
  corsMaxAge: number;
};

type CreateServerOptions = Partial<CorsProxyOptions> & {
  httpProxyOptions?: httpProxy.ServerOptions;
  httpsOptions?: https.ServerOptions;
};

const withCORS = (
  headers: Headers,
  request: http.IncomingMessage,
  corsMaxAge: number
) => {
  headers["access-control-allow-origin"] = "*";
  if (request.method === "OPTIONS" && corsMaxAge) {
    headers["access-control-max-age"] = corsMaxAge.toString();
  }
  if (request.headers["access-control-request-method"]) {
    headers["access-control-allow-methods"] =
      request.headers["access-control-request-method"];
    delete request.headers["access-control-request-method"];
  }
  if (request.headers["access-control-request-headers"]) {
    headers["access-control-allow-headers"] =
      request.headers["access-control-request-headers"];
    delete request.headers["access-control-request-headers"];
  }

  headers["access-control-expose-headers"] = Object.keys(headers).join(",");

  return headers;
};

const defaultHandlerOptions = {
  handleInitialRequest: null, // Function that may handle the request instead, by returning a truthy value.
  getProxyForUrl: getProxyForUrl, // Function that specifies the proxy to use
  maxRedirects: 5, // Maximum number of redirects to be followed.
  originBlacklist: [], // Requests from these origins will be blocked.
  originWhitelist: [], // If non-empty, requests not from an origin in this list will be blocked.
  checkRateLimit: null, // Function that may enforce a rate-limit by returning a non-empty string.
  redirectSameOrigin: false, // Redirect the client to the requested URL for same-origin requests.
  requireHeader: null, // Require a header to be set?
  removeHeaders: [], // Strip these request headers.
  setHeaders: {}, // Set these request headers.
  corsMaxAge: 0, // If set, an Access-Control-Max-Age header with this value (in seconds) will be added.
};

const handleRedirectStatus = (
  proxy: httpProxy,
  proxyRes: http.IncomingMessage,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsState: CorsState
): boolean => {
  const statusCode = proxyRes.statusCode;
  let locationHeader = proxyRes.headers["location"];
  let parsedLocation;
  if (locationHeader) {
    locationHeader = new URL(
      locationHeader,
      corsState.location.href
    ).toString();
    parsedLocation = parseURL(locationHeader);
  }
  if (parsedLocation) {
    if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
      // Exclude 307 & 308, because they are rare, and require preserving the method + request body
      corsState.redirectCount_ = (corsState.redirectCount_ ?? 0) + 1;
      if (corsState.redirectCount_ <= corsState.maxRedirects) {
        // Handle redirects within the server, because some clients (e.g. Android Stock Browser)
        // cancel redirects.
        // Set header for debugging purposes. Do not try to parse it!
        res.setHeader(
          "X-CORS-Redirect-" + corsState.redirectCount_,
          statusCode + " " + locationHeader
        );

        req.method = "GET";
        req.headers["content-length"] = "0";
        delete req.headers["content-type"];
        corsState.location = parsedLocation;

        // Remove all listeners (=reset events to initial state)
        req.removeAllListeners();

        // Initiate a new proxy request.
        proxyRequest(req, res, proxy, corsState);
        return false;
      }
    }
    proxyRes.headers["location"] =
      corsState.proxyBaseUrl + "/" + locationHeader;
  }
  return false;
};

const onProxyResponse = (
  proxy: httpProxy,
  proxyRes: http.IncomingMessage,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsState: CorsState
): boolean => {
  const statusCode = proxyRes.statusCode;

  if (!corsState.redirectCount_) {
    res.setHeader("x-request-url", corsState.location.href);
  }

  if (statusCode && REDIRECT_STATUSES.includes(statusCode)) {
    return handleRedirectStatus(proxy, proxyRes, req, res, corsState);
  }

  // Strip cookies
  /* delete proxyRes.headers["set-cookie"]; */
  /* delete proxyRes.headers["set-cookie2"]; */

  proxyRes.headers["x-final-url"] = corsState.location.href;
  withCORS(proxyRes.headers, req, corsState.corsMaxAge);
  return true;
};

const proxyRequest = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  proxy: httpProxy,
  corsState: CorsState
) => {
  const { location } = corsState;
  request.url = location?.pathname ?? undefined;

  const proxyOptions: httpProxy.ServerOptions = {
    changeOrigin: false,
    prependPath: false,
    target: location?.toString(),
    selfHandleResponse: true,
    headers: {
      host: location?.host ?? "",
    },
  };

  if (corsState.getProxyForUrl) {
    const proxyUrl = corsState.getProxyForUrl(location.href);
    if (proxyUrl) {
      const proxyThroughUrl = new URL(proxyUrl);

      proxyOptions.target = proxyThroughUrl;
      proxyOptions.auth = `${proxyThroughUrl.username}:${proxyThroughUrl.password}`;
      proxyOptions.headers = {
        "Proxy-Authorization": `Basic ${Buffer.from(proxyOptions.auth).toString(
          "base64"
        )}`,
      };
      proxyOptions.toProxy = true;
      // If a proxy URL was set, req.url must be an absolute URL. Then the request will not be sent
      // directly to the proxied URL, but through another proxy.
      request.url = location.href;
    }
  }

  proxy.on("proxyRes", (proxyRes, req, res) => {
    onProxyResponse(proxy, proxyRes, req, res, corsState);
  });

  try {
    proxy.web(request, response, proxyOptions);
  } catch (err) {
    proxy.emit("error", err, request, response);
  }
};

const getHandler = (options: Partial<CorsProxyOptions>, proxy: httpProxy) => {
  const corsOptions: CorsProxyOptions = {
    ...defaultHandlerOptions,
    ...options,
  };

  const { requireHeader } = corsOptions;

  let requiredHeaderArray = requireHeader ?? [];

  if (typeof requiredHeaderArray === "string") {
    requiredHeaderArray = [requiredHeaderArray.toLowerCase()];
  }

  requiredHeaderArray = requiredHeaderArray.map((header) =>
    header.toLowerCase()
  );

  const hasRequiredHeaders = (headers: Headers) =>
    !requiredHeaderArray ||
    (requiredHeaderArray as string[]).some((headerName) => headers[headerName]);

  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    const corsHeaders = withCORS({}, request, corsOptions.corsMaxAge);
    const location = parseURL(request.url?.slice(1));

    if (corsOptions.handleInitialRequest?.(request, response, location)) {
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(200, corsHeaders);
      response.end();
      return;
    }

    if (!location) {
      // Special case http:/notenoughslashes, because new users of the library frequently make the
      // mistake of putting this application behind a server/router that normalizes the URL.
      // See https://github.com/Rob--W/cors-anywhere/issues/238#issuecomment-629638853
      if (/^\/https?:\/[^/]/i.test(request.url ?? "")) {
        response.writeHead(400, "Missing slash", corsHeaders);
        response.end(
          "The URL is invalid: two slashes are needed after the http(s):."
        );
        return;
      }
      // Invalid API call
      return;
    }

    if (Number(location.port) > 65535) {
      // Port is higher than 65535
      response.writeHead(400, "Invalid port", corsHeaders);
      response.end("Port number too large: " + location.port);
      return;
    }

    if (
      !/^\/https?:/.test(request.url ?? "") &&
      !isValidHostName(location.hostname)
    ) {
      // Don't even try to proxy invalid hosts (such as /favicon.ico, /robots.txt)
      response.writeHead(404, "Invalid host", corsHeaders);
      response.end("Invalid host: " + location.hostname);
      return;
    }

    if (!hasRequiredHeaders(request.headers)) {
      response.writeHead(400, "Header required", corsHeaders);
      response.end(
        "Missing required request header. Must specify one of: " +
          corsOptions.requireHeader
      );
      return;
    }

    const origin = request.headers.origin || "";
    if (corsOptions.originBlacklist.includes(origin)) {
      response.writeHead(403, "Forbidden", corsHeaders);
      response.end(
        'The origin "' +
          origin +
          '" was blacklisted by the operator of this proxy.'
      );
      return;
    }

    if (
      corsOptions.originWhitelist.length > 0 &&
      !corsOptions.originWhitelist.includes(origin)
    ) {
      response.writeHead(403, "Forbidden", corsHeaders);
      response.end(
        'The origin "' +
          origin +
          '" was not whitelisted by the operator of this proxy.'
      );
      return;
    }

    const rateLimitMessage =
      corsOptions.checkRateLimit && corsOptions.checkRateLimit(origin);
    if (rateLimitMessage) {
      response.writeHead(429, "Too Many Requests", corsHeaders);
      response.end(
        'The origin "' +
          origin +
          '" has sent too many requests.\n' +
          rateLimitMessage
      );
      return;
    }

    if (
      corsOptions.redirectSameOrigin &&
      origin &&
      location.href[origin.length] === "/" &&
      location.href.lastIndexOf(origin, 0) === 0
    ) {
      // Send a permanent redirect to offload the server. Badly coded clients should not waste our resources.
      corsHeaders.vary = "origin";
      corsHeaders["cache-control"] = "private";
      corsHeaders.location = location.href;
      response.writeHead(301, "Please use a direct request", corsHeaders);
      response.end();
      return;
    }

    const isRequestedOverHttps = /^\s*https/.test(
      request.headers["x-forwarded-proto"] as string
    );
    const proxyBaseUrl =
      (isRequestedOverHttps ? "https://" : "http://") + request.headers.host;

    corsOptions.removeHeaders.forEach((header) => {
      delete request.headers[header];
    });

    Object.keys(corsOptions.setHeaders).forEach((header) => {
      request.headers[header] = corsOptions.setHeaders[header]?.toString();
    });

    const corsState: CorsState = {
      getProxyForUrl: corsOptions.getProxyForUrl,
      maxRedirects: corsOptions.maxRedirects,
      corsMaxAge: corsOptions.corsMaxAge,
      location,
      proxyBaseUrl,
    };

    proxyRequest(request, response, proxy, corsState);
  };
};

const createServer = (options: CreateServerOptions) => {
  const httpProxyOptions = {
    xfwd: true, // Append X-Forwarded-* headers
    ws: false,
    secure: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    // Allow user to override defaults and add own options
    ...(options.httpProxyOptions ?? {}),
  };

  const proxy = httpProxy.createProxyServer(httpProxyOptions);
  const requestHandler = getHandler(options, proxy);
  const server = options.httpsOptions
    ? https.createServer(requestHandler)
    : http.createServer(requestHandler);

  return server;
};

export default {
  createServer,
};
