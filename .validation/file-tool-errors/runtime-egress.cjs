"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");

function allowedHost(host) {
  const value = String(host ?? "localhost").toLowerCase();
  return (
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "[::1]" ||
    value === "::ffff:127.0.0.1"
  );
}
function socketTarget(args) {
  const first = args[0];
  if (Array.isArray(first)) return socketTarget(first);
  if (first && typeof first === "object") {
    if (first.path) return { allowed: false, reason: "ipc-socket" };
    if (first.lookup) return { allowed: false, reason: "custom-dns-lookup" };
    return { allowed: allowedHost(first.host), reason: "non-loopback-socket" };
  }
  if (
    typeof first === "number" ||
    (typeof first === "string" && /^\d+$/.test(first))
  ) {
    return {
      allowed: allowedHost(typeof args[1] === "string" ? args[1] : "localhost"),
      reason: "non-loopback-socket",
    };
  }
  return { allowed: false, reason: "unsupported-socket-target" };
}
function deny(reason) {
  const event = JSON.stringify({
    reason,
    pid: process.pid,
    time: new Date().toISOString(),
  });
  if (process.env.VALIDATION_EGRESS_LOG)
    fs.appendFileSync(process.env.VALIDATION_EGRESS_LOG, event + "\n");
  throw new Error(`Validation blocked outbound access: ${reason}`);
}
function listenerArgs(args) {
  const result = args.slice();
  const normalize = (host) => {
    if (
      host == null ||
      ["localhost", "0.0.0.0", "::", ""].includes(String(host).toLowerCase())
    )
      return "127.0.0.1";
    if (!allowedHost(host)) return null;
    return host === "[::1]" ? "::1" : host;
  };
  const first = result[0];
  if (first && typeof first === "object") {
    if (first.path || first.fd != null || first.port == null) return null;
    const host = normalize(first.host);
    if (!host) return null;
    result[0] = { ...first, host };
  } else if (
    typeof first === "number" ||
    (typeof first === "string" && /^\d+$/.test(first))
  ) {
    if (typeof result[1] === "string") {
      result[1] = normalize(result[1]);
      if (!result[1]) return null;
    } else result.splice(1, 0, "127.0.0.1");
  } else return null;
  return result;
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const narrowed = listenerArgs(args);
  if (!narrowed) return deny("non-loopback-listener");
  this.once("listening", () => {
    const address = this.address();
    if (
      !address ||
      typeof address === "string" ||
      !allowedHost(address.address)
    )
      return deny("unexpected-listening-address");
    if (process.env.VALIDATION_LISTENER_LOG)
      fs.appendFileSync(
        process.env.VALIDATION_LISTENER_LOG,
        JSON.stringify({
          address: address.address,
          port: address.port,
          family: address.family,
          pid: process.pid,
          stage: process.env.VALIDATION_STAGE || "unspecified",
        }) + "\n",
      );
  });
  return Reflect.apply(listen, this, narrowed);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = socketTarget(args);
  if (!target.allowed) return deny(target.reason);
  return Reflect.apply(connect, this, args);
};
const fetch = globalThis.fetch;
if (fetch) {
  globalThis.fetch = async function (input, ...args) {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return Reflect.apply(fetch, this, [input, ...args]);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !allowedHost(url.hostname)
    )
      return deny("non-loopback-fetch");
    return Reflect.apply(fetch, this, [input, ...args]);
  };
}
dgram.Socket.prototype.send = function () {
  return deny("udp-send");
};
module.exports = { allowedHost, socketTarget, listenerArgs };
