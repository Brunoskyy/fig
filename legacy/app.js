/*
 * Quayside API
 * Quotes and bookings for ocean freight.
 *
 * Originally written in 2014 for the agents portal, then extended for the
 * partner API (2015) and the mobile app (2016). Everything lives in this file
 * because the build server only deploys app.js and server.js (see ops wiki).
 *
 * Money is in dollars as floats. The rate card in the DB is in cents.
 * Yes, both. Do not "fix" the rounding without talking to finance first:
 * partners reconcile against the totals this returns.
 */

var express = require('express');
var fs = require('fs');
var path = require('path');

var VERSION = '1.9.3';

var CONTAINERS = ['20DV', '40DV', '40HC', '20RF'];
var MAX_WEIGHT = { '20DV': 28000, '40DV': 28000, '40HC': 28000, '20RF': 27000 };
var PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// tiny db helper (we used node-sqlite3 before 2016, kept the callback style)
// ---------------------------------------------------------------------------

function wrapDb(raw) {
  return {
    all: function (sql, params, cb) {
      setImmediate(function () {
        var rows;
        try {
          rows = raw.prepare(sql).all.apply(raw.prepare(sql), params || []);
        } catch (e) {
          return cb(e);
        }
        cb(null, rows);
      });
    },
    get: function (sql, params, cb) {
      setImmediate(function () {
        var row;
        try {
          var st = raw.prepare(sql);
          row = st.get.apply(st, params || []);
        } catch (e) {
          return cb(e);
        }
        cb(null, row);
      });
    },
    run: function (sql, params, cb) {
      setImmediate(function () {
        var info;
        try {
          var st = raw.prepare(sql);
          info = st.run.apply(st, params || []);
        } catch (e) {
          return cb(e);
        }
        cb(null, { lastID: Number(info.lastInsertRowid), changes: info.changes });
      });
    },
    exec: function (sql) {
      raw.exec(sql);
    }
  };
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

// QA asked for a way to freeze time in 2015. It stayed.
function now() {
  if (process.env.QUAYSIDE_NOW) return new Date(process.env.QUAYSIDE_NOW);
  return new Date();
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function ymd(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function stamp(d) {
  return ymd(d) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

function parseDay(s) {
  if (typeof s != 'string') return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

// ---------------------------------------------------------------------------
// pricing
// ---------------------------------------------------------------------------

function money(x) {
  return x.toFixed(2);
}

// The rate card only has one direction for most lanes. Ops decided in 2014
// that the way back costs a bit more because the boats come back emptier.
var REVERSE_LANE_FACTOR = 1.05;

function findLane(db, from, to, container, cb) {
  db.get('SELECT * FROM lanes WHERE origin = ? AND dest = ? AND container = ?', [from, to, container], function (err, lane) {
    if (err) return cb(err);
    if (lane) return cb(null, { base_cents: lane.base_cents, reversed: false });
    db.get('SELECT * FROM lanes WHERE origin = ? AND dest = ? AND container = ?', [to, from, container], function (err2, back) {
      if (err2) return cb(err2);
      if (back) return cb(null, { base_cents: back.base_cents, reversed: true });
      cb(null, null);
    });
  });
}

// Fuel is published monthly. If finance has not published the month yet we
// use the most recent one before it.
function fuelFor(db, month, cb) {
  db.get('SELECT pct FROM fuel WHERE month <= ? ORDER BY month DESC LIMIT 1', [month], function (err, row) {
    if (err) return cb(err);
    cb(null, row ? row.pct : 0);
  });
}

function isPeak(d) {
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  // peak season is Dec 1 to Jan 15 per the 2015 rate card
  if (m == 12 && day >= 1) return true;
  if (m == 1 && day < 15) return true;
  return false;
}

function isWeekend(d) {
  var dow = d.getUTCDay();
  return dow == 0 || dow == 6;
}

function price(lane, opts, fuelPct, customer) {
  var base = lane.base_cents / 100;
  if (lane.reversed) base = base * REVERSE_LANE_FACTOR;

  var weight = 0;
  if (opts.weight > 20000) {
    weight = Math.ceil((opts.weight - 20000) / 1000) * 150;
  }

  var hazardous = 0;
  if (opts.hazardous) {
    hazardous = base * 0.18;
    if (hazardous < 95) hazardous = 95;
  }

  var weekend = isWeekend(opts.departDate) ? 75 : 0;
  var peak = isPeak(opts.departDate) ? (base + weight) * 0.12 : 0;
  var fuel = base * fuelPct;

  var sub = base + weight + weekend + peak + fuel;
  var discount = 0;
  // gold discount does not apply to the hazardous surcharge (contract 2013-41)
  if (customer && customer.tier == 'gold') discount = sub * 0.07;

  var total = sub - discount + hazardous;
  // round up to the next 5 cents
  total = Math.ceil(total * 20) / 20;

  return {
    total: +total.toFixed(2),
    breakdown: {
      base: money(base),
      weight: money(weight),
      hazardous: money(hazardous),
      weekend: money(weekend),
      peak: money(peak),
      fuel: money(fuel),
      discount: money(discount)
    }
  };
}

function yes(v) {
  return v === true || v == 'Y' || v == 'y' || v == 1 || v == 'true';
}

function quoteJson(row) {
  return {
    id: row.id,
    customer: row.customer_id,
    from: row.origin,
    to: row.dest,
    container: row.container,
    weight: row.weight_kg,
    hazardous: row.hazardous == 1,
    depart: row.depart,
    total: row.total,
    currency: 'USD',
    breakdown: JSON.parse(row.breakdown),
    created: row.created_at,
    expires: row.expires_at
  };
}

function bookingJson(row) {
  return {
    id: row.id,
    quote: row.quote_id,
    customer: row.customer_id,
    status: row.status,
    created: row.created_at,
    cancelled: row.cancelled_at || null,
    fee: row.fee == null ? null : row.fee
  };
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function createApp(raw) {
  var db = wrapDb(raw);
  var app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));

  app.use(function (req, res, next) {
    if (process.env.QUAYSIDE_QUIET != '1') console.log('[' + stamp(now()) + '] ' + req.method + ' ' + req.url);
    next();
  });

  app.get('/ping', function (req, res) {
    res.type('text/plain').send('pong ' + VERSION);
  });

  // -------------------------------------------------------------------------
  // ports
  // -------------------------------------------------------------------------

  app.get('/api/v1/ports', function (req, res, next) {
    var sql = 'SELECT code, name, country, region FROM ports';
    var params = [];
    if (req.query.region) {
      sql += ' WHERE region = ?';
      params.push(String(req.query.region).toUpperCase());
    }
    sql += ' ORDER BY name';
    db.all(sql, params, function (err, rows) {
      if (err) return next(err);
      var body = { ok: true, count: rows.length, ports: rows };
      // the old agents portal still loads this with a script tag
      if (req.query.callback && /^[a-zA-Z_$][\w$]*$/.test(req.query.callback)) {
        res.type('application/javascript').send(req.query.callback + '(' + JSON.stringify(body) + ');');
        return;
      }
      res.json(body);
    });
  });

  // -------------------------------------------------------------------------
  // quotes
  // -------------------------------------------------------------------------

  function makeQuote(b, cb) {
    if (!b || typeof b != 'object') return cb({ status: 400, detail: 'body must be JSON' });
    if (!b.from) return cb({ status: 400, detail: 'from is required' });
    if (!b.to) return cb({ status: 400, detail: 'to is required' });
    if (!b.container) return cb({ status: 400, detail: 'container is required' });
    var container = String(b.container).toUpperCase();
    if (CONTAINERS.indexOf(container) == -1) return cb({ status: 400, detail: 'unknown container' });
    var departDate = parseDay(b.depart);
    if (!departDate) return cb({ status: 400, detail: 'depart must be YYYY-MM-DD' });

    // agents type "21500kg" in the portal; parseInt takes care of it
    var weight = parseInt(b.weight, 10);
    if (weight > MAX_WEIGHT[container]) return cb(null, { ok: false, err: 'OVERWEIGHT', max: MAX_WEIGHT[container] });

    var from = String(b.from).toUpperCase();
    var to = String(b.to).toUpperCase();
    var hazardous = yes(b.hazardous);

    function withCustomer(customer) {
      findLane(db, from, to, container, function (err, lane) {
        if (err) return cb(err);
        if (!lane) return cb(null, { ok: false, err: 'NO_LANE' });
        fuelFor(db, ymd(departDate).slice(0, 7), function (err2, pct) {
          if (err2) return cb(err2);
          var p = price(lane, { weight: weight, hazardous: hazardous, departDate: departDate }, pct, customer);
          var created = now();
          var expires = ymd(addDays(created, 7));
          db.run(
            'INSERT INTO quotes (customer_id, origin, dest, container, weight_kg, hazardous, depart, total, breakdown, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [customer ? customer.id : null, from, to, container, isNaN(weight) ? null : weight, hazardous ? 1 : 0, ymd(departDate), p.total, JSON.stringify(p.breakdown), stamp(created), expires],
            function (err3, info) {
              if (err3) return cb(err3);
              db.get('SELECT * FROM quotes WHERE id = ?', [info.lastID], function (err4, row) {
                if (err4) return cb(err4);
                cb(null, { ok: true, quote: quoteJson(row) });
              });
            }
          );
        });
      });
    }

    if (b.customer == null || b.customer === '') return withCustomer(null);
    db.get('SELECT * FROM customers WHERE id = ?', [parseInt(b.customer, 10)], function (err, customer) {
      if (err) return cb(err);
      if (!customer) return cb(null, { ok: false, err: 'NO_CUSTOMER' });
      withCustomer(customer);
    });
  }

  app.post('/api/v1/quote', function (req, res, next) {
    makeQuote(req.body, function (err, result) {
      if (err && err.status) return res.status(err.status).json({ error: 'bad request', detail: err.detail });
      if (err) return next(err);
      res.json(result);
    });
  });

  // v0, used by two partners that never migrated. Same pricing, older shape.
  app.post('/quote', function (req, res, next) {
    makeQuote(req.body, function (err, result) {
      if (err && err.status) return res.status(err.status).send('ERROR ' + err.detail);
      if (err) return next(err);
      if (!result.ok) return res.send('ERROR ' + result.err);
      res.send('OK ' + result.quote.id + ' ' + money(result.quote.total));
    });
  });

  app.get('/api/v1/quote/:id', function (req, res, next) {
    db.get('SELECT * FROM quotes WHERE id = ?', [parseInt(req.params.id, 10)], function (err, row) {
      if (err) return next(err);
      if (!row) return res.json({ ok: false, err: 'NOT_FOUND' });
      res.json({ ok: true, quote: quoteJson(row) });
    });
  });

  // -------------------------------------------------------------------------
  // bookings
  // -------------------------------------------------------------------------

  app.post('/api/v1/bookings', function (req, res, next) {
    var qid = parseInt(req.body && req.body.quote, 10);
    if (!qid) return res.status(400).json({ error: 'bad request', detail: 'quote is required' });
    db.get('SELECT * FROM quotes WHERE id = ?', [qid], function (err, q) {
      if (err) return next(err);
      if (!q) return res.json({ ok: false, err: 'NO_QUOTE' });
      if (ymd(now()) > q.expires_at) return res.json({ ok: false, err: 'EXPIRED' });
      db.get("SELECT id FROM bookings WHERE quote_id = ? AND status != 'CANCELLED'", [qid], function (err2, existing) {
        if (err2) return next(err2);
        if (existing) return res.json({ ok: false, err: 'ALREADY_BOOKED', booking: existing.id });
        db.run(
          "INSERT INTO bookings (quote_id, customer_id, status, created_at) VALUES (?, ?, 'CONFIRMED', ?)",
          [qid, q.customer_id, stamp(now())],
          function (err3, info) {
            if (err3) return next(err3);
            db.get('SELECT * FROM bookings WHERE id = ?', [info.lastID], function (err4, row) {
              if (err4) return next(err4);
              res.json({ ok: true, booking: bookingJson(row) });
            });
          }
        );
      });
    });
  });

  // NOTE: returns 200 for a missing booking, like every other lookup here.
  // The mobile app checks `ok`, not the status code.
  app.get('/api/v1/bookings/:id', function (req, res, next) {
    db.get('SELECT * FROM bookings WHERE id = ?', [parseInt(req.params.id, 10)], function (err, row) {
      if (err) return next(err);
      if (!row) return res.json({ ok: false, err: 'NOT_FOUND' });
      res.json({ ok: true, booking: bookingJson(row) });
    });
  });

  app.get('/api/v1/customers/:id/bookings', function (req, res, next) {
    // page starts at 0 (the portal's pager was zero based)
    var page = parseInt(req.query.page, 10) || 0;
    db.all(
      'SELECT * FROM bookings WHERE customer_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      [parseInt(req.params.id, 10), PAGE_SIZE, page * PAGE_SIZE],
      function (err, rows) {
        if (err) return next(err);
        res.json({ ok: true, page: page, bookings: rows.map(bookingJson) });
      }
    );
  });

  // Cancellation fees, from the 2016 terms:
  //   more than 14 days before departure: free
  //   7 to 14 days: 25% of the quote
  //   less than 7 days: 60%
  //   after departure: not allowed
  app.post('/api/v1/bookings/:id/cancel', function (req, res, next) {
    var id = parseInt(req.params.id, 10);
    db.get('SELECT b.*, q.depart, q.total FROM bookings b JOIN quotes q ON q.id = b.quote_id WHERE b.id = ?', [id], function (err, row) {
      if (err) return next(err);
      if (!row) return res.json({ ok: false, err: 'NOT_FOUND' });
      if (row.status == 'CANCELLED') return res.json({ ok: false, err: 'ALREADY_CANCELLED' });
      var today = parseDay(ymd(now()));
      var days = Math.floor((parseDay(row.depart).getTime() - today.getTime()) / 86400000);
      if (days < 0) return res.json({ ok: false, err: 'DEPARTED' });
      var fee = 0;
      if (days > 14) fee = 0;
      else if (days >= 7) fee = row.total * 0.25;
      else fee = row.total * 0.6;
      fee = +fee.toFixed(2);
      db.run("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, fee = ? WHERE id = ?", [stamp(now()), fee, id], function (err2) {
        if (err2) return next(err2);
        db.get('SELECT * FROM bookings WHERE id = ?', [id], function (err3, b) {
          if (err3) return next(err3);
          res.json({ ok: true, booking: bookingJson(b) });
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // admin (behind the office VPN, no auth here)
  // -------------------------------------------------------------------------

  app.get('/admin/fuel', function (req, res, next) {
    db.all('SELECT * FROM fuel ORDER BY month', [], function (err, rows) {
      if (err) return next(err);
      res.json(rows);
    });
  });

  app.post('/admin/fuel', function (req, res, next) {
    var b = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(b.month || '') || typeof b.pct != 'number') {
      return res.status(400).json({ error: 'bad request', detail: 'month YYYY-MM and pct number' });
    }
    db.run('INSERT OR REPLACE INTO fuel (month, pct) VALUES (?, ?)', [b.month, b.pct], function (err) {
      if (err) return next(err);
      res.json({ ok: true });
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    console.error('[' + stamp(now()) + '] ERROR ' + (err && err.stack ? err.stack : err));
    if (err && err.type == 'entity.parse.failed') return res.status(400).json({ error: 'bad request', detail: 'invalid JSON' });
    res.status(500).send('Internal Server Error');
  });

  return app;
}

function migrate(raw, opts) {
  var dir = path.join(__dirname, 'db');
  raw.exec(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  var count = raw.prepare('SELECT COUNT(*) AS n FROM ports').get().n;
  if (count == 0 && !(opts && opts.noSeed)) raw.exec(fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8'));
}

module.exports = { createApp: createApp, migrate: migrate, price: price, isPeak: isPeak, VERSION: VERSION };
