/*!
 * node.js - Health checker node.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const EventEmitter = require('events');
const Config = require('bcfg');
const Logger = require('blgr');
const Network = require('hsd').Network;
const DNSHealthChecker = require('./dnscheck');
const NodesHealthChecker = require('./nodescheck');

class HealthCheckerNode extends EventEmitter {
  constructor(options) {
    super();

    this.config = new Config('nethealth', {
      suffix: 'network',
      fallback: 'main',
      alias: {
        'n': 'network'
      }
    });

    this.config.inject(options);
    this.config.load(options);

    this.config.open('nethealth.conf');

    if (this.config.has('config'))
      this.config.open(this.config.path('config'));

    this.logger = new Logger();

    if (this.config.has('logger'))
      this.logger = this.config.obj('logger');

    this.logger.set({
      filename: this.config.bool('log-file'),
      level: this.config.str('log-level'),
      console: this.config.bool('log-console'),
      shrink: this.config.bool('log-shrink'),
      maxFileSize: this.config.mb('log-max-file-size'),
      maxFiles: this.config.uint('log-max-files')
    });

    this.network = Network.get(this.config.str('network'));

    this.dns = new DNSHealthChecker({
      network: this.network.type,
      logger: this.logger,

      dnsEnabled: this.config.bool('dns-check'),
      dnsSeeds: this.config.array('dns-seeds'),
      dnsCheckInterval: this.config.uint('dns-check-interval', 1000),
      dnsCheckFrequency: this.config.uint('dns-check-frequency',
        10 * 60 * 1000)
    });

    this.node = new NodesHealthChecker({
      network: this.network.type,
      logger: this.logger,

      // Node health check.
      nodesEnabled: this.config.bool('nodes-check', true),
      nodes: this.config.array('nodes'),
      nodesDiscoverNew: this.config.bool('nodes-discover-new', false),
      nodesCheckParallel: this.config.uint('nodes-parallel', 20),
      nodesCheckInterval: this.config.uint('nodes-check-interval', 500),
      nodesCheckFrequency: this.config.uint('nodes-check-frequency',
        5 * 60 * 1000),
      nodesCheckPrune: this.config.bool('nodes-check-prune', true),
      nodesCheckCompact: this.config.bool('nodes-check-compact', true)
    });

    this.init();
  }

  init() {
    this.dns.on('error', (error) => {
      this.error(error);
    });

    this.dns.on('dns-success', (info) => {
      this.logger.debug('DNS check succeeded for %s.', info.hostname);
      this.emit('dns-success', info);
    });

    this.dns.on('dns-fail', (info) => {
      this.logger.debug('DNS check failed for %s.', info.hostname);
      this.emit('dns-fail', info);
    });

    this.node.on('error', (error) => {
      this.error(error);
    });

    this.node.on('node-success', (info) => {
      this.logger.debug('Node check succeeded for %s.', info.hostname);
      this.emit('node-success', info);
    });

    this.node.on('node-fail', (info) => {
      this.logger.debug('Node check failed for %s.', info.hostname);
      this.emit('node-fail', info);
    });
  }

  error(err) {
    this.logger.error(err);
    this.emit('error', err);
  }

  async open() {
    await this.logger.open();
    await this.dns.open();
    await this.node.open();

    this.emit('open');
  }

  async close() {
    await this.dns.close();
    await this.node.close();
    await this.logger.close();

    this.emit('close');
  }
}

module.exports = HealthCheckerNode;
