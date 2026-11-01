// The `auth_request` target of the fixture's frontend, for deploy-rolling.test.sh: production's
// frontend asks core-service whether every API request may pass BEFORE it chooses the replica the
// request goes to, and that subrequest is an upstream connection of its own. The pairing check in
// infrastructure/lib/rolling.sh must not count it as a request that has chosen (2026-11-01 review),
// so the test needs a request that sits in that phase on demand: one whose URI says `hold-auth` is
// held here until `/release`. A pinned service of its own, never replaced, so the subrequest's
// connection never lands on the replica being retired.
import http from 'node:http';

const held = [];
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.end('ok');
      return;
    }
    // How many subrequests are held: the test starts the deploy only once its request is one.
    if (req.url === '/held') {
      res.end(String(held.length));
      return;
    }
    if (req.url === '/release') {
      const n = held.length;
      while (held.length) held.shift().end();
      res.end(String(n));
      return;
    }
    res.statusCode = 204;
    if (String(req.headers['x-original-uri'] ?? '').includes('hold-auth')) {
      held.push(res);
      return;
    }
    res.end();
  })
  .listen(3001, () => console.log('auth listening'));
