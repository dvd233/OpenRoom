import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  verifyBinding,
  checkUnitReport,
  checkRuntimeReport,
  checkBrowserReport,
  checkCoverage,
  browserConfigText,
  verifyCheckout,
  blobSha,
  sha256,
  expectedUnit,
} from "./validate.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const clone = (value) => structuredClone(value);

const binding = {
  repository: "dvd233/OpenRoom",
  repository_id: "1407883783",
  feature_sha: "165b3d1b0c91293fc2ab776d6bd18497f1dae063",
  validation_branch: "validation/openroom-file-tool-errors",
};
const env = {
  GITHUB_REPOSITORY: binding.repository,
  GITHUB_REPOSITORY_ID: binding.repository_id,
  GITHUB_REF_NAME: binding.validation_branch,
  GITHUB_EVENT_NAME: "push",
};
test("binding accepts only the exact fork, branch and fixed SHA", () => {
  verifyBinding(binding, env);
  for (const key of [
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REF_NAME",
    "GITHUB_EVENT_NAME",
  ])
    assert.throws(() => verifyBinding(binding, { ...env, [key]: "other" }));
  assert.throws(() =>
    verifyBinding({ ...binding, feature_sha: "__UNBOUND__" }, env),
  );
  assert.throws(() =>
    verifyBinding({ ...binding, repository_id: "__UNBOUND__" }, env),
  );
});

function unitReport(baseline) {
  const counts = baseline
    ? { "diskStorage.test.ts": 33, "fileTools.test.ts": 27 }
    : {
        "chatHistoryStorage.test.ts": 9,
        "configPersistence.test.ts": 10,
        "diskStorage.test.ts": 33,
        "fileTools.test.ts": 27,
        "imageGenClient.test.ts": 11,
        "llmClient.test.ts": 47,
        "logPlugin.test.ts": 15,
        "logger.test.ts": 13,
        "vibeContainerMock.test.ts": 6,
      };
  const testResults = Object.entries(counts).map(([file, count]) => {
    const failed = baseline
      ? expectedUnit.expectedFailed
          .filter((entry) => entry.file === file)
          .map((entry) => ({
            ...entry,
            status: "failed",
            failureMessages: [
              entry.file === "fileTools.test.ts"
                ? "expected 'success' to be 'error: Error: failure'"
                : /batch rejects/.test(entry.fullName)
                  ? "expected { kind: 'pending' } to deeply equal { kind: 'error' }"
                  : 'promise resolved "undefined" instead of rejecting',
            ],
          }))
      : [];
    const passed = Array.from(
      { length: count - failed.length },
      (_, index) => ({
        fullName: `passing ${index}`,
        status: "passed",
        failureMessages: [],
      }),
    );
    return {
      name: `/tmp/${file}`,
      status: failed.length ? "failed" : "passed",
      message: "",
      assertionResults: [...failed, ...passed],
    };
  });
  return {
    success: !baseline,
    numTotalTests: baseline ? 60 : 171,
    numPassedTests: baseline ? 42 : 171,
    numFailedTests: baseline ? 18 : 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults,
  };
}
test("native unit report accepts real expected outcome shapes", () => {
  assert.equal(checkUnitReport(unitReport(false), false).passed, 171);
  assert.equal(checkUnitReport(unitReport(true), true).failed, 18);
});
test("negative unit guard rejects wrong names, retries, setup errors and missing controls", () => {
  for (const mutate of [
    (r) => {
      r.testResults[0].assertionResults[0].fullName = "unrelated failure";
    },
    (r) => {
      r.testResults[0].assertionResults[0].failureMessages = [
        "Test timed out in 5000ms.",
      ];
    },
    (r) => {
      r.testResults[0].assertionResults[0].failureMessages = [
        "Failed to resolve package",
      ];
    },
    (r) => {
      r.testResults.pop();
    },
    (r) => {
      r.numPendingTests = 1;
    },
    (r) => {
      r.numRuntimeErrorTestSuites = 1;
    },
    (r) => {
      r.success = true;
    },
    (r) => {
      r.testResults.push({
        name: "/tmp/failed-setup.test.ts",
        status: "failed",
        message: "Failed to resolve setup dependency",
        assertionResults: [],
      });
      r.numFailedTestSuites = 1;
    },
    (r) => {
      r.testResults[0].message = "beforeAll hook failed";
    },
  ]) {
    const report = unitReport(true);
    mutate(report);
    assert.throws(() => checkUnitReport(report, true));
  }
  const passing = unitReport(false);
  passing.testResults[0].assertionResults[0].status = "skipped";
  assert.throws(() => checkUnitReport(passing, false));
});

function browserReport(baseline) {
  const specs = [];
  for (const tool of ["file_write", "file_delete"])
    for (const outcome of [
      "http-500",
      "network-error",
      "http-200",
      "http-204",
    ]) {
      const failed =
        baseline && ["http-500", "network-error"].includes(outcome);
      specs.push({
        title: `${tool} forwards ${outcome} to the next model request`,
        file: "file-tool-errors.spec.ts",
        tests: [
          {
            projectName: "chromium",
            expectedStatus: "passed",
            status: failed ? "unexpected" : "expected",
            results: [
              {
                retry: 0,
                status: failed ? "failed" : "passed",
                errors: failed
                  ? [
                      {
                        message:
                          'Error: expect(received).toBe(expected)\nReceived: "success"',
                      },
                    ]
                  : [],
                ...(failed
                  ? {
                      error: {
                        message:
                          'Error: expect(received).toBe(expected)\nExpected: "error: failure"\nReceived: "success"',
                      },
                    }
                  : {}),
              },
            ],
          },
        ],
      });
    }
  return {
    errors: [],
    suites: [{ title: "file", specs }],
    stats: {
      expected: baseline ? 4 : 8,
      unexpected: baseline ? 4 : 0,
      skipped: 0,
      flaky: 0,
    },
  };
}
test("Playwright JSON reporter outcome shapes are accepted", () => {
  assert.equal(checkBrowserReport(browserReport(false), false).passed, 8);
  assert.equal(checkBrowserReport(browserReport(true), true).failed, 4);
});
test("browser report guard rejects setup failure, retry, wrong inventory and expected-failure annotations", () => {
  for (const mutate of [
    (r) => {
      r.errors.push({ message: "browser launch failed" });
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].status = "timedOut";
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results.push(
        clone(r.suites[0].specs[0].tests[0].results[0]),
      );
    },
    (r) => {
      r.suites[0].specs[0].tests[0].expectedStatus = "failed";
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].error.message =
        "browser executable missing";
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].error.message =
        'expect().toBe()\nReceived: "something else"';
    },
    (r) => {
      r.suites[0].specs.pop();
    },
    (r) => {
      r.stats.flaky = 1;
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].errors.push({
        message: "teardown failure",
      });
    },
  ]) {
    const report = browserReport(true);
    mutate(report);
    assert.throws(() => checkBrowserReport(report, true));
  }
});

test("coverage requires both actual files, every metric and strict greater-than90", () => {
  const metric = { total: 10, covered: 10, pct: 100 };
  const metrics = {
    lines: metric,
    branches: metric,
    functions: metric,
    statements: metric,
  };
  const report = {
    "/repo/src/lib/diskStorage.ts": metrics,
    "/repo/src/lib/fileTools.ts": metrics,
  };
  checkCoverage(report);
  assert.throws(() =>
    checkCoverage({ "/repo/src/lib/diskStorage.ts": metrics }),
  );
  assert.throws(() =>
    checkCoverage({
      ...report,
      "/repo/src/lib/fileTools.ts": {
        ...metrics,
        lines: { total: 10, covered: 9, pct: 90 },
      },
    }),
  );
  assert.throws(() =>
    checkCoverage({
      ...report,
      "/repo/src/lib/fileTools.ts": {
        ...metrics,
        branches: { total: 0, pct: 100 },
      },
    }),
  );
});

test("browser wrapper inherits source config and enables Chromium sandbox", () => {
  const text = browserConfigText(
    "/tmp/synthetic/repo",
    "/tmp/output",
    "/tmp/report.json",
  );
  assert(text.includes("chromiumSandbox: true"));
  assert(text.includes("...upstream"));
  assert(text.includes("/tmp/synthetic/repo/playwright.config.ts"));
  assert(text.includes("reuseExistingServer: false"));
  assert(text.includes("--host 127.0.0.1 --port 3000 --strictPort"));
  assert(text.includes("baseURL: 'http://127.0.0.1:3000'"));
  assert(text.includes("testMatch: 'file-tool-errors.spec.ts'"));
});

test("egress guard checks all overloads and denies outbound before any network call", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openroom-egress-selftest-"),
  );
  try {
    const log = path.join(dir, "blocked.jsonl");
    const script = `
      const assert = require('node:assert/strict');
      const net = require('node:net');
      let connects = 0, fetches = 0;
      net.Server.prototype.listen = function(...args) { return args; };
      net.Socket.prototype.connect = function(...args) { connects++; return args; };
      globalThis.fetch = async () => { fetches++; return { synthetic: true }; };
      const guard = require(${JSON.stringify(path.join(here, "runtime-egress.cjs"))});
      for (const host of ['localhost','127.0.0.1','::1','[::1]','::ffff:127.0.0.1']) assert(guard.allowedHost(host));
      for (const host of ['api.example.invalid','127.0.0.1.example.invalid','192.0.2.1','0.0.0.0']) assert(!guard.allowedHost(host));
      assert(guard.socketTarget([3000,'localhost']).allowed);
      assert(guard.socketTarget([{host:'::1',port:3000}]).allowed);
      assert(!guard.socketTarget([{path:'/tmp/sock'}]).allowed);
      assert(!guard.socketTarget([{host:'localhost',lookup:()=>{}}]).allowed);
      assert.deepEqual(guard.listenerArgs([3000]),[3000,'127.0.0.1']);
      assert.deepEqual(guard.listenerArgs([{port:3000,host:'0.0.0.0'}]),[{port:3000,host:'127.0.0.1'}]);
      assert.equal(guard.listenerArgs([{path:'/tmp/socket'}]),null);
      assert.equal(guard.listenerArgs([3000,'192.0.2.1']),null);
      const server = new net.Server();
      server.address = () => ({address:'127.0.0.1',port:3000,family:'IPv4'});
      assert.deepEqual(server.listen(3000),[3000,'127.0.0.1']);
      server.emit('listening');
      const socket = new net.Socket();
      assert.throws(()=>socket.connect({host:'api.example.invalid',port:443}),/blocked outbound/);
      assert.equal(connects,0);
      socket.connect({host:'127.0.0.1',port:3000});
      assert.equal(connects,1);
      (async()=>{
        await assert.rejects(fetch('https://api.example.invalid/test'),/blocked outbound/);
        assert.equal(fetches,0);
        await fetch('http://localhost:3000/');
        assert.equal(fetches,1);
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        VALIDATION_EGRESS_LOG: log,
        VALIDATION_LISTENER_LOG: path.join(dir, "listeners.jsonl"),
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const records = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(records.length, 2);
    const listeners = fs
      .readFileSync(path.join(dir, "listeners.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(listeners[0].address, "127.0.0.1");
    assert(
      records.every(
        (entry) => !JSON.stringify(entry).includes("example.invalid"),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source guard rejects a dirty file and wrong tree with a real temporary Git repo", () => {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), "openroom-source-selftest-"),
  );
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "-C",
        repo,
        ...args,
      ],
      { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    git("init", "--quiet", "--template=");
    fs.writeFileSync(path.join(repo, "source.txt"), "original\n");
    git("add", "source.txt");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const baseTree = git("rev-parse", "HEAD^{tree}");
    fs.writeFileSync(path.join(repo, "source.txt"), "candidate\n");
    git("add", "source.txt");
    git("commit", "-qm", "candidate");
    const bytes = fs.readFileSync(path.join(repo, "source.txt"));
    const m = {
      base_head: base,
      base_tree: baseTree,
      binding: { feature_sha: git("rev-parse", "HEAD") },
      candidate_tree: git("rev-parse", "HEAD^{tree}"),
      changed_files: [
        {
          path: "source.txt",
          git_blob_sha: blobSha(bytes),
          sha256: sha256(bytes),
        },
      ],
    };
    verifyCheckout(repo, false, m);
    assert.throws(() =>
      verifyCheckout(repo, false, { ...m, candidate_tree: "0".repeat(40) }),
    );
    fs.appendFileSync(path.join(repo, "source.txt"), "dirty\n");
    assert.throws(() => verifyCheckout(repo, false, m));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("companion runtime evidence rejects unhandled errors, setup failures and missing finish", () => {
  const baseline = {
    finished: true,
    unhandledErrorCount: 0,
    unhandledErrorKinds: [],
    suiteErrors: [],
    testCount: 60,
    files: ["diskStorage.test.ts", "fileTools.test.ts"],
  };
  checkRuntimeReport(baseline, true);
  for (const patch of [
    { finished: false },
    { unhandledErrorCount: 1, unhandledErrorKinds: ["Error"] },
    { suiteErrors: [{ name: "setup", count: 1 }] },
    { testCount: 59 },
    { files: ["diskStorage.test.ts"] },
  ])
    assert.throws(() => checkRuntimeReport({ ...baseline, ...patch }, true));
});

test("baseline verification rehashes copied regression tests after preparation", () => {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), "openroom-copied-test-selftest-"),
  );
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "-C",
        repo,
        ...args,
      ],
      { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    git("init", "--quiet", "--template=");
    fs.writeFileSync(path.join(repo, "source.txt"), "original\n");
    git("add", "source.txt");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD"),
      baseTree = git("rev-parse", "HEAD^{tree}");
    const original = fs.readFileSync(path.join(repo, "source.txt"));
    fs.writeFileSync(path.join(repo, "source.txt"), "candidate\n");
    fs.writeFileSync(
      path.join(repo, "regression.test.ts"),
      "synthetic regression\n",
    );
    git("add", ".");
    git("commit", "-qm", "candidate");
    const bytes = fs.readFileSync(path.join(repo, "source.txt")),
      testBytes = fs.readFileSync(path.join(repo, "regression.test.ts"));
    const m = {
      base_head: base,
      base_tree: baseTree,
      binding: { feature_sha: git("rev-parse", "HEAD") },
      candidate_tree: git("rev-parse", "HEAD^{tree}"),
      changed_files: [
        {
          path: "source.txt",
          git_blob_sha: blobSha(bytes),
          sha256: sha256(bytes),
          base_blob_sha: blobSha(original),
        },
        {
          path: "regression.test.ts",
          git_blob_sha: blobSha(testBytes),
          sha256: sha256(testBytes),
          base_blob_sha: null,
        },
      ],
    };
    verifyCheckout(repo, false, m);
    git("checkout", "--quiet", base);
    verifyCheckout(repo, true, m, false);
    assert.throws(() => verifyCheckout(repo, true, m));
    fs.writeFileSync(path.join(repo, "regression.test.ts"), testBytes);
    verifyCheckout(repo, true, m);
    fs.appendFileSync(
      path.join(repo, "regression.test.ts"),
      "unexpected edit\n",
    );
    assert.throws(() => verifyCheckout(repo, true, m));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
