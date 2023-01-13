import dotenv from "dotenv";

import corsProxy from "./corsProxy";
import createRateLimitChecker from "./rateLimit";

dotenv.config();

const parseEnvList = (env: string | undefined) => {
  if (!env) {
    return [];
  }
  return env.split(",");
};

// Listen on a specific host via the HOST environment variable
const HOST = process.env.HOST || "0.0.0.0";
// Listen on a specific port via the PORT environment variable
const PORT = Number(process.env.PORT) || 8080;

// Grab the blacklist from the command-line so that we can update the blacklist without deploying
// again. CORS Proxify is open by design, and this blacklist is not used, except for countering
// immediate abuse (e.g. denial of service). If you want to block all origins except for some,
// use originWhitelist instead.
var originBlacklist = parseEnvList(process.env.CORSPROXIFY_BLACKLIST);
var originWhitelist = parseEnvList(process.env.CORSPROXIFY_WHITELIST);

// Set up rate-limiting to avoid abuse of the public CORS Proxify server.
const checkRateLimit = createRateLimitChecker(
  process.env.CORSPROXIFY_RATELIMIT
);

corsProxy
  .createServer({
    originBlacklist: originBlacklist,
    originWhitelist: originWhitelist,
    requireHeader: ["origin", "x-requested-with"],
    checkRateLimit: checkRateLimit,
    removeHeaders: [
      // Strip Heroku-specific headers
      "x-request-start",
      "x-request-id",
      "via",
      "connect-time",
      "total-route-time",
      // Other Heroku added debug headers
      // 'x-forwarded-for',
      // 'x-forwarded-proto',
      // 'x-forwarded-port',
    ],
    redirectSameOrigin: true,
    httpProxyOptions: {
      // Do not add X-Forwarded-For, etc. headers, because Heroku already adds it.
      xfwd: false,
    },
  })
  .listen(PORT, HOST, () => {
    console.log("Running CORS proxy on " + HOST + ":" + PORT);
  });
