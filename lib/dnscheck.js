/*!
 * dnspool.js - DNS Health checks for seeds.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const dns = require('dns');
const Logger = require('blgr');
const List = require('blst');
const {Network} = require('hsd');

class DNSHealthChecker extends EventEmitter {
  constructor(options) {
    super();

    this.options = new DNSHealthCheckerOptions(options);
    this.logger = this.options.logger.context('dns') || Logger.global;
    this.queue = new List();
  }

  /**
   * Start the pool.
   * @returns {Promise}
   */

  async open() {
    if (!this.options.dnsEnabled)
      return;

    const dnsSeeds = new Set(this.options.dnsSeeds);
    for (const seed of dnsSeeds)
      this.scheduleCheck(seed, 0);

    this.startLoop();
  }

  /**
   * Stop the pool.
   * @returns {Promise}
   */

  async close() {
    this.stopLoop();
  }

  /**
   * Start DNS seed checks.
   */

  startLoop() {
    this.loop = setInterval(() => {
      if (this.queue.size === 0)
        return;

      let item = this.queue.shift();

      while (item) {
        this.checkSeed(item.value);
        item = this.queue.shift();
      }
    }, this.options.dnsCheckInterval);
  }

  /**
   * Stop DNS seed checks.
   */

  stopLoop() {
    if (this.loop)
      clearInterval(this.loop);

    this.queue.reset();
    this.loop = null;
  }

  /**
   * Check DNS seed health.
   * @param {String} hostname
   * @returns {Promise}
   */

  checkSeed(hostname) {
    const time = Date.now();

    this.logger.spam('Checking hostname "%s". ', hostname);

    // Could potentially grab all ips and add them to the list.
    // Currently only checks the DNS server itself.
    dns.lookup(hostname, (err, ip) => {
      const info = {
        time: time,
        hostname: hostname,
        ip: ip,
        error: err,
        frequency: this.options.dnsCheckFrequency,
        interval: this.options.dnsCheckInterval
      };

      this.scheduleCheck(hostname);

      if (err) {
        this.emit('dns-fail', info);
        return;
      }

      this.emit('dns-success', info);
    });
  }

  scheduleCheck(seed, time = this.options.dnsCheckFrequency) {
    this.logger.spam('Scheduling DNS check for "%s".', seed, time);

    setTimeout(() => {
      this.logger.spam('Adding DNS check for "%s".', seed);
      this.queue.push(new DNSListItem(seed));
    }, time);
  }
}

class DNSHealthCheckerOptions {
  constructor(options) {
    this.network = Network.primary;

    // DNS seed health checks
    this.dnsEnabled = true;
    // 10 minutes
    this.dnsCheckFrequency = 10 * 60 * 1000;
    this.dnsCheckInterval = 1000;
    this.dnsSeeds = Network.primary.seeds;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    assert(typeof options === 'object');

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.network != null) {
      assert(typeof options.network === 'string');
      this.network = Network.get(options.network);
    }

    if (options.dnsEnabled != null) {
      assert(typeof options.dnsEnabled === 'boolean');
      this.dnsEnabled = options.dnsEnabled;
    }

    if (options.dnsCheckFrequency != null) {
      assert(typeof options.dnsCheckFrequency === 'number');
      assert(options.dnsCheckFrequency >= 0);
      this.dnsCheckFrequency = options.dnsCheckFrequency;
    }

    if (options.dnsCheckInterval != null) {
      assert(typeof options.dnsCheckInterval === 'number');
      assert(options.dnsCheckInterval >= 0);
      this.dnsCheckInterval = options.dnsCheckInterval;
    }

    if (options.dnsSeeds != null) {
      assert(Array.isArray(options.dnsSeeds));
      this.dnsSeeds = options.dnsSeeds;
    }

    return this;
  }
}

class DNSListItem extends List.ListItem {
  constructor(hostname) {
    super(hostname);
  }
}

module.exports = DNSHealthChecker;
