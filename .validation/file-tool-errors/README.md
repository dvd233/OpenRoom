# Source-bound file-tool validation

This harness belongs on `validation/openroom-file-tool-errors` in `dvd233/OpenRoom` (repository ID1407883783). Its Git tree contains only the eight validation payload files, with no inherited source or original workflows. The validation commit may have the feature commit as its sole parent, but its tree must be created without a base tree. Source is always checked out separately into candidate/ and baseline/. This harness must not be included in an upstream PR.

Fixed feature: `165b3d1b0c91293fc2ab776d6bd18497f1dae063`, tree `7b9fd5b0e36392186d7bde37535f1acf9fedfbc9`, sole parent `02468154c4d99f8925916425bf444d672454fb3d`. Fixed base tree: `d3e1eec601b5a9e87c91cfed87b06bf3d1a97f5b`.

## What runs

The workflow uses Ubuntu24.04, Node20.20.2, pnpm9.0.0 and the original frozen dependency lock with lifecycle scripts disabled. It does not install a browser. It checks the runner’s preinstalled google-chrome-stable package, original /opt/google/chrome/chrome executable and /etc/apparmor.d/chrome profile using read-only operations. Missing or inconsistent package/path/ownership/permission/profile/version evidence stops the run without repair. If any native dependency needs a build script, setup must fail and be reviewed; arbitrary lifecycle scripts are not enabled.

It runs the native package's full tests and coverage scripts without the local screening HMR-disable config, then native lint/build. Native lint includes --fix; exact tracked-source guards run afterward and reject rewrites. The candidate must produce171 passing tests and per-file lines/branches/functions/statements coverage strictly greater than90%.

The same two regression test files are copied to an unchanged base checkout. The base must produce18 specific assertion failures and42 passing controls; a failed process alone is insufficient. Exact file inventory, native JSON suite errors, and a companion native Vitest reporter reject setup/hook failures and global unhandled errors. Vitest1.6.1's JSON reporter does not include global unhandled errors, so the companion is mandatory.

The eight new browser tests drive the real ChatPanel and inspect the next intercepted model request. Candidate must pass8/8; unchanged base must fail the four error cases and pass the four HTTP200/204 controls. The parser checks the exact names, only one attempt, expected status, assertion text showing the original success result, and absence of secondary teardown/global errors. It recognizes both Playwright's `Received:` and `Received string:` assertion forms.

All stages journal RUNNING/EXECUTED/PASS and preserve their exit codes. There is no continue-on-error. The final stage rejects incomplete or mixed-commit results, requires actual loopback listener evidence, and verifies source and copied test hashes again.

## Runtime deltas and boundaries

- Native unit scripts and config remain unchanged. A Node preload rejects non-loopback outbound connections/fetch and UDP. It narrows unspecified/wildcard Node listener hosts to127.0.0.1 and records actual listening addresses. HMR stays enabled.
- Browser config inherits the repository's Playwright config but selects the existing Google Chrome channel instead of bundled Chromium headless-shell. Frozen Playwright1.58.2 compatibility with the installed Chrome version remains an actual runtime check, not an equivalence claim. The wrapper explicitly enables Chromium sandbox, uses the existing dev script with `--host 127.0.0.1 --port 3000 --strictPort`, sets matching base/readiness URLs, selects only the new test file, and writes isolated reports. It does not change the five feature files.
- No operating-system security/network settings are changed. No browser sandbox-disabling flag is used. If the hosted runner cannot launch the sandboxed browser, validation fails rather than weakening it.
- The real new tests intercept all app APIs with synthetic fixtures and block off-origin HTTP resources. Unknown APIs fail closed. Node/browser guards are not an OS-wide network boundary; browser background networking and hosted setup are not covered by page.route.
- Existing `e2e/app.spec.ts` is not included in the fixture-isolation or eight-test success claim.
- Runtime HOME and browser working data are under separate temporary directories, outside the artifact directory. No user caches or ~/.openroom data are adopted. Artifacts contain only explicit logs/reports and public source hashes; no environment dumps or credentials.

## Self-tests and what they establish

Run `node --test .validation/file-tool-errors/validate.test.mjs`. The tests include wrong bindings, dirty source, copied-test tampering, extra setup suites, global runtime errors, browser retries/teardown errors, coverage boundary cases, and pure socket/listener argument checks. Their network functions are stubbed before exercising the guard, so these tests open no sockets or listeners.

Preparation also validated the parsers against actual source-bound Vitest JSON/coverage and native companion reports. A deliberately unhandled Vitest fixture confirmed JSON can say success while the companion records the error and forces exit1. A separate native Playwright reporter-only fixture verified actual assertion serialization without launching a browser or server. Playwright --list loaded the generated wrapper and collected the eight real tests under a socket-denial guard. These are harness checks, not browser acceptance or a hosted CI pass.

V3 established source-bound native tests/coverage/lint/build and unit negative controls. Its eight browser cases failed at sandbox launch before page execution, and baseline browser controls did not run. This revision still requires actual Chrome launch and both browser gates. Package checksums establish consistency with the installed package database, not independent vendor signature verification. Profile-file existence is not proof of loaded policy or a full sandbox audit; loaded state is recorded only if already readable, without sudo or policy changes. Baseline package-entry resolution and Vitest version are checked after linking the candidate's installed workspace node_modules.
