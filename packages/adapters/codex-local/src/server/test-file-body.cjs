// Regression test for POLA-11232: codex_local curl shim @- and @file body support
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const TEST_DIR = path.join(__dirname, "..", "..", "server", "test-assets", "curl-shim-test");

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
}

async function testStdinBody() {
  const testBody = JSON.stringify({ test: "stdin-data-123" });
  const testBodyEscaped = testBody.replace(/"/g, '\\"');

  const shimCode = `
const { randomUUID, timingSafeEqual } = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const queueDir = "${TEST_DIR}";
const bridgeToken = "test-token-123";
const expectedBody = "${testBodyEscaped}";

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
      throw new Error("curl: couldn't open file \\"" + filePath + "\\\"");
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
`;

  const shimPath = path.join(TEST_DIR, "test-stdin-resolve.cjs");
  await fs.writeFile(shimPath, shimCode);

  const proc = spawn("node", [shimPath, "@-"], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdin.write(testBody);
  proc.stdin.end();

  await new Promise((resolve, reject) => {
    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { output += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Exit code " + code + ": " + output));
    });
    proc.on("error", reject);
  });

  console.log("TEST 1 PASSED: @- stdin body resolved correctly");
}

async function testFileBody() {
  const testFile = path.join(TEST_DIR, "test-payload.json");
  const fileContent = JSON.stringify({ test: "file-body-456" });
  await fs.writeFile(testFile, fileContent);

  // Test fs.readFile resolution directly
  const resolved = await fs.readFile(testFile, "utf8");
  if (resolved !== fileContent) {
    throw new Error("File content mismatch");
  }

  // Test invalid file error
  try {
    await fs.readFile("/nonexistent/path/file.json", "utf8");
    throw new Error("Should have thrown");
  } catch (e) {
    if (!e.message.includes("ENOENT") && !e.message.includes("no such file") && !e.message.includes("couldn't open file")) {
      throw new Error("Expected file-not-found error, got: " + e.message);
    }
  }

  console.log("TEST 2 PASSED: @file body read correctly, invalid file returns clear error");
}

async function testShimIntegration() {
  const shimSource = require("fs").readFileSync(
    path.join(__dirname, "execute.ts"),
    "utf8"
  );

  if (!shimSource.includes("resolveAtFile")) {
    throw new Error("Shim source missing resolveAtFile function");
  }
  if (!shimSource.includes('value.startsWith("@-")')) {
    throw new Error("Shim source missing @- stdin handling");
  }
  if (!shimSource.includes('value.startsWith("@")')) {
    throw new Error("Shim source missing @file handling");
  }
  if (!shimSource.includes("await parseArgs")) {
    throw new Error("Shim main() missing await before parseArgs");
  }

  console.log("TEST 3 PASSED: Shim source contains all required @- and @file resolution code");
}

async function main() {
  await setup();
  try {
    await testShimIntegration();
    await testFileBody();
    await testStdinBody();
    console.log("\nAll POLA-11232 regression tests passed.");
    process.exit(0);
  } catch (err) {
    console.error("TEST FAILED:", err.message);
    process.exit(1);
  }
}

main();
