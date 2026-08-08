import type { AddressInfo, Server } from "node:net";
import supertest from "supertest";

//
//
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
