
const { randomUUID, timingSafeEqual } = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const queueDir = "/home/f4cte/paperclip/packages/adapters/codex-local/server/test-assets/curl-shim-test";
const bridgeToken = "test-token-123";
const expectedBody = "{\"test\":\"stdin-data-123\"}";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resolveAtFile(value) {
  if (value.startsWith("@-")) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      process.stdin.on("error", reject);
    });
  }
  if (value.startsWith("@")) {
    const filePath = value.slice(1);
    return fs.readFile(filePath, "utf8").catch(() => {
      throw new Error("curl: couldn't open file \"" + filePath + "\"");
    });
  }
  return Promise.resolve(value);
}

async function main() {
  const argv = process.argv.slice(2);
  const resolvedBody = await resolveAtFile(argv[0]);
  if (argv[0] === "@-" && resolvedBody === expectedBody) {
    console.log("PASS: stdin-body @- resolved correctly");
  } else if (argv[0] === "@-") {
    console.error("STDIN MISMATCH: expected '" + expectedBody + "', got '" + resolvedBody + "'");
    process.exit(1);
  } else {
    console.error("Expected @- argument, got '" + argv[0] + "'");
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
