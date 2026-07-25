import type { AddressInfo, Server } from "node:net";
import supertest from "supertest";

// INVARIANT: a test server must be bound to the exact address supertest dials.
//
// supertest gives every request its own throwaway server via `app.listen(0)` — the
// IPv6 WILDCARD, dual-stack — and then hand-builds the URL as 127.0.0.1:<port>.
// The kernel will hand a wildcard bind an ephemeral port that another process
// already holds a 127.0.0.1-SPECIFIC listener on (ssh -L forwards, editor helpers,
// dev servers), and loopback IPv4 is routed to the most specific socket — so that
// process answers the test instead: a foreign 404, an ECONNRESET, or a hang, in
// whichever file happened to draw the port. Binding loopback removes the ambiguity;
// the kernel will not hand out a port already listening on 127.0.0.1.
//
// The bind has to move into end() because listen(port, host) resolves the host
// through dns.lookup, so address() is not readable in the same tick.
const Test = (supertest as unknown as { Test: SupertestTest }).Test;

interface SupertestTest {
  prototype: {
    end(fn?: (err: unknown, res?: unknown) => void): unknown;
    serverAddress(app: Server, path: string): string;
    _server?: Server;
    _deferredListen?: { app: Server; path: string };
  };
}

const originalEnd = Test.prototype.end;

Test.prototype.serverAddress = function (app: Server, path: string) {
  const addr = app.address() as AddressInfo | null;
  if (addr) return `http://127.0.0.1:${addr.port}${path}`;
  this._deferredListen = { app, path };
  return `http://127.0.0.1:0${path}`;
};

Test.prototype.end = function (fn?: (err: unknown, res?: unknown) => void) {
  const deferred = this._deferredListen;
  if (!deferred) return originalEnd.call(this, fn);
  this._deferredListen = undefined;
  const { app, path } = deferred;
  this._server = app;
  app.once("error", (err: Error) => {
    if (!fn) throw err;
    fn(err);
  });
  app.listen(0, "127.0.0.1", () => {
    this.url = `http://127.0.0.1:${(app.address() as AddressInfo).port}${path}`;
    originalEnd.call(this, fn);
  });
  return this;
};
